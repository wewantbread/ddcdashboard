/**
 * Standalone real-behavior proof for issue #119977 / PR #120443.
 *
 * NOT a Vitest test. Imports the real fix modules and drives
 * `maybeCompactCodexAppServerSession` against a simulated Codex app-server
 * client + in-memory binding store, then feeds the actual returned results
 * into the real core recovery recognizers. Prints observed shapes so the
 * runtime contract of the three fixed code paths can be inspected directly.
 *
 * Executed inside a Docker container (see run-issue-119977-docker.sh) against
 * the host-built tree bind-mounted read-only, so `openclaw/plugin-sdk/*`
 * imports resolve to the compiled dist bytes the SDK boundary would ship.
 *
 * Scenarios:
 *   (a) stale-binding recovery  -> failure.reason "stale_thread_binding",
 *                                  routed to recovery by
 *                                  isRecoverableNativeHarnessBindingFailure.
 *   (b) blocked-native deferral -> harnessOwnedAutomaticCompaction flag set,
 *                                  recognized by
 *                                  isHarnessOwnedAutomaticCompactionSkip, and
 *                                  NOT present on the public SDK type.
 *   (c) primary/after stage     -> details.request "before_context_engine"
 *                                  and "after_context_engine".
 */
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import {
  ensureCodexAppServerClientRuntime,
  retainCodexAppServerLiveThread,
} from "../../extensions/codex/src/app-server/client-runtime.js";
import { maybeCompactCodexAppServerSession } from "../../extensions/codex/src/app-server/compact.js";
import { isHarnessOwnedAutomaticCompactionSkip } from "../../src/agents/embedded-agent-runner/compact-reasons.js";
import { isRecoverableNativeHarnessBindingFailure } from "../../src/agents/harness/compaction-recovery.js";

type AnyRecord = Record<string, unknown>;
type Notification = { method: string; params?: AnyRecord };
type Binding = AnyRecord & { threadId: string; cwd: string };

let failures = 0;

function check(label: string, condition: boolean): void {
  const status = condition ? "PASS" : "FAIL";
  if (!condition) failures += 1;
  console.log(`  [${status}] ${label}`);
}

function heading(title: string): void {
  console.log(`\n=== ${title} ===`);
}

function printResult(label: string, value: unknown): void {
  console.log(`  ${label}: ${JSON.stringify(value, null, 2).split("\n").join("\n  ")}`);
}

function createInMemoryBindingStore(
  initial: Binding | undefined,
  options: { staleBindingAfterFirstRead?: Binding } = {},
): { store: any; current: () => Binding | undefined; reads: () => number } {
  let current = initial;
  let reads = 0;
  const notUsed = (name: string) => async () => {
    throw new Error(`in-memory proof binding store does not implement ${name}`);
  };
  const store = {
    read: async (): Promise<Binding | undefined> => {
      const value = current;
      reads += 1;
      if (reads === 1 && options.staleBindingAfterFirstRead) {
        current = options.staleBindingAfterFirstRead;
      }
      return value;
    },
    withLease: async <T,>(_identity: unknown, run: () => Promise<T>): Promise<T> => run(),
    mutate: async (_identity: unknown, mutation: AnyRecord): Promise<boolean> => {
      if (mutation.kind === "clear") {
        if (!current) return false;
        if (typeof mutation.threadId === "string" && current.threadId !== mutation.threadId)
          return false;
        current = undefined;
        return true;
      }
      if (mutation.kind === "set") {
        current = mutation.binding as Binding;
        return true;
      }
      if (mutation.kind === "patch") {
        if (!current || current.threadId !== mutation.threadId) return false;
        current = { ...current, ...(mutation.patch as AnyRecord) } as Binding;
        return true;
      }
      return false;
    },
    hasOtherThreadOwner: notUsed("hasOtherThreadOwner"),
    prepareSessionGenerationReclaim: notUsed("prepareSessionGenerationReclaim"),
    adoptSessionGeneration: notUsed("adoptSessionGeneration"),
    resetSessionGeneration: notUsed("resetSessionGeneration"),
    retireSessionGeneration: notUsed("retireSessionGeneration"),
    withThreadArchiveFence: async <T,>(run: () => Promise<T>): Promise<T> => run(),
  };
  return { store, current: () => current, reads: () => reads };
}

