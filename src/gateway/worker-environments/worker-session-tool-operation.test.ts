import { asNonArrayRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../../plugins/hooks.test-helpers.js";
import type { WorkerConnectionIdentity } from "./connection-identity.js";
import { applyWorkerSessionToolPolicy } from "./worker-session-tool-operation.js";

const identity: WorkerConnectionIdentity = {
  environmentId: "worker-environment",
  credentialHash: "credential-hash",
  bundleHash: "a".repeat(64),
  sessionId: "source-session",
  runId: "source-run",
  turnClaim: null,
  ownerEpoch: 1,
  rpcSetVersion: 1,
  protocolFeatures: ["worker-session-tools-v1"],
  credentialExpiresAtMs: Date.now() + 60_000,
};
const source = {
  agentId: "main",
  sessionId: "source-session",
  sessionKey: "agent:main:dashboard:source",
};

describe("worker session tool policy", () => {
  beforeEach(() => resetGlobalHookRunner());
  afterEach(() => resetGlobalHookRunner());

  it("blocks spawns and preserves validated rewrites before execution", async () => {
    const beforeToolCall = vi.fn(async (...args: unknown[]) => {
      const event = asNonArrayRecord(args[0]);
      if (event.toolName === "sessions_spawn") {
        return { block: true, blockReason: "blocked by worker session policy" };
      }
      return {
        params: {
          ...asNonArrayRecord(event.params),
          message: "rewritten by policy",
          toolCallId: "rewritten-call-id",
        },
      };
    });
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_tool_call",
          matcher: ["sessions_spawn", "sessions_send"],
          handler: beforeToolCall,
        },
      ]),
    );

    const spawn = await applyWorkerSessionToolPolicy({
      request: {
        identity,
        toolName: "sessions_spawn",
        request: { toolCallId: "spawn-1", task: "start the child" },
      },
      source,
    });
    const send = await applyWorkerSessionToolPolicy({
      request: {
        identity,
        toolName: "sessions_send",
        request: {
          toolCallId: "send-1",
          sessionKey: "agent:main:dashboard:target",
          message: "original message",
        },
      },
      source,
    });

    expect(spawn).toMatchObject({
      result: {
        details: { status: "blocked", reason: "blocked by worker session policy" },
      },
    });
    expect(send).toMatchObject({
      request: { request: { message: "rewritten by policy", toolCallId: "send-1" } },
    });
    expect(beforeToolCall).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        params: { task: "start the child" },
        toolCallId: "spawn-1",
        toolName: "sessions_spawn",
      }),
      expect.objectContaining({
        agentId: source.agentId,
        runId: identity.runId,
        sessionId: source.sessionId,
        sessionKey: source.sessionKey,
      }),
    );
  });

  it("fails closed when a hook rewrite violates the worker protocol", async () => {
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_tool_call",
          matcher: ["sessions_spawn"],
          handler: async () => ({ params: { task: "" } }),
        },
      ]),
    );

    const result = await applyWorkerSessionToolPolicy({
      request: {
        identity,
        toolName: "sessions_spawn",
        request: { toolCallId: "spawn-invalid-rewrite", task: "start the child" },
      },
      source,
    });

    expect(result).toMatchObject({
      result: {
        details: {
          status: "blocked",
          reason:
            "Tool call blocked because before_tool_call returned invalid sessions_spawn input.",
        },
      },
    });
  });
});
