// Correlated CLI tool results already carry their started args; display-only
// results must not duplicate that potentially large payload.
import { describe, expect, it, vi } from "vitest";
import { type AgentEventRuntimePayload, onAgentEvent } from "../../infra/agent-events.js";
import { onInternalDiagnosticEvent } from "../../infra/diagnostic-events.js";
import { createTestAdmittedRunContext } from "../admitted-run-context.test-support.js";
import { createCliJsonlStreamingParser } from "../cli-output-stream.js";
import { createCliEventHandlers } from "./execute-events.js";
import type { CliToolTracking } from "./execute-tool-tracking.js";
import type { PreparedCliRunContext } from "./types.js";

function buildContext(runId: string): PreparedCliRunContext {
  const backend = {
    command: "claude",
    args: [],
    output: "jsonl" as const,
    input: "stdin" as const,
    serialize: true,
  };
  return {
    params: {
      admittedRunContext: createTestAdmittedRunContext(runId),
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:main",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      prompt: "hi",
      provider: "claude-cli",
      model: "claude-haiku-4-5",
      timeoutMs: 1_000,
      runId,
    },
    started: Date.now(),
    workspaceDir: "/tmp",
    backendResolved: { id: "claude-cli", config: backend, bundleMcp: false },
    preparedBackend: { backend, env: {} },
    reusableCliSession: { mode: "none" },
    hadSessionFile: false,
    contextEngineConfig: {},
    modelId: "claude-haiku-4-5",
    normalizedModel: "claude-haiku-4-5",
    systemPrompt: "system",
    systemPromptReport: {} as PreparedCliRunContext["systemPromptReport"],
    claudeSkillsPluginArgs: [],
    authEpochVersion: 2,
  } as PreparedCliRunContext;
}

function buildToolTracking(): CliToolTracking {
  return {
    handleCliToolUseStart: vi.fn(),
    handleCliToolResult: vi.fn(),
    resolveCliLoopbackTerminalOutcome: vi.fn(() => undefined),
    beginGatewayCapture: vi.fn(),
  } as unknown as CliToolTracking;
}

function collectToolEvents(runId: string): {
  events: AgentEventRuntimePayload[];
  dispose: () => void;
} {
  const events: AgentEventRuntimePayload[] = [];
  const dispose = onAgentEvent((event) => {
    if (event.runId === runId && event.stream === "tool") {
      events.push(event);
    }
  });
  return { events, dispose };
}