function createFakeCodexClient(options: {
  agentDir: string;
  autoCompleteCompaction?: boolean;
  retainedThreadId?: string | null;
}): { client: any; requestCalls: Array<{ method: string; params?: AnyRecord }> } {
  const handlers = new Set<(n: Notification) => void>();
  const closeHandlers = new Set<() => void>();
  const requestCalls: Array<{ method: string; params?: AnyRecord }> = [];
  const retainedThreadId =
    options.retainedThreadId === undefined ? "thread-1" : options.retainedThreadId;
  const subscribed = new Set<string>(retainedThreadId ? [retainedThreadId] : []);

  const emit = (n: Notification): void => {
    const threadId = n.params?.threadId as string | undefined;
    if (threadId && !subscribed.has(threadId)) return;
    for (const h of handlers) h(n);
  };

  const emitCompactionLifecycle = (threadId: string): void => {
    emit({
      method: "turn/started",
      params: { threadId, turn: { id: "compact-turn-1", threadId, status: "inProgress" } },
    });
    emit({
      method: "item/started",
      params: {
        threadId,
        turnId: "compact-turn-1",
        item: { id: "compact-item-1", type: "contextCompaction" },
      },
    });
    emit({
      method: "item/completed",
      params: {
        threadId,
        turnId: "compact-turn-1",
        item: { id: "compact-item-1", type: "contextCompaction" },
      },
    });
    emit({
      method: "turn/completed",
      params: { threadId, turn: { id: "compact-turn-1", threadId, status: "completed" } },
    });
  };

  const request = async (method: string, params?: AnyRecord): Promise<AnyRecord> => {
    requestCalls.push({ method, params });
    const threadId = params?.threadId as string | undefined;
    if (method === "thread/unsubscribe" && threadId) {
      subscribed.delete(threadId);
      return {};
    }
    if (method === "thread/compact/start" && options.autoCompleteCompaction !== false) {
      if (typeof threadId !== "string") throw new Error("thread/compact/start requires threadId");
      emitCompactionLifecycle(threadId);
    }
    return {};
  };

  const close = (): void => {
    for (const h of closeHandlers) h();
  };
  const client = {
    request,
    close,
    closeAndWait: async () => {
      close();
      return true;
    },
    addNotificationHandler: (h: (n: Notification) => void) => {
      handlers.add(h);
      return () => handlers.delete(h);
    },
    addRequestHandler: () => () => undefined,
    addCloseHandler: (h: () => void) => {
      closeHandlers.add(h);
      return () => closeHandlers.delete(h);
    },
  };

  ensureCodexAppServerClientRuntime(client as any, { agentDir: options.agentDir } as any);
  if (retainedThreadId) {
    void retainCodexAppServerLiveThread(
      client as any,
      retainedThreadId,
      undefined,
      `config-${retainedThreadId}`,
    );
  }
  return { client, requestCalls };
}

function requireResult(result: unknown): AnyRecord {
  if (!result || typeof result !== "object") throw new Error("expected a compaction result object");
  return result as AnyRecord;
}

function details(result: AnyRecord): AnyRecord {
  // The plugin returns { ok, compacted, ..., result: { details: {...} } } —
  // the caller-visible telemetry lives under result.details, not top-level.
  const inner = result.result as AnyRecord | undefined;
  return (inner?.details as AnyRecord | undefined) ?? {};
}

async function scenarioStaleBinding(tempDir: string): Promise<void> {
  heading("Scenario (a): stale thread binding under the guarded native lease");
  const { store } = createInMemoryBindingStore(
    { threadId: "thread-1", cwd: tempDir },
    { staleBindingAfterFirstRead: { threadId: "thread-2", cwd: tempDir } },
  );
  const fake = createFakeCodexClient({ agentDir: tempDir });

  const result = requireResult(
    await maybeCompactCodexAppServerSession(
      {
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        sessionFile: path.join(tempDir, "session-a.jsonl"),
        workspaceDir: tempDir,
        trigger: "budget",
        currentTokenCount: 456,
      } as any,
      { bindingStore: store, clientFactory: async () => fake.client } as any,
    ),
  );

  printResult("returned result", result);
  const routesToRecovery = isRecoverableNativeHarnessBindingFailure(result as any);
  console.log(`  isRecoverableNativeHarnessBindingFailure(result) => ${routesToRecovery}`);

  check("ok === false", result.ok === false);
  check("compacted === false", result.compacted === false);
  check(
    "reason names the binding change",
    result.reason === "codex app-server binding changed before native compaction",
  );
  check(
    'failure.reason === "stale_thread_binding"',
    (result.failure as AnyRecord | undefined)?.reason === "stale_thread_binding",
  );
  check(
    "no native thread/compact/start was issued",
    fake.requestCalls.every((c) => c.method !== "thread/compact/start"),
  );
  check("routed to recovery (not thrown / not skipped)", routesToRecovery === true);
}

