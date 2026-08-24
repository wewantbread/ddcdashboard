/** Decides when cooldowned model candidates may be skipped, probed, or suspended. */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import { isActiveUnusableWindow } from "./auth-profiles/usage-state.js";
import { shouldUseTransientCooldownProbeSlot } from "./failover-policy.js";
import type { FailoverReason } from "./failover/signal.js";
import type { ModelFallbackAuthRuntime } from "./model-fallback-attempt.js";
import type { ModelCandidate } from "./model-fallback.types.js";

const lastProbeAttempt = new Map<string, { ts: number; token: number }>();
const MIN_PROBE_INTERVAL_MS = 30_000; // 30 seconds between probes per key
const PROBE_MARGIN_MS = 2 * 60 * 1000;
const PROBE_SCOPE_DELIMITER = "::";
const PROBE_STATE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_PROBE_KEYS = 256;

export function resolveProbeThrottleKey(provider: string, agentDir?: string): string {
  const scope = normalizeOptionalString(agentDir) ?? "";
  return scope ? `${scope}${PROBE_SCOPE_DELIMITER}${provider}` : provider;
}

function pruneProbeState(now: number): void {
  for (const [key, entry] of lastProbeAttempt) {
    if (!Number.isFinite(entry.ts) || entry.ts <= 0 || now - entry.ts > PROBE_STATE_TTL_MS) {
      lastProbeAttempt.delete(key);
    }
  }
}

function enforceProbeStateCap(): void {
  while (lastProbeAttempt.size > MAX_PROBE_KEYS) {
    let oldestKey: string | null = null;
    let oldestTs = Number.POSITIVE_INFINITY;
    for (const [key, entry] of lastProbeAttempt) {
      if (entry.ts < oldestTs) {
        oldestKey = key;
        oldestTs = entry.ts;
      }
    }
    if (!oldestKey) {
      break;
    }
    lastProbeAttempt.delete(oldestKey);
  }
}

function isProbeThrottleOpen(now: number, throttleKey: string): boolean {
  pruneProbeState(now);
  const lastProbe = lastProbeAttempt.get(throttleKey)?.ts ?? 0;
  return now - lastProbe >= MIN_PROBE_INTERVAL_MS;
}

let probeReservationSeq = 0;

/** Marks the probe throttle and returns a collision-safe reservation token. */
export function markProbeAttempt(now: number, throttleKey: string): number {
  pruneProbeState(now);
  // A monotonic token (not the timestamp) is the release identity: two probes
  // for the same key can share one millisecond, and an older abort must never
  // erase the newer reservation.
  const token = ++probeReservationSeq;
  lastProbeAttempt.set(throttleKey, { ts: now, token });
  enforceProbeStateCap();
  return token;
}

/** Marks the throttle and returns the full release handle for one candidate attempt. */
export function markProbeReservation(
  now: number,
  throttleKey: string,
): { throttleKey: string; token: number } {
  return { throttleKey, token: markProbeAttempt(now, throttleKey) };
}

/**
 * Releases a probe reservation after a local coordination abort so a failure
 * that never reached the provider does not burn the 30s recovery-probe window.
 * Token identity keeps an older release from clearing a newer reservation for
 * the same key, even when both share a timestamp.
 */
export function releaseProbeAttempt(throttleKey: string, token: number): void {
  if (lastProbeAttempt.get(throttleKey)?.token === token) {
    lastProbeAttempt.delete(throttleKey);
  }
}

function hasActiveProviderRateLimitResetWindow(params: {
  authStore: AuthProfileStore;
  profileIds: string[];
  now: number;
  model: string;
}): boolean {
  return params.profileIds.some((profileId) => {
    const stats = params.authStore.usageStats?.[profileId];
    if (!stats || !isActiveUnusableWindow(stats.blockedUntil, params.now)) {
      return false;
    }
    if (stats.blockedReason !== "subscription_limit" || !stats.blockedSource) {
      return false;
    }
    return !stats.blockedModel || stats.blockedModel === params.model;
  });
}

