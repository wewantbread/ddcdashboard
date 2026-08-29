// Partial-failure types and serialization for sessions cleanup.
// Split from cleanup-service.ts to keep that module under the oxlint max-lines budget.

import type {
  ResolvedSessionMaintenanceConfig,
  SessionCleanupSummary,
  SessionsCleanupResult,
} from "./cleanup-service.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";
import type { SessionStoreTarget } from "./targets.js";

export type SessionsCleanupPartialErrorDetail = {
  failingAgentId: string;
  failingStorePath: string;
  message: string;
  lifecycleCommitted?: boolean;
};

/**
 * Thrown when `sessions.cleanup` applies some stores but a later target fails
 * after its lifecycle mutation committed. Carries the already-applied summaries
 * so callers can render the partial result instead of a silent success.
 */
export class SessionsCleanupPartialError extends Error {
  readonly mode: ResolvedSessionMaintenanceConfig["mode"];
  readonly previewResults: Array<{
    summary: SessionCleanupSummary;
    beforeStore: Record<string, unknown>;
    missingKeys: Set<string>;
    modelRunPrunedKeys: Set<string>;
    archivedKeys?: Set<string>;
    staleKeys: Set<string>;
    cappedKeys: Set<string>;
    dmScopeRetiredKeys: Set<string>;
  }>;
  readonly appliedSummaries: SessionCleanupSummary[];
  readonly failingTarget: SessionStoreTarget;
  readonly lifecycleCommitted: boolean;

  constructor(params: {
    mode: ResolvedSessionMaintenanceConfig["mode"];
    previewResults: SessionsCleanupPartialError["previewResults"];
    appliedSummaries: SessionCleanupSummary[];
    failingTarget: SessionStoreTarget;
    cause: unknown;
    lifecycleCommitted?: boolean;
  }) {
    const causeMessage =
      params.cause instanceof Error ? params.cause.message : String(params.cause);
    super(
      `Session cleanup failed for target agent '${params.failingTarget.agentId}': ${causeMessage}`,
      { cause: params.cause },
    );
    this.name = "SessionsCleanupPartialError";
    this.mode = params.mode;
    this.previewResults = params.previewResults;
    this.appliedSummaries = params.appliedSummaries;
    this.failingTarget = params.failingTarget;
    this.lifecycleCommitted = Boolean(params.lifecycleCommitted);
  }
}

export function serializeSessionCleanupResult(params: {
  mode: ResolvedSessionMaintenanceConfig["mode"];
  dryRun: boolean;
  summaries: SessionCleanupSummary[];
  partialError?: SessionsCleanupPartialErrorDetail;
}): SessionsCleanupResult {
  const summaries = params.summaries.map((summary) => ({
    ...summary,
    storePath: resolveSqliteTargetFromSessionStorePath(summary.storePath, {
      agentId: summary.agentId,
    }).path,
  }));
  if (summaries.length === 1 && !params.partialError) {
    const single = summaries[0];
    if (single) {
      return single;
    }
  }
  return {
    allAgents: true,
    mode: params.mode,
    dryRun: params.dryRun,
    stores: summaries,
    ...(params.partialError
      ? {
          partialError: {
            failingAgentId: params.partialError.failingAgentId,
            failingStorePath: resolveSqliteTargetFromSessionStorePath(
              params.partialError.failingStorePath,
              { agentId: params.partialError.failingAgentId },
            ).path,
            message: params.partialError.message,
            ...(params.partialError.lifecycleCommitted !== undefined
              ? { lifecycleCommitted: params.partialError.lifecycleCommitted }
              : {}),
          },
        }
      : {}),
  };
}

/** Builds the serialized partial-cleanup result for a thrown SessionsCleanupPartialError. */
export function buildSessionsCleanupPartialResult(
  error: SessionsCleanupPartialError,
): SessionsCleanupResult {
  return serializeSessionCleanupResult({
    mode: error.mode,
    dryRun: false,
    summaries: error.appliedSummaries,
    partialError: {
      failingAgentId: error.failingTarget.agentId,
      failingStorePath: error.failingTarget.storePath,
      message: error.message,
      lifecycleCommitted: error.lifecycleCommitted,
    },
  });
}
