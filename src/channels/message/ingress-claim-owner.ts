import {
  createProcessInstanceOwnerId,
  isCanonicalProcessInstanceOwnerId,
  isLiveLocalProcessInstanceOwner,
  processPidFromOwnerId,
  registerLiveProcessInstanceOwner,
  resolveProcessInstanceOwnerStatus,
  type ProcessInstanceOwnerStatusOptions,
} from "../../infra/process-instance-owner.js";
import type { ChannelIngressQueueClaim, ChannelIngressQueueCorruptClaim } from "./ingress-queue.js";

// Liveness default: a claim older than its lease is never live-owner protected,
// so recovery can reclaim it even when the owner process still exists.
export const INGRESS_CLAIM_LEASE_MS = 30 * 60 * 1000;

type IngressClaimOwnerIdentity = {
  processId: string;
  processPid: number;
  claimedAt: number;
};

type IngressClaimLivenessOptions = ProcessInstanceOwnerStatusOptions & {
  maxAgeMs?: number;
  now?: number;
};

export { processPidFromOwnerId };

export function createIngressDrainOwnerId(): string {
  return createProcessInstanceOwnerId();
}

// Preserve the numeric POSIX identity; Windows SDK imports must not launch a process probe.
export const INGRESS_CLAIM_PROCESS_ID = createProcessInstanceOwnerId({
  bindProcessStart: process.platform !== "win32",
});

export function registerLiveIngressDrainInstance(ownerId: string): { release: () => void } {
  return registerLiveProcessInstanceOwner(ownerId);
}

/**
 * True when a same-process drain instance still holds this ownerId.
 * Recovery must not steal claims from a live peer drain on the same queue.
 */
export function isLiveLocalIngressDrainOwner(ownerId: string): boolean {
  return isLiveLocalProcessInstanceOwner(ownerId);
}

function isFreshClaimOwner(
  claim: Pick<IngressClaimOwnerIdentity, "claimedAt">,
  options?: { maxAgeMs?: number; now?: number },
): boolean {
  const now = options?.now ?? Date.now();
  const maxAgeMs = options?.maxAgeMs ?? INGRESS_CLAIM_LEASE_MS;
  return now - claim.claimedAt < maxAgeMs;
}

function isClaimOwnerProcessInstanceProtected(
  claim: Pick<IngressClaimOwnerIdentity, "processId" | "processPid">,
  options?: IngressClaimLivenessOptions,
): boolean {
  const status = resolveProcessInstanceOwnerStatus(claim.processId, {
    ...options,
    pid: claim.processPid,
  });
  const parts = claim.processId.split(":");
  const hasCompatibleShape =
    isCanonicalProcessInstanceOwnerId(claim.processId) ||
    (parts.length === 2 && processPidFromOwnerId(claim.processId) > 0 && Boolean(parts[1]));
  return status === "alive" || (status === "unknown" && hasCompatibleShape);
}

function toOwnerIdentity(claim: { ownerId: string; claimedAt: number }): IngressClaimOwnerIdentity {
  return {
    processId: claim.ownerId,
    processPid: processPidFromOwnerId(claim.ownerId),
    claimedAt: claim.claimedAt,
  };
}

type IngressClaimOwnerSource =
  | { claim?: IngressClaimOwnerIdentity | null }
  | Pick<ChannelIngressQueueClaim<unknown>, "claim">;

function resolveOwnerIdentity(claim: IngressClaimOwnerSource): IngressClaimOwnerIdentity | null {
  const raw = claim.claim;
  if (!raw) {
    return null;
  }
  if ("ownerId" in raw) {
    return toOwnerIdentity(raw);
  }
  return {
    processId: raw.processId,
    processPid: raw.processPid,
    claimedAt: raw.claimedAt,
  };
}

/** True when another live process still holds a fresh claim on this event. */
export function isIngressClaimOwnedByOtherLiveProcess(
  claim: IngressClaimOwnerSource,
  options?: IngressClaimLivenessOptions,
): boolean {
  const owner = resolveOwnerIdentity(claim);
  if (!owner) {
    return false;
  }
  return (
    owner.processId !== INGRESS_CLAIM_PROCESS_ID &&
    owner.processPid !== process.pid &&
    isFreshClaimOwner(owner, options) &&
    isClaimOwnerProcessInstanceProtected(owner, options)
  );
}

/** True when a corrupt claimed row is still live-owned by this or another process. */
export function isIngressCorruptClaimOwnedByOtherLiveProcess(
  claim: ChannelIngressQueueCorruptClaim,
  options?: IngressClaimLivenessOptions,
): boolean {
  const owner = toOwnerIdentity(claim.claim);
  if (owner.processId === INGRESS_CLAIM_PROCESS_ID) {
    return isFreshClaimOwner(owner, options);
  }
  return (
    owner.processPid !== process.pid &&
    isFreshClaimOwner(owner, options) &&
    isClaimOwnerProcessInstanceProtected(owner, options)
  );
}