function shouldProbePrimaryDuringCooldown(params: {
  isPrimary: boolean;
  hasFallbackCandidates: boolean;
  reason: FailoverReason | null | undefined;
  now: number;
  throttleKey: string;
  authRuntime: ModelFallbackAuthRuntime;
  authStore: AuthProfileStore;
  profileIds: string[];
  model: string;
}): boolean {
  if (!params.isPrimary || !isProbeThrottleOpen(params.now, params.throttleKey)) {
    return false;
  }

  // A single-provider primary has no fallback chain to prefer, so every open
  // throttle slot is a recovery probe: "is the primary callable yet?" is a
  // recovery question independent of fallback configuration. Without this, a
  // fallbacks:[] setup that hits a rate/subscription cap stays suspended until
  // the provider-reported reset (which can be days out) even though the rolling
  // cap usually recovers earlier. See #90702.
  if (!params.hasFallbackCandidates) {
    return true;
  }

  const soonest = params.authRuntime.getSoonestCooldownExpiry(params.authStore, params.profileIds, {
    now: params.now,
    forModel: params.model,
  });
  // Generic 429 backoff can become stale before its local cooldown expires.
  // Provider-recorded reset windows still remain authoritative until near expiry.
  if (
    params.reason === "rate_limit" &&
    !hasActiveProviderRateLimitResetWindow({
      authStore: params.authStore,
      profileIds: params.profileIds,
      now: params.now,
      model: params.model,
    })
  ) {
    return true;
  }
  if (soonest === null || !Number.isFinite(soonest)) {
    return true;
  }
  // Probe when cooldown already expired or within the configured margin.
  return params.now >= soonest - PROBE_MARGIN_MS;
}

/** @internal – exposed for unit tests only */
export const probeThrottleInternals = {
  lastProbeAttempt,
  MIN_PROBE_INTERVAL_MS,
  PROBE_MARGIN_MS,
  PROBE_STATE_TTL_MS,
  MAX_PROBE_KEYS,
  resolveProbeThrottleKey,
  isProbeThrottleOpen,
  pruneProbeState,
  markProbeAttempt,
  releaseProbeAttempt,
} as const;

type CooldownDecision =
  | { type: "skip"; reason: FailoverReason; error: string }
  | { type: "attempt"; reason: FailoverReason; markProbe: boolean }
  | { type: "suspend_session"; reason: FailoverReason; leaderCandidate?: ModelCandidate };

export function resolveCooldownDecision(params: {
  candidate: ModelCandidate;
  isPrimary: boolean;
  requestedModel: boolean;
  hasFallbackCandidates: boolean;
  now: number;
  probeThrottleKey: string;
  authRuntime: ModelFallbackAuthRuntime;
  authStore: AuthProfileStore;
  profileIds: string[];
}): CooldownDecision {
  const inferredReason =
    params.authRuntime.resolveProfilesUnavailableReason({
      store: params.authStore,
      profileIds: params.profileIds,
      now: params.now,
    }) ?? "unknown";
  const shouldProbe = shouldProbePrimaryDuringCooldown({
    isPrimary: params.isPrimary,
    hasFallbackCandidates: params.hasFallbackCandidates,
    reason: inferredReason,
    now: params.now,
    throttleKey: params.probeThrottleKey,
    authRuntime: params.authRuntime,
    authStore: params.authStore,
    profileIds: params.profileIds,
    model: params.candidate.model,
  });

  const isPersistentAuthIssue = inferredReason === "auth" || inferredReason === "auth_permanent";
  if (isPersistentAuthIssue) {
    return {
      type: "skip",
      reason: inferredReason,
      error: `Provider ${params.candidate.provider} has ${inferredReason} issue (skipping all models)`,
    };
  }

  // Billing is semi-persistent: the user may fix their balance, or a transient
  // 402 might have been misclassified. shouldProbe already re-probes
  // single-provider setups on the throttle (no fallback chain to prefer) and
  // multi-fallback setups near cooldown expiry, so both recover without a restart.
  if (inferredReason === "billing") {
    if (params.isPrimary && shouldProbe) {
      return { type: "attempt", reason: inferredReason, markProbe: true };
    }
    return {
      type: "suspend_session",
      reason: inferredReason,
      leaderCandidate: params.candidate,
    };
  }

  const shouldAttemptDespiteCooldown =
    (params.isPrimary && (!params.requestedModel || shouldProbe)) ||
    (!params.isPrimary && shouldUseTransientCooldownProbeSlot(inferredReason));
  if (!shouldAttemptDespiteCooldown) {
    return {
      type: "suspend_session",
      reason: inferredReason,
      leaderCandidate: params.candidate,
    };
  }
  return {
    type: "attempt",
    reason: inferredReason,
    markProbe: params.isPrimary && shouldProbe,
  };
}
