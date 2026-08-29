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
  const assertActive = () => {
    if (!state.active) {
      throw new Error("Session source-session worker turn authority changed");
    }
  };
  return {
    state,
    run: vi.fn(async (callback: () => Promise<unknown>) => {
      assertActive();
      const result = await callback();
      assertActive();
      return result;
    }),
  };
});
const claim = {
  claimId: "source-claim",
  runId: "source-run",
  sessionId: "source-session",
  owner: { kind: "worker", environmentId: "source-environment", ownerEpoch: 1 },
};
const source = {
  agentId: "main",
  sessionId: claim.sessionId,
  sessionKey: "agent:main:dashboard:source",
  turnClaim: claim,
  entry: {},
};
const target = {
  agentId: "main",
  sessionId: "target-session",
  sessionKey: "agent:main:dashboard:target",
};

vi.mock("../../agents/tools/sessions-send-tool.js", () => ({
  createSessionsSendTool: () => ({ execute: delivered }),
}));
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
});
afterEach(() => resetGlobalHookRunner());

it("fences an allowed send when delegated authority closes during policy", async () => {
  let finishPolicy: (() => void) | undefined;
  const beforeToolCall = vi.fn(
    async () =>
      await new Promise<void>((resolve) => {
        finishPolicy = resolve;
      }),
  );
  initializeGlobalHookRunner(
    createMockPluginRegistry([
      { hookName: "before_tool_call", matcher: ["sessions_send"], handler: beforeToolCall },
    ]),
  );
  let completed: string | undefined;
  const placements = {
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
  const request = {
    identity: { runId: claim.runId, sessionId: claim.sessionId, turnClaim: claim },
    toolName: "sessions_send",
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
