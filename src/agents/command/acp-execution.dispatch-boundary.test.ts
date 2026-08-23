import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const attemptRuntime = {
    buildAcpResult: vi.fn(() => ({ payloads: [], meta: {} })),
    createAcpToolLifecycleTracker: vi.fn(() => ({})),
    createAcpVisibleTextAccumulator: vi.fn(() => ({
      consume: vi.fn(),
      finalize: vi.fn(() => ""),
      finalizeRaw: vi.fn(() => ""),
      finalizeReplySnapshot: vi.fn(() => undefined),
    })),
    emitAcpAssistantDelta: vi.fn(),
    emitAcpLifecycleEnd: vi.fn(),
    emitAcpLifecycleError: vi.fn(),
    emitAcpLifecycleStart: vi.fn(),
    emitAcpPromptSubmitted: vi.fn(),
    emitAcpRuntimeEvent: vi.fn(),
    persistAcpTurnTranscript: vi.fn(async () => ({ sessionEntry: undefined })),
  };
  return { attemptRuntime };
});

vi.mock("../../infra/agent-events.js", () => ({
  assertAgentRunLifecycleGenerationCurrent: vi.fn(),
}));
vi.mock("../../infra/agent-run-registry.js", () => ({
  registerAgentRunContext: vi.fn(),
}));
vi.mock("./runtime-loaders.js", () => ({
  loadAcpPolicyRuntime: async () => ({
    resolveAcpAgentPolicyError: () => undefined,
    resolveAcpDispatchPolicyError: () => undefined,
    resolveAcpExplicitTurnPolicyError: () => undefined,
  }),
  loadAcpRuntimeErrorsRuntime: async () => ({
    toAcpRuntimeError: ({ error }: { error: unknown }) => error,
  }),
  loadAcpSessionIdentifiersRuntime: async () => ({
    resolveAcpSessionCwd: () => undefined,
  }),
  loadAttemptExecutionRuntime: async () => mocks.attemptRuntime,
  loadDeliveryRuntime: async () => ({
    deliverAgentCommandResult: async ({ result }: { result: unknown }) => result,
  }),
}));

import { runAcpAgentCommand } from "./acp-execution.js";

function runWithManager(params: {
  runTurn: (input: {
    onBeforePrompt?: () => Promise<void> | void;
    onLifecycle?: (event: { type: "prompt_submitted"; at: number }) => Promise<void> | void;
  }) => Promise<void>;
  onProviderDispatching: () => void;
  onProviderRunning: () => void;
}) {
  // SAFETY: the test double supplies the only PreparedAgentRunAdmission method this path invokes.
  const preparedRunAdmission = { admit: vi.fn(async () => ({})) } as never;
  // SAFETY: delivery is mocked, so no channel dependency is read from this bag.
  const deps = {} as never;
  return runAcpAgentCommand({
    preparedRunAdmission,
    cfg: {},
    deps,
    runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    opts: {
      onExecutionStarted: vi.fn(),
      onProviderDispatching: params.onProviderDispatching,
      onProviderRunning: params.onProviderRunning,
    },
    outboundSession: undefined,
    body: "submit once",
    transcriptBody: "submit once",
    suppressVisibleSessionEffects: false,
    provenance: "system",
    sessionAgentId: "main",
    sessionId: "session-1",
    sessionKey: "agent:main:acp:session-1",
    storePath: "/tmp/sessions.json",
    workspaceDir: "/tmp",
    runId: "run-acp-dispatch-boundary",
    lifecycleGeneration: "generation-1",
    // SAFETY: this test exercises only runTurn and does not access other manager methods.
    acpManager: { runTurn: params.runTurn } as never,
    // SAFETY: the execution path reads only meta.agent and optional cwd.
    acpResolution: {
      kind: "ready",
      sessionKey: "agent:main:acp:session-1",
      meta: { agent: "main" },
    } as never,
    trackInternalModelRunTarget: vi.fn(),
  });
}

describe("runAcpAgentCommand provider dispatch boundary", () => {
  it("commits dispatch before runtime prompt and running after promptStarted", async () => {
    const order: string[] = [];
    const onProviderDispatching = vi.fn(() => order.push("dispatching-cas"));
    const onProviderRunning = vi.fn(() => order.push("running-cas"));

    await runWithManager({
      onProviderDispatching,
      onProviderRunning,
      runTurn: async (input) => {
        await input.onBeforePrompt?.();
        order.push("provider-prompt");
        await input.onLifecycle?.({ type: "prompt_submitted", at: 123 });
      },
    });

    expect(order).toEqual(["dispatching-cas", "provider-prompt", "running-cas"]);
  });

  it("suppresses ACP runtime prompt when the dispatch CAS fails", async () => {
    const providerPrompt = vi.fn();

    await expect(
      runWithManager({
        onProviderDispatching: () => {
          throw new Error("collector launch is not prepared for provider dispatch");
        },
        onProviderRunning: vi.fn(),
        runTurn: async (input) => {
          await input.onBeforePrompt?.();
          providerPrompt();
        },
      }),
    ).rejects.toThrow("collector launch is not prepared");

    expect(providerPrompt).not.toHaveBeenCalled();
  });
});
