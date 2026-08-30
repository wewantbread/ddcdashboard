import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../../plugins/hooks.test-helpers.js";
import { createWorkerSessionToolExecutor } from "./worker-session-tool-executor.js";

const fixture = vi.hoisted(() => {
  const state = { active: true };
  const claim = {
    claimId: "source-claim",
    runId: "source-run",
    sessionId: "source-session",
    owner: { kind: "worker", environmentId: "source-environment", ownerEpoch: 1 },
  };
  const assertActive = () => {
    if (!state.active) {
      throw new Error("Session source-session worker turn authority changed");
    }
  };
  return {
    claim,
    state,
    run: vi.fn(async (callback: (identity: object) => Promise<unknown>) => {
      assertActive();
      const result = await callback({
        agentId: "main",
        sessionKey: "agent:main:dashboard:source",
        operationalRunInstance: { instanceId: "source-instance", runId: claim.runId },
        delegatedAuthority: { claimId: "delegated-claim" },
        receiptAuthority: assertActive,
        turnClaim: claim,
      });
      assertActive();
      return result;
    }),
  };
});
const source = {
  agentId: "main",
  sessionId: fixture.claim.sessionId,
  sessionKey: "agent:main:dashboard:source",
  turnClaim: fixture.claim,
  entry: {},
};
const target = {
  agentId: "main",
  sessionId: "target-session",
  sessionKey: "agent:main:dashboard:target",
};
const gatewayDispatch = vi.hoisted(() => vi.fn());
const gatewayCreate = vi.hoisted(() => vi.fn());
const sessionStore = vi.hoisted(() => ({ entry: undefined as object | undefined }));
const sendOwner = vi.hoisted(() => ({
  callGateway: undefined as undefined | ((request: object) => Promise<unknown>),
  execute: vi.fn(),
}));

vi.mock("../../agents/tools/sessions-send-tool.js", () => ({
  createSessionsSendTool: (options: { callGateway: (request: object) => Promise<unknown> }) => {
    sendOwner.callGateway = options.callGateway;
    return { execute: sendOwner.execute };
  },
}));
vi.mock("../../agents/tools/sessions-spawn-tool.js", () => ({
  createSessionsSpawnTool: (options: {
    callGateway: (method: string, params: object) => Promise<unknown>;
  }) => ({
    execute: async (_toolCallId: string, args: object) =>
      await options.callGateway("sessions.create", args),
  }),
}));
vi.mock("../../agents/tools/in-process-gateway.js", () => ({
  callAgentToolGatewayRequest: gatewayDispatch,
  callInProcessGatewayToolWithCreation: gatewayCreate,
  withAgentToolGatewayRuntimeIdentity: (request: object) => request,
}));
vi.mock("../session-utils.js", () => ({
  loadGatewaySessionEntryReadOnly: (key: string) => ({
    canonicalKey: key,
    entry: sessionStore.entry,
  }),
}));
vi.mock("./placement-turn-claim-events.js", () => ({
  getWorkerTurnExecutionIdentityCapability: () => ({ run: fixture.run }),
}));
vi.mock("./worker-session-tool-topology.js", () => ({
  assertWorkerSessionToolChild: vi.fn(),
  resolveWorkerSessionToolSource: () => source,
  resolveWorkerSessionToolTarget: () => target,
  workerSessionRelationKey: (value: string | undefined) => value,
}));

beforeEach(() => {
  resetGlobalHookRunner();
  fixture.state.active = true;
  fixture.run.mockClear();
  gatewayCreate.mockReset();
  gatewayDispatch.mockReset();
  sessionStore.entry = undefined;
  sendOwner.callGateway = undefined;
  sendOwner.execute.mockReset();
});
afterEach(() => resetGlobalHookRunner());

function installPolicy(toolName: "sessions_send" | "sessions_spawn") {
  const handler = vi.fn(() => {
    const identity = getGatewayToolCallerIdentity();
    expect(identity?.executionIdentityToken).toBeUndefined();
    const receiptAuthority = identity?.receiptAuthority;
    expect(receiptAuthority).toEqual(expect.any(Function));
    receiptAuthority?.();
  });
  initializeGlobalHookRunner(
    createMockPluginRegistry([{ hookName: "before_tool_call", matcher: [toolName], handler }]),
  );
  return handler;
}

