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
        executionIdentityToken: { tokenVersion: 1 },
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
  loadGatewaySessionEntryReadOnly: (key: string) => ({ canonicalKey: key, entry: undefined }),
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
  sendOwner.callGateway = undefined;
  sendOwner.execute.mockReset();
});
afterEach(() => resetGlobalHookRunner());

it("fences an allowed send when delegated authority closes before dispatch", async () => {
  const beforeToolCall = vi.fn(() => {
    const receiptAuthority = getGatewayToolCallerIdentity()?.receiptAuthority;
    expect(receiptAuthority).toEqual(expect.any(Function));
    receiptAuthority?.();
  });
  initializeGlobalHookRunner(
    createMockPluginRegistry([
      { hookName: "before_tool_call", matcher: ["sessions_send"], handler: beforeToolCall },
    ]),
  );
  let completed: string | undefined;
  const abandonOperation = vi.fn(() => true);
  const placements = {
    abandonWorkerSessionToolOperation: abandonOperation,
    beginWorkerSessionToolOperation: () =>
      completed
        ? { kind: "completed", resultJson: completed }
        : { kind: "execute", operationSeed: "operation-seed" },
    completeWorkerSessionToolOperation: (operation: { resultJson: string }) => {
      completed = operation.resultJson;
      return true;
    },
  };
  const execute = createWorkerSessionToolExecutor({
    placements,
    resolveGatewayContext: () => undefined,
    environments: {},
    dispatchChild: vi.fn(),
    githubPublication: {},
    portals: {},
  } as never);
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
    identity: {
      runId: fixture.claim.runId,
      sessionId: fixture.claim.sessionId,
      turnClaim: fixture.claim,
    },
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
  expect(abandonOperation).not.toHaveBeenCalled();
});

it("fences child creation when delegated authority closes before commit", async () => {
  const beforeToolCall = vi.fn(() => {
    const receiptAuthority = getGatewayToolCallerIdentity()?.receiptAuthority;
    expect(receiptAuthority).toEqual(expect.any(Function));
    receiptAuthority?.();
  });
  initializeGlobalHookRunner(
    createMockPluginRegistry([
      { hookName: "before_tool_call", matcher: ["sessions_spawn"], handler: beforeToolCall },
    ]),
  );
  let completed: string | undefined;
  const abandonOperation = vi.fn(() => true);
  const placements = {
    abandonWorkerSessionToolOperation: abandonOperation,
    beginWorkerSessionToolOperation: () =>
      completed
        ? { kind: "completed", resultJson: completed }
        : { kind: "execute", operationSeed: "spawn-operation-seed" },
    bindWorkerSessionToolOperationChild: () => true,
    completeWorkerSessionToolOperation: (operation: { resultJson: string }) => {
      completed = operation.resultJson;
      return true;
    },
    isWorkerTurnToolAuthorized: () => true,
  };
  const execute = createWorkerSessionToolExecutor({
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
  } as never);
  let finishCommit: (() => void) | undefined;
  gatewayCreate.mockImplementation(
    async (_method, _params, _creation, options: { sessionMutationCommitGuard: () => void }) =>
      await new Promise<never>((_resolve, reject) => {
        finishCommit = () => {
          try {
            options.sessionMutationCommitGuard();
            reject(new Error("child commit guard unexpectedly allowed creation"));
          } catch (error) {
            reject(error);
          }
        };
      }),
  );
  const request = {
    identity: {
      environmentId: fixture.claim.owner.environmentId,
      ownerEpoch: fixture.claim.owner.ownerEpoch,
      runId: fixture.claim.runId,
      sessionId: fixture.claim.sessionId,
      turnClaim: fixture.claim,
    },
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
  expect(abandonOperation).not.toHaveBeenCalled();
});