async function scenarioBlockedNativeDeferral(tempDir: string): Promise<void> {
  heading("Scenario (b): blocked-native / harness-owned automatic-compaction deferral");
  const { store } = createInMemoryBindingStore({ threadId: "thread-1", cwd: tempDir });
  const fake = createFakeCodexClient({ agentDir: tempDir });

  const result = requireResult(
    await maybeCompactCodexAppServerSession(
      {
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        sessionFile: path.join(tempDir, "session-b.jsonl"),
        workspaceDir: tempDir,
        trigger: "budget",
        currentTokenCount: 456,
        config: { agents: { defaults: { sandbox: { mode: "all" } } } },
      } as any,
      { bindingStore: store, clientFactory: async () => fake.client } as any,
    ),
  );

  printResult("returned result", result);
  const recognizedSkip = isHarnessOwnedAutomaticCompactionSkip(result as any);
  console.log(`  isHarnessOwnedAutomaticCompactionSkip(result) => ${recognizedSkip}`);

  const publicTypeSource = await fs.readFile(
    path.resolve(
      import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
      "../../src/agents/embedded-agent-runner/types.ts",
    ),
    "utf8",
  );
  const publicTypeHasFlag = /harnessOwnedAutomaticCompaction\?/i.test(publicTypeSource);

  check("ok === true", result.ok === true);
  check("compacted === false", result.compacted === false);
  check(
    'details.reason === "native_execution_unavailable"',
    details(result).reason === "native_execution_unavailable",
  );
  check(
    "harnessOwnedAutomaticCompaction === true",
    (result as any).harnessOwnedAutomaticCompaction === true,
  );
  check("isHarnessOwnedAutomaticCompactionSkip(result) === true", recognizedSkip === true);
  check(
    "public SDK EmbeddedAgentCompactResult does NOT declare harnessOwnedAutomaticCompaction",
    publicTypeHasFlag === false,
  );
}

async function scenarioStageTelemetry(tempDir: string): Promise<void> {
  heading("Scenario (c): native-request stage telemetry (primary vs after-context-engine)");

  const { store: storePrimary } = createInMemoryBindingStore({
    threadId: "thread-1",
    cwd: tempDir,
  });
  const primary = createFakeCodexClient({ agentDir: tempDir });
  const primaryResult = requireResult(
    await maybeCompactCodexAppServerSession(
      {
        sessionId: "session-primary",
        sessionKey: "agent:main:session-primary",
        sessionFile: path.join(tempDir, "session-c1.jsonl"),
        workspaceDir: tempDir,
        trigger: "budget",
        currentTokenCount: 456,
      } as any,
      { bindingStore: storePrimary, clientFactory: async () => primary.client } as any,
    ),
  );
  printResult("primary result", primaryResult);
  check(
    'primary: details.request === "before_context_engine"',
    details(primaryResult).request === "before_context_engine",
  );

  const { store: storeAfter } = createInMemoryBindingStore({ threadId: "thread-1", cwd: tempDir });
  const after = createFakeCodexClient({ agentDir: tempDir });
  const afterResult = requireResult(
    await maybeCompactCodexAppServerSession(
      {
        sessionId: "session-after",
        sessionKey: "agent:main:session-after",
        sessionFile: path.join(tempDir, "session-c2.jsonl"),
        workspaceDir: tempDir,
        trigger: "budget",
        currentTokenCount: 456,
      } as any,
      {
        bindingStore: storeAfter,
        clientFactory: async () => after.client,
        nativeCompactionRequest: "after_context_engine",
      } as any,
    ),
  );
  printResult("after-context-engine result", afterResult);
  check(
    'after: details.request === "after_context_engine"',
    details(afterResult).request === "after_context_engine",
  );
}

async function main(): Promise<void> {
  heading("Runtime environment");
  console.log(`  node: ${process.version}`);
  console.log(`  cwd:  ${process.cwd()}`);
  const req = createRequire(import.meta.url);
  const sdkPath = req.resolve("openclaw/plugin-sdk/agent-harness-runtime");
  console.log(`  openclaw/plugin-sdk/agent-harness-runtime => ${sdkPath}`);
  // tsx prefers TypeScript source paths over compiled dist when both exist.
  // Either resolution is acceptable: the runtime behaviour of the fix modules
  // depends only on the code they import through this alias, not on whether
  // it was compiled at build time or transpiled on the fly by tsx.
  check(
    "SDK seam resolves via openclaw/plugin-sdk/*",
    /openclaw\/plugin-sdk|\bdist\/plugin-sdk\b|\bsrc\/plugin-sdk\b/.test(sdkPath),
  );

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "proof-119977-"));
  try {
    await scenarioStaleBinding(tempDir);
    await scenarioBlockedNativeDeferral(tempDir);
    await scenarioStageTelemetry(tempDir);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }

  console.log(
    `\n=== Summary ===\n  ${failures === 0 ? "ALL CHECKS PASSED" : `${failures} FAILED CHECK(S)`}`,
  );
  if (failures > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error("proof runner threw:", error);
  process.exit(2);
});