function requestIdentity() {
  return {
    environmentId: fixture.claim.owner.environmentId,
    ownerEpoch: fixture.claim.owner.ownerEpoch,
    runId: fixture.claim.runId,
    sessionId: fixture.claim.sessionId,
    turnClaim: fixture.claim,
  };
}

function createExecutor(placements: object, overrides: object = {}) {
  return createWorkerSessionToolExecutor({
    placements,
    resolveGatewayContext: () => undefined,
    environments: {
      get: () => ({
        state: "attached",
        ownerEpoch: fixture.claim.owner.ownerEpoch,
        attachedSessionIds: [fixture.claim.sessionId],
      }),
    },
    dispatchChild: vi.fn(),
    githubPublication: {},
    portals: {},
    ...overrides,
  } as never);
}

function terminalPlacements(operationSeed: string, extra: object = {}) {
  let completed: string | undefined;
  let abandoned = false;
  const abandon = vi.fn(() => {
    abandoned = true;
    return true;
  });
  return {
    abandon,
    placements: {
      ...extra,
      abandonWorkerSessionToolOperation: abandon,
      beginWorkerSessionToolOperation: () =>
        abandoned
          ? { kind: "unknown" }
          : completed
            ? { kind: "completed", resultJson: completed }
            : { kind: "execute", operationSeed },
      completeWorkerSessionToolOperation: (operation: { resultJson: string }) => {
        completed = operation.resultJson;
        return true;
      },
    },
  };
}

it("allows an audit-disabled send while operational authority remains live", async () => {
  const beforeToolCall = installPolicy("sessions_send");
  const store = terminalPlacements("audit-disabled-operation-seed");
  const execute = createExecutor(store.placements);
  gatewayDispatch.mockResolvedValue({ ok: true });
  sendOwner.execute.mockImplementation(async () => {
    const callGateway = sendOwner.callGateway;
    if (!callGateway) {
      throw new Error("missing send Gateway caller");
    }
    await callGateway({ method: "agent", params: {} });
    return { content: [{ type: "text", text: "sent" }] };
  });

  const result = await execute({
    identity: requestIdentity(),
    toolName: "sessions_send",
    request: {
      toolCallId: "audit-disabled-authority-live",
      sessionKey: target.sessionKey,
      message: "deliver",
      timeoutSeconds: 0,
    },
  } as never);

  expect(result.resultJson).toContain("sent");
  expect(beforeToolCall).toHaveBeenCalledOnce();
  expect(gatewayDispatch).toHaveBeenCalledOnce();
  expect(fixture.run).toHaveBeenCalledOnce();
});

it("abandons a reserved operation when execution authority already closed", async () => {
  installPolicy("sessions_send");
  const store = terminalPlacements("closed-before-entry");
  const execute = createExecutor(store.placements);
  fixture.state.active = false;

  const request = {
    identity: requestIdentity(),
    toolName: "sessions_send",
    request: {
      toolCallId: "closed-before-entry",
      sessionKey: target.sessionKey,
      message: "must not deliver",
    },
  };

  await expect(execute(request as never)).rejects.toThrow("worker turn authority changed");
  fixture.state.active = true;
  const retry = await execute(request as never);

  expect(retry.resultJson).toContain("prior operation outcome is unknown");
  expect(sendOwner.execute).not.toHaveBeenCalled();
});

it("fences an allowed send when delegated authority closes before dispatch", async () => {
  const beforeToolCall = installPolicy("sessions_send");
  const store = terminalPlacements("operation-seed");
  const execute = createExecutor(store.placements);
  let finishPreDispatch: (() => void) | undefined;
  sendOwner.execute.mockImplementation(
    async () =>
      await new Promise<unknown>((resolve, reject) => {
        finishPreDispatch = () => {
          const callGateway = sendOwner.callGateway;
          if (!callGateway) {
            reject(new Error("missing send Gateway caller"));
            return;
          }
          callGateway({ method: "agent", params: {} }).then(resolve, reject);
        };
      }),
  );
  const request = {
    identity: requestIdentity(),
    toolName: "sessions_send",
    request: {
      toolCallId: "authority-closed-during-policy",
      sessionKey: target.sessionKey,
      message: "must not deliver",
      timeoutSeconds: 0,
    },
  };

  const pending = execute(request as never);
  await vi.waitFor(() => expect(sendOwner.execute).toHaveBeenCalledOnce());
  fixture.state.active = false;
  finishPreDispatch?.();
  await expect(pending).rejects.toThrow("worker turn authority changed");
  const replay = await execute(request as never);

  expect(replay.resultJson).toContain("worker turn authority changed");
  expect(beforeToolCall).toHaveBeenCalledOnce();
  expect(fixture.run).toHaveBeenCalledOnce();
  expect(gatewayDispatch).not.toHaveBeenCalled();
  expect(sendOwner.execute).toHaveBeenCalledOnce();
  expect(store.abandon).not.toHaveBeenCalled();
});

