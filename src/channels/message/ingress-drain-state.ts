import type { ChannelIngressQueueClaim, ChannelIngressQueueRecord } from "./ingress-queue.js";
import {
  resolveIngressRetryDelayMs,
  type IngressRetryPolicyConfig,
} from "./ingress-retry-policy.js";

export class IngressAdoptionLostError extends Error {
  readonly code: "guillotined" | "superseded" | "reclaimed";

  constructor(code: "guillotined" | "superseded" | "reclaimed") {
    super(`ingress adoption lost: ${code}`);
    this.name = "IngressAdoptionLostError";
    this.code = code;
  }
}

export function isIngressAdoptionLostError(error: unknown): error is IngressAdoptionLostError {
  return error instanceof IngressAdoptionLostError;
}

export type ChannelIngressDrainDispatchResult =
  | { kind: "completed" }
  | { kind: "deferred" }
  | { kind: "failed-retryable"; error: unknown };

export type ActiveHandlerState<TPayload, TMetadata> = {
  eventId: string;
  laneKey: string;
  claim: ChannelIngressQueueClaim<TPayload, TMetadata>;
  abortController: AbortController;
  startedAt: number;
  phase: "dispatching" | "deferred" | "adopted" | "settled";
  occupiesLane: boolean;
  task: Promise<void>;
  stallTimer?: ReturnType<typeof setTimeout>;
  claimRefreshTimer?: ReturnType<typeof setInterval>;
  /** Closed code: pre-adoption stall watchdog has claimed settle ownership. */
  guillotined: boolean;
  /** Closed code: pre-adoption supersede has claimed settle ownership. */
  superseded: boolean;
  /** Single settle owner for complete / fail / release / supersede / guillotine. */
  settleOnce: (fn: () => Promise<void>) => Promise<void>;
};

export function activeClaimKey<TPayload, TMetadata>(
  claim: ChannelIngressQueueClaim<TPayload, TMetadata>,
): string {
  return `${claim.id}\0${claim.claim.token}`;
}

export function resolveLaneKey<TPayload, TMetadata>(
  record: ChannelIngressQueueRecord<TPayload, TMetadata>,
  deriveLaneKey?: (record: ChannelIngressQueueRecord<TPayload, TMetadata>) => string | undefined,
  reconcileStoredLaneKey?: (
    record: ChannelIngressQueueRecord<TPayload, TMetadata>,
    storedLaneKey: string,
    derivedLaneKey: string,
  ) => boolean,
): string {
  const derivedLaneKey = deriveLaneKey?.(record);
  const storedLaneKey = record.laneKey;
  if (
    !reconcileStoredLaneKey ||
    storedLaneKey === undefined ||
    derivedLaneKey === undefined ||
    storedLaneKey === derivedLaneKey
  ) {
    return derivedLaneKey ?? storedLaneKey ?? record.id;
  }
  return reconcileStoredLaneKey(record, storedLaneKey, derivedLaneKey)
    ? derivedLaneKey
    : storedLaneKey;
}

export function sortedKeys(keys: Iterable<string>): string[] {
  return [...keys].toSorted((a, b) => a.localeCompare(b));
}

type ResolveIngressDrainLaneStateParams<TPayload, TMetadata> = {
  pending: Array<ChannelIngressQueueRecord<TPayload, TMetadata>>;
  claims: Array<ChannelIngressQueueClaim<TPayload, TMetadata>>;
  activeByClaim: ReadonlyMap<string, ActiveHandlerState<TPayload, TMetadata>>;
  retryPolicy: IngressRetryPolicyConfig | undefined;
  now: number;
  resolveLaneKey: (record: ChannelIngressQueueRecord<TPayload, TMetadata>) => string;
};

export function resolveIngressDrainLaneState<TPayload, TMetadata>(
  params: ResolveIngressDrainLaneStateParams<TPayload, TMetadata>,
) {
  const claimedLaneKeys = new Set(
    params.claims
      .filter((claim) => {
        const state = params.activeByClaim.get(activeClaimKey(claim));
        return !(
          state?.phase === "deferred" &&
          !state.occupiesLane &&
          !state.guillotined &&
          !state.superseded
        );
      })
      .map(params.resolveLaneKey),
  );
  const eligiblePending: Array<ChannelIngressQueueRecord<TPayload, TMetadata>> = [];
  const oldestRetainedPendingLaneKeys = new Set<string>();
  const retryDelayedLaneKeys = new Set<string>();
  for (const event of params.pending) {
    const retryDelayMs = resolveIngressRetryDelayMs(event, params.retryPolicy, params.now);
    if (retryDelayMs === 0) {
      eligiblePending.push(event);
    }
    const laneKey = params.resolveLaneKey(event);
    if (oldestRetainedPendingLaneKeys.has(laneKey)) {
      continue;
    }
    oldestRetainedPendingLaneKeys.add(laneKey);
    // Only the oldest retained row can block its lane for retry backoff. A
    // delayed tail must not hide an eligible head from claimNext.
    if (retryDelayMs > 0) {
      retryDelayedLaneKeys.add(laneKey);
    }
  }

  return {
    eligiblePending,
    claimedLaneKeys,
    retryDelayedLaneKeys,
  };
}
