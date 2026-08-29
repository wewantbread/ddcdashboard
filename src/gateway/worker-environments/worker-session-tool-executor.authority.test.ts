import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../../plugins/hooks.test-helpers.js";
import { createWorkerSessionToolExecutor } from "./worker-session-tool-executor.js";

const delivered = vi.hoisted(() => vi.fn());
const authority = vi.hoisted(() => {
  const state = { active: true };
  return {
    state,
    run: vi.fn(async (callback: (identity: object) => Promise<unknown>) => {
      if (!state.active) {
        throw new Error("Session source-session worker turn authority changed");
      }
      const result = await callback({});
      if (!state.active) {
        throw new Error("Session source-session worker turn authority changed");
      }
      return result;
    }),
  };
});

const claim = {
  claimId: "source-claim",
  runId: "source-run",
  placementGeneration: 1,
  sessionId: "source-session",
  agentId: "main",
  sessionKey: "agent:main:dashboard:source",
  owner: { kind: "worker", environmentId: "source-environment", ownerEpoch: 1 },
};
const source = {
  agentId: "main",
  sessionId: claim.sessionId,
  sessionKey: claim.sessionKey,
  turnClaim: claim,
  entry: { sessionId: claim.sessionId, updatedAt: 1 },
};
const target = {
  agentId: "main",
  sessionId: "target-session",
  sessionKey: "agent:main:dashboard:target",
};

vi.mock("../../agents/tools/sessions-send-tool.js", () => ({
  createSessionsSendTool: () => ({
    execute: async (...args: unknown[]) => await delivered(...args),
  }),
}));
vi.mock("../../agents/tools/sessions-spawn-tool.js", () => ({
  createSessionsSpawnTool: vi.fn(),
}));
vi.mock("../../agents/tools/in-process-gateway.js", () => ({
  callAgentToolGatewayRequest: vi.fn(),
  callInProcessGatewayToolWithCreation: vi.fn(),
  withAgentToolGatewayRuntimeIdentity: vi.fn(),
}));
vi.mock("../../agents/tools/scoped-session-access.js", () => ({
  runWithScopedSessionAccess: vi.fn(),
}));
vi.mock("../../config/config.js", () => ({ getRuntimeConfig: () => ({}) }));
vi.mock("./placement-turn-claim-events.js", () => ({
  getWorkerTurnExecutionIdentityCapability: () => ({ run: authority.run }),
}));
vi.mock("./worker-session-tool-topology.js", () => ({
  assertWorkerSessionToolChild: vi.fn(),
  resolveWorkerSessionToolSource: () => source,
  resolveWorkerSessionToolTarget: () => target,
  workerSessionRelationKey: (value: string | undefined) => value,
}));

beforeEach(() => {
  resetGlobalHookRunner();
  authority.state.active = true;
  authority.run.mockClear();
  delivered.mockReset();
  delivered.mockResolvedValue({ content: [{ type: "text", text: "sent" }] });
});

afterEach(() => resetGlobalHookRunner());

it("fences an allowed send when delegated authority closes during policy", async () => {
  let finishPolicy: (() => void) | undefined;
  const beforeToolCall = vi.fn(async () => {
    await new Promise<void>((resolve) => {
      finishPolicy = resolve;
    });
  });
  initializeGlobalHookRunner(
    createMockPluginRegistry([
      { hookName: "before_tool_call", matcher: ["sessions_send"], handler: beforeToolCall },
    ]),
  );

  let completedResult: string | undefined;
  const placements = {
    beginWorkerSessionToolOperation: () =>
      completedResult
        ? { kind: "completed", resultJson: completedResult }
        : { kind: "execute", operationSeed: "operation-seed" },
    completeWorkerSessionToolOperation: (operation: { resultJson: string }) => {
      completedResult = operation.resultJson;
      return true;
    },
  };
  const execute = createWorkerSessionToolExecutor({
    resolveGatewayContext: () => undefined,
    placements: placements as never,
    dispatchChild: vi.fn(),
    githubPublication: { requestForClaim: vi.fn() },
    portals: { getService: () => undefined, carrier: { open: vi.fn() }, onChanged: vi.fn() },
    environments: { get: vi.fn() },
  });
  const request = {
    identity: {
      environmentId: claim.owner.environmentId,
      credentialHash: "credential-hash",
      bundleHash: "a".repeat(64),
      sessionId: claim.sessionId,
      runId: claim.runId,
      turnClaim: claim,
      ownerEpoch: claim.owner.ownerEpoch,
      rpcSetVersion: 1,
      protocolFeatures: ["worker-session-tools-v1"],
      credentialExpiresAtMs: Date.now() + 60_000,
    },
    toolName: "sessions_send" as const,
    request: {
      toolCallId: "authority-closed-during-policy",
      sessionKey: target.sessionKey,
      message: "must not deliver",
      timeoutSeconds: 0,
    },
  };

  const pending = execute(request as never);
  await vi.waitFor(() => expect(beforeToolCall).toHaveBeenCalledOnce());
  authority.state.active = false;
  finishPolicy?.();
  const result = await pending;
  const replay = await execute(request as never);

  expect(result.resultJson).toContain("worker turn authority changed");
  expect(replay.resultJson).toBe(result.resultJson);
  expect(authority.run).toHaveBeenCalledOnce();
  expect(delivered).not.toHaveBeenCalled();
});