it("fences child creation when delegated authority closes before commit", async () => {
  const beforeToolCall = installPolicy("sessions_spawn");
  const store = terminalPlacements("spawn-operation-seed", {
    bindWorkerSessionToolOperationChild: () => true,
    isWorkerTurnToolAuthorized: () => true,
  });
  const execute = createExecutor(store.placements);
  let finishCommit: (() => void) | undefined;
  gatewayCreate.mockImplementation(
    async (_method, _params, _creation, options: { sessionMutationCommitGuard: () => void }) =>
      await new Promise<never>((_resolve, reject) => {
        finishCommit = () => {
          try {
            options.sessionMutationCommitGuard();
            reject(new Error("child commit guard unexpectedly allowed creation"));
          } catch (error) {
            reject(error instanceof Error ? error : new Error("child commit guard failed"));
          }
        };
      }),
  );
  const request = {
    identity: requestIdentity(),
    toolName: "sessions_spawn",
    request: { toolCallId: "spawn-authority-closed-before-commit", task: "must not create" },
  };

  const pending = execute(request as never);
  await vi.waitFor(() => expect(gatewayCreate).toHaveBeenCalledOnce());
  fixture.state.active = false;
  finishCommit?.();
  await expect(pending).rejects.toThrow("worker turn authority changed");
  const replay = await execute(request as never);

  expect(replay.resultJson).toContain("worker turn authority changed");
  expect(beforeToolCall).toHaveBeenCalledOnce();
  expect(gatewayCreate).toHaveBeenCalledOnce();
  expect(store.abandon).not.toHaveBeenCalled();
});

it("fences existing-child provisioning when delegated authority closes", async () => {
  const beforeToolCall = installPolicy("sessions_spawn");
  const childSessionKey = "agent:main:dashboard:existing-child";
  const childSessionId = "existing-child-session";
  sessionStore.entry = {
    sessionId: childSessionId,
    parentSessionKey: source.sessionKey,
    parentSessionId: source.sessionId,
  };
  let unknownOperation = false;
  const abandonOperation = vi.fn(() => {
    unknownOperation = true;
    return true;
  });
  const placements = {
    beginWorkerSessionToolOperation: () =>
      unknownOperation
        ? { kind: "unknown" }
        : { kind: "execute", operationSeed: "existing-child-seed", childSessionKey },
    abandonWorkerSessionToolOperation: abandonOperation,
    get: () => undefined,
    isWorkerTurnToolAuthorized: () => true,
  };
  let finishDispatch: (() => void) | undefined;
  let provisioned = 0;
  const dispatchChild = vi.fn(
    async (_request, _onTransition, authorize: (() => void) | undefined) =>
      await new Promise<never>((_resolve, reject) => {
        finishDispatch = () => {
          try {
            authorize?.();
            provisioned += 1;
            reject(new Error("revoked dispatch authorization unexpectedly passed"));
          } catch (error) {
            reject(error instanceof Error ? error : new Error("dispatch authorization failed"));
          }
        };
      }),
  );
  const execute = createExecutor(placements, { dispatchChild });
  const request = {
    identity: requestIdentity(),
    toolName: "sessions_spawn",
    request: { toolCallId: "existing-child-authority-closed", task: "must not provision" },
  };

  const pending = execute(request as never);
  await vi.waitFor(() => expect(dispatchChild).toHaveBeenCalledOnce());
  fixture.state.active = false;
  finishDispatch?.();
  await expect(pending).rejects.toThrow("worker turn authority changed");
  const replay = await execute(request as never);

  expect(replay.resultJson).toContain("prior operation outcome is unknown");
  expect(beforeToolCall).toHaveBeenCalledOnce();
  expect(abandonOperation).toHaveBeenCalledOnce();
  expect(dispatchChild).toHaveBeenCalledOnce();
  expect(provisioned).toBe(0);
});
