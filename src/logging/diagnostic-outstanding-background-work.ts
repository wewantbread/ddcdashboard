// Outstanding CLI background-work facts certify that a run is alive while its
// parent stream is quiet (#118386). The CLI host records the absolute count
// from background_tasks_changed events; stuck-session recovery grants the
// quiet-work floor while any fact is outstanding, and every terminal lifecycle
// path clears it. Facts never touch the progress clock, so genuinely wedged
// runs still recover once the floor expires.
//
// Facts carry exact owner-lifetime identity: they are keyed by the embedded
// owner generation that was active when recorded (falling back to the runId
// when the run has no registered owner). A same-ID replacement therefore can
// neither revive a departed run's fact nor be erased by the departed
// iterator's delayed terminal clear.

export type DiagnosticOutstandingBackgroundWorkActivity = {
  outstandingBackgroundWork: Map<unknown, { runId: string; count: number }>;
  activeEmbeddedRuns: ReadonlyMap<string, { runId?: string; generation?: unknown }>;
};

export type DiagnosticOutstandingBackgroundWorkReport = {
  runId: string;
  sessionId?: string;
  sessionKey?: string;
  count: number;
  /** Lifetime token returned by an earlier report; keeps the exact owner. */
  lifetime?: unknown;
};

type SessionActivityResolver = (params: {
  runId?: string;
  sessionId?: string;
  sessionKey?: string;
  create?: boolean;
}) => DiagnosticOutstandingBackgroundWorkActivity | undefined;

let resolveSessionActivityForBackgroundWork: SessionActivityResolver | undefined;

/** Wired once by the run-activity registry so facts land on session activity. */
export function bindDiagnosticOutstandingBackgroundWorkResolver(
  resolver: SessionActivityResolver | undefined,
): void {
  resolveSessionActivityForBackgroundWork = resolver;
}

function resolveOutstandingBackgroundWorkLifetime(
  activity: DiagnosticOutstandingBackgroundWorkActivity,
  runId: string,
): unknown {
  for (const run of activity.activeEmbeddedRuns.values()) {
    if (run.runId === runId && run.generation !== undefined) {
      return run.generation;
    }
  }
  return runId;
}

function currentOutstandingBackgroundWorkGeneration(
  activity: DiagnosticOutstandingBackgroundWorkActivity,
  runId: string,
): unknown {
  for (const run of activity.activeEmbeddedRuns.values()) {
    if (run.runId === runId) {
      return run.generation;
    }
  }
  return undefined;
}

/**
 * Records the CLI host's authoritative outstanding-background-work count for
 * one run and returns the lifetime token the caller must reuse for clears.
 * Events carry the absolute task list, so the count is set, not accumulated;
 * a count of zero clears the fact.
 */
export function markDiagnosticOutstandingBackgroundWork(
  params: DiagnosticOutstandingBackgroundWorkReport,
): unknown {
  const runId = params.runId.trim();
  if (!runId) {
    return undefined;
  }
  const activity = resolveSessionActivityForBackgroundWork?.({
    runId,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    create: params.count > 0,
  });
  if (!activity) {
    return undefined;
  }
  if (params.count > 0) {
    const lifetime = params.lifetime ?? resolveOutstandingBackgroundWorkLifetime(activity, runId);
    activity.outstandingBackgroundWork.set(lifetime, { runId, count: params.count });
    return lifetime;
  }
  if (params.lifetime !== undefined) {
    activity.outstandingBackgroundWork.delete(params.lifetime);
    return params.lifetime;
  }
  clearOutstandingBackgroundWorkForRun(activity, runId);
  return undefined;
}

/**
 * Clears a run's facts from departed lifetimes only: a same-ID replacement's
 * current-owner fact must survive an older run's terminal event.
 */
export function clearOutstandingBackgroundWorkForRun(
  activity: DiagnosticOutstandingBackgroundWorkActivity,
  runId: string,
): void {
  const currentGeneration = currentOutstandingBackgroundWorkGeneration(activity, runId);
  for (const [lifetime, fact] of activity.outstandingBackgroundWork) {
    if (fact.runId !== runId) {
      continue;
    }
    if (lifetime === runId || lifetime !== currentGeneration) {
      activity.outstandingBackgroundWork.delete(lifetime);
    }
  }
}

/** Removes one exact lifetime's fact (owner teardown). */
export function deleteOutstandingBackgroundWork(
  activity: DiagnosticOutstandingBackgroundWorkActivity,
  lifetime: unknown,
): boolean {
  return activity.outstandingBackgroundWork.delete(lifetime);
}

/** Clears every fact; returns whether any were present. */
export function clearOutstandingBackgroundWork(
  activity: DiagnosticOutstandingBackgroundWorkActivity,
): boolean {
  const hadOutstandingBackgroundWork = activity.outstandingBackgroundWork.size > 0;
  activity.outstandingBackgroundWork.clear();
  return hadOutstandingBackgroundWork;
}

export function mergeOutstandingBackgroundWork(
  target: DiagnosticOutstandingBackgroundWorkActivity,
  source: DiagnosticOutstandingBackgroundWorkActivity,
): void {
  for (const [lifetime, fact] of source.outstandingBackgroundWork) {
    target.outstandingBackgroundWork.set(lifetime, fact);
  }
}
