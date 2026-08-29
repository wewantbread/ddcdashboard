// Partial-failure types and serialization for sessions cleanup.
// Split from cleanup-service.ts to keep that module under the oxlint max-lines budget.

import type {
  SessionDiskBudgetSweepResult,
  SessionUnreferencedArtifactSweepResult,
} from "./disk-budget.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";
import type { ResolvedSessionMaintenanceConfig } from "./store-maintenance.js";
import type { SessionStoreTarget } from "./targets.js";
import type { SessionEntry } from "./types.js";

export type SessionsCleanupPartialErrorDetail = {
  failingAgentId: string;
  failingStorePath: string;
  message: string;
  lifecycleCommitted?: boolean;
};

export type SessionCleanupSummary = {
  agentId: string;
  storePath: string;
  mode: ResolvedSessionMaintenanceConfig["mode"];
  dryRun: boolean;
  beforeCount: number;
  afterCount: number;
  missing: number;
  dmScopeRetired: number;
  modelRunPruned: number;
  archived?: number;
  pruned: number;
  capped: number;
  unreferencedArtifacts: SessionUnreferencedArtifactSweepResult;
  diskBudget: SessionDiskBudgetSweepResult | null;
  wouldMutate: boolean;
  applied?: true;
  appliedCount?: number;
};

export type SessionsCleanupResult =
  | SessionCleanupSummary
  | {
      allAgents: true;
      mode: ResolvedSessionMaintenanceConfig["mode"];
      dryRun: boolean;
      stores: SessionCleanupSummary[];
      partialError?: SessionsCleanupPartialErrorDetail;
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
    beforeStore: Record<string, SessionEntry>;
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
  allAgents: boolean;
  summaries: SessionCleanupSummary[];
  partialError?: SessionsCleanupPartialErrorDetail;
}): SessionsCleanupResult {
  const summaries = params.summaries.map((summary) => ({
    ...summary,
    storePath: resolveSqliteTargetFromSessionStorePath(summary.storePath, {
      agentId: summary.agentId,
    }).path,
  }));
  if (!params.allAgents && summaries.length === 1) {
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
  allAgents: boolean,
): SessionsCleanupResult {
  return serializeSessionCleanupResult({
    mode: error.mode,
    dryRun: false,
    allAgents,
    summaries: error.appliedSummaries,
    partialError: {
      failingAgentId: error.failingTarget.agentId,
      failingStorePath: error.failingTarget.storePath,
      message: error.message,
      lifecycleCommitted: error.lifecycleCommitted,
    },
  });
}

/**
 * Runtime check that an untyped Gateway error `details` is a closed
 * SessionsCleanupResult shape. The gateway-client preserves details as `unknown`,
 * so a nonconforming or older Gateway response must not be rendered as a partial
 * cleanup result; callers fall back to rethrowing the original error.
 */
export function isSessionsCleanupResult(value: unknown): value is SessionsCleanupResult {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (record.allAgents === true) {
    if (
      typeof record.mode !== "string" ||
      typeof record.dryRun !== "boolean" ||
      !Array.isArray(record.stores)
    ) {
      return false;
    }
    if (record.partialError !== undefined) {
      const detail = record.partialError as Record<string, unknown>;
      if (
        typeof detail.failingAgentId !== "string" ||
        typeof detail.failingStorePath !== "string" ||
        typeof detail.message !== "string"
      ) {
        return false;
      }
    }
    return true;
  }
  return (
    typeof record.agentId === "string" &&
    typeof record.storePath === "string" &&
    typeof record.mode === "string"
  );
}
