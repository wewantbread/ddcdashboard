import type { DiagnosticSessionActiveWorkKind } from "../infra/diagnostic-events.js";
import {
  type DiagnosticArgumentChurnActivity,
  resolveArgumentChurnProgress,
} from "./diagnostic-argument-churn-activity.js";
import {
  type DiagnosticRepeatedRequestActivity,
  resolveRepeatedRequestNoProgressAgeMs,
} from "./diagnostic-repeated-request-activity.js";

export type DiagnosticSessionActivitySnapshot = {
  activeWorkKind?: DiagnosticSessionActiveWorkKind;
  hasActiveEmbeddedRun?: boolean;
  activeToolName?: string;
  activeToolCallId?: string;
  activeToolAgeMs?: number;
  activeToolDeadlineAtMs?: number;
  lastProgressAgeMs?: number;
  lastProgressReason?: string;
  repeatedRequestNoProgressAgeMs?: number;
  activeModelCallRequestTimeoutMs?: number;
  hasOutstandingBackgroundWork?: boolean;
};

type SnapshotTool = {
  runId?: string;
  toolName: string;
  toolCallId?: string;
  startedAt: number;
  deadlineAtMs?: number;
};
type SnapshotActivity = DiagnosticArgumentChurnActivity &
  DiagnosticRepeatedRequestActivity & {
    activeEmbeddedRuns: ReadonlyMap<
      string,
      { runId: string; sequence: number; generation?: unknown }
    >;
    activeModelCalls: ReadonlyMap<string, { runId?: string }>;
    activeCoreModelCalls: ReadonlyMap<
      object,
      ReadonlyMap<string, { runId?: string; requestTimeoutMs?: number }>
    >;
    activeTools: ReadonlyMap<string, SnapshotTool>;
    outstandingBackgroundWork: Map<unknown, { runId: string; count: number }>;
    lastProgressAt: number;
    lastProgressReason?: string;
  };

// A background-work fact only certifies the run that reported it. Grace must
// never leak from a departed run's leftover entry to its successor (#118386).
function hasActiveMarkerForRun(activity: SnapshotActivity, runId: string): boolean {
  for (const run of activity.activeEmbeddedRuns.values()) {
    if (run.runId === runId) {
      return true;
    }
  }
  for (const tool of activity.activeTools.values()) {
    if (tool.runId === runId) {
      return true;
    }
  }
  for (const call of activity.activeModelCalls.values()) {
    if (call.runId === runId) {
      return true;
    }
  }
  for (const calls of activity.activeCoreModelCalls.values()) {
    for (const call of calls.values()) {
      if (call.runId === runId) {
        return true;
      }
    }
  }
  return false;
}

function hasActiveOutstandingBackgroundWork(activity: SnapshotActivity): boolean {
  for (const [lifetime, fact] of activity.outstandingBackgroundWork) {
    if (fact.count <= 0) {
      continue;
    }
    if (typeof lifetime !== "object" || lifetime === null) {
      if (hasActiveMarkerForRun(activity, String(lifetime))) {
        return true;
      }
      continue;
    }
    for (const run of activity.activeEmbeddedRuns.values()) {
      if (run.generation === lifetime) {
        return true;
      }
    }
  }
  return false;
}

export function buildDiagnosticSessionActivitySnapshot(
  activity: SnapshotActivity,
  now: number,
): DiagnosticSessionActivitySnapshot {
  let activeCoreModelCallCount = 0;
  let activeModelCallRequestTimeoutMs: number | undefined;
  for (const calls of activity.activeCoreModelCalls.values()) {
    activeCoreModelCallCount += calls.size;
    for (const call of calls.values()) {
      if (
        call.requestTimeoutMs !== undefined &&
        (activeModelCallRequestTimeoutMs === undefined ||
          call.requestTimeoutMs > activeModelCallRequestTimeoutMs)
      ) {
        activeModelCallRequestTimeoutMs = call.requestTimeoutMs;
      }
    }
  }
  const activeWorkKind: DiagnosticSessionActiveWorkKind | undefined =
    activity.activeTools.size > 0
      ? "tool_call"
      : activity.activeModelCalls.size > 0 || activeCoreModelCallCount > 0
        ? "model_call"
        : activity.activeEmbeddedRuns.size > 0
          ? "embedded_run"
          : undefined;
  let activeTool: SnapshotTool | undefined;
  for (const tool of activity.activeTools.values()) {
    if (!activeTool || tool.startedAt < activeTool.startedAt) {
      activeTool = tool;
    }
  }
  const churnProgress = resolveArgumentChurnProgress(
    activity,
    activity.activeEmbeddedRuns.values(),
    now,
  );
  return {
    activeWorkKind,
    ...(activity.activeEmbeddedRuns.size > 0 ? { hasActiveEmbeddedRun: true } : {}),
    activeToolName: activeTool?.toolName,
    activeToolCallId: activeTool?.toolCallId,
    activeToolAgeMs: activeTool ? Math.max(0, now - activeTool.startedAt) : undefined,
    activeToolDeadlineAtMs: activeTool?.deadlineAtMs,
    lastProgressAgeMs: Math.max(0, now - churnProgress.lastProgressAt),
    lastProgressReason: churnProgress.lastProgressReason,
    repeatedRequestNoProgressAgeMs: resolveRepeatedRequestNoProgressAgeMs(
      activity,
      activity.activeEmbeddedRuns.values(),
      now,
    ),
    activeModelCallRequestTimeoutMs,
    ...(hasActiveOutstandingBackgroundWork(activity) ? { hasOutstandingBackgroundWork: true } : {}),
  };
}

// Quiet-but-alive tools are normal agent behavior; the CLI byte watchdog kills
// truly silent children within its own deadline. This floor bounds every
// staleness consumer (diagnostic recovery aborts, reply-run stale takeover,
// steer gates): lowering it reopens #88870, removing it reopens #96168.
export const BLOCKED_TOOL_CALL_ABORT_FLOOR_MS = 15 * 60_000;

// Default quiet-run reclaim window for steer/takeover. Evidence clocks stay local.
export const RUN_STALE_TAKEOVER_MS = 10 * 60_000;

// Quiet-but-alive tool phases get the blocked-tool floor so a human message
// cannot reclaim a healthy long tool that stuck recovery would not touch yet.
export function resolveRunStaleThresholdMs(
  activity: Pick<
    DiagnosticSessionActivitySnapshot,
    "activeWorkKind" | "activeToolDeadlineAtMs" | "lastProgressAgeMs"
  >,
  evidenceAgeMs = activity.lastProgressAgeMs ?? 0,
): number {
  if (activity.activeToolDeadlineAtMs !== undefined) {
    // Use the same age the caller compares: subtracting it leaves only the
    // absolute deadline, even when reply activity and tool progress differ.
    return Math.max(0, evidenceAgeMs + activity.activeToolDeadlineAtMs - Date.now());
  }
  return activity.activeWorkKind === "tool_call"
    ? Math.max(RUN_STALE_TAKEOVER_MS, BLOCKED_TOOL_CALL_ABORT_FLOOR_MS)
    : RUN_STALE_TAKEOVER_MS;
}