describe("cli tool result events", () => {
  it("keeps correlated result args without adding them to display results", () => {
    const runId = "run-tool-result-args";
    const handlers = createCliEventHandlers({
      context: buildContext(runId),
      toolTracking: buildToolTracking(),
      getRunState: () => ({ failed: false, error: undefined }),
    });
    const { events, dispose } = collectToolEvents(runId);

    try {
      handlers.emitCliToolUseStart({
        toolCallId: "call-1",
        name: "Bash",
        kind: "tool_use",
        args: { command: "nope-not-a-command" },
      });
      handlers.emitCliToolResult({
        toolCallId: "call-1",
        name: "Bash",
        isError: true,
        result: "bash: nope-not-a-command: command not found",
      });
      handlers.emitCliDisplayToolUseStart({
        toolCallId: "call-2",
        name: "write",
        kind: "tool_use",
        args: { path: "note.txt", content: "hello" },
      });
      handlers.emitCliDisplayToolResult({
        toolCallId: "call-2",
        name: "write",
        isError: false,
        result: "wrote note.txt",
      });
      // The display result also releases correlation state for this call id.
      handlers.emitCliToolResult({
        toolCallId: "call-2",
        name: "write",
        isError: false,
        result: "duplicate terminal",
      });

      const results = events.filter((event) => event.data.phase === "result");
      expect(results[0]?.data.args).toEqual({ command: "nope-not-a-command" });
      expect(results[0]?.data.isError).toBe(true);
      expect(results[1]?.data.args).toBeUndefined();
      expect(results[1]?.data.isError).toBe(false);
      expect(results[2]?.data.args).toBeUndefined();
    } finally {
      dispose();
    }
  });

  it("forgets a call's args once it reports, so ids cannot leak across calls", () => {
    const runId = "run-tool-result-args-forget";
    const handlers = createCliEventHandlers({
      context: buildContext(runId),
      toolTracking: buildToolTracking(),
      getRunState: () => ({ failed: false, error: undefined }),
    });
    const { events, dispose } = collectToolEvents(runId);

    try {
      handlers.emitCliToolUseStart({
        toolCallId: "call-1",
        name: "Bash",
        kind: "tool_use",
        args: { command: "first" },
      });
      handlers.emitCliToolResult({
        toolCallId: "call-1",
        name: "Bash",
        isError: false,
        result: "",
      });
      // A second result for the same id must not reuse the first call's request.
      handlers.emitCliToolResult({
        toolCallId: "call-1",
        name: "Bash",
        isError: false,
        result: "",
      });

      const results = events.filter((event) => event.data.phase === "result");
      expect(results[0]?.data.args).toEqual({ command: "first" });
      expect(results[1]?.data.args).toBeUndefined();
    } finally {
      dispose();
    }
  });

  it("emits exactly one tool.execution.started when a later snapshot enriches empty args", async () => {
    // Regression for the raw Discord/CLI progress arg-loss fix: a streaming
    // tool start that fires before its args arrive must be upgradable from a
    // later snapshot through a NON-start update, so the tool-start lifecycle
    // (diagnostics + tracking) stays one-per-call while the live draft still
    // receives the resolved args.
    const runId = "run-one-start-diagnostic";
    const handlers = createCliEventHandlers({
      context: buildContext(runId),
      toolTracking: buildToolTracking(),
      getRunState: () => ({ failed: false, error: undefined }),
    });
    const toolEvents: AgentEventRuntimePayload[] = [];
    const stopTool = onAgentEvent((event) => {
      if (event.runId === runId && event.stream === "tool") {
        toolEvents.push(event);
      }
    });
    let startedDiagnostics = 0;
    const stopDiag = onInternalDiagnosticEvent((event) => {
      if (event.type === "tool.execution.started") {
        startedDiagnostics += 1;
      }
    });

    try {
      // 1. Streaming start with empty args (the name-only row).
      handlers.emitParsedToolUseStart({
        toolCallId: "call-up",
        name: "Bash",
        kind: "tool_use",
        args: {},
      });
      // 2. Late snapshot enriches the args via a non-start update.
      handlers.emitCliToolUseUpdate({
        toolCallId: "call-up",
        name: "Bash",
        args: { command: "echo hi" },
      });

      // tool.execution.started is dispatched on the async diagnostic queue.
      await new Promise((resolve) => {
        setImmediate(resolve);
      });
      await new Promise((resolve) => {
        setImmediate(resolve);
      });

      // Exactly one start lifecycle diagnostic; the update did not re-fire it.
      expect(startedDiagnostics).toBe(1);
      // The live event stream carries one start (empty) plus one update (rich).
      const starts = toolEvents.filter((event) => event.data.phase === "start");
      const updates = toolEvents.filter((event) => event.data.phase === "update");
      expect(starts).toHaveLength(1);
      expect(starts[0]?.data.args).toEqual({});
      expect(updates).toHaveLength(1);
      expect(updates[0]?.data.args).toEqual({ command: "echo hi" });
    } finally {
      stopDiag();
      stopTool();
    }
  });

  it("runs the parser end-to-end to a non-start update with one start lifecycle", async () => {
    // After-fix run: the real streaming parser produces a tool start with
    // empty args (name-only draft row), then a later assistant-record
    // snapshot enriches the args through the non-start onToolUseUpdate path.
    // Asserts the live tool stream carries one start (empty) + one update
    // (resolved args) and exactly one tool.execution.started diagnostic fires.
    const runId = "run-parser-non-start-update";
    const handlers = createCliEventHandlers({
      context: buildContext(runId),
      toolTracking: buildToolTracking(),
      getRunState: () => ({ failed: false, error: undefined }),
    });
    const toolEvents: AgentEventRuntimePayload[] = [];
    const stopTool = onAgentEvent((event) => {
      if (event.runId === runId && event.stream === "tool") {
        toolEvents.push(event);
      }
    });
    let startedDiagnostics = 0;
    const stopDiag = onInternalDiagnosticEvent((event) => {
      if (event.type === "tool.execution.started") {
        startedDiagnostics += 1;
      }
    });

    const parser = createCliJsonlStreamingParser({
      backend: {
        command: "local-cli",
        output: "jsonl",
        jsonlDialect: "claude-stream-json",
        sessionIdFields: ["session_id"],
      },
      providerId: "claude-cli",
      onAssistantDelta: () => undefined,
      onToolUseStart: handlers.emitParsedToolUseStart,
      onToolUseUpdate: handlers.emitCliToolUseUpdate,
      onToolResult: handlers.emitParsedToolResult,
    });

    try {
      parser.push(
        [
          JSON.stringify({
            type: "stream_event",
            event: {
              type: "content_block_start",
              index: 0,
              content_block: { type: "tool_use", id: "toolu_run", name: "Bash", input: {} },
            },
          }),
          JSON.stringify({
            type: "stream_event",
            event: { type: "content_block_stop", index: 0 },
          }),
          JSON.stringify({
            type: "assistant",
            message: {
              id: "msg-run",
              content: [
                { type: "tool_use", id: "toolu_run", name: "Bash", input: { command: "echo hi" } },
              ],
            },
          }),
          "",
        ].join("\n"),
      );
      parser.finish();

      // tool.execution.started is dispatched on the async diagnostic queue.
      await new Promise((resolve) => {
        setImmediate(resolve);
      });
      await new Promise((resolve) => {
        setImmediate(resolve);
      });

      // Exactly one start lifecycle diagnostic; the update did not re-fire it.
      expect(startedDiagnostics).toBe(1);
      const starts = toolEvents.filter((event) => event.data.phase === "start");
      const updates = toolEvents.filter((event) => event.data.phase === "update");
      expect(starts).toHaveLength(1);
      expect(starts[0]?.data.args).toEqual({});
      expect(updates).toHaveLength(1);
      expect(updates[0]?.data.args).toEqual({ command: "echo hi" });
    } finally {
      stopDiag();
      stopTool();
    }
  });
});
