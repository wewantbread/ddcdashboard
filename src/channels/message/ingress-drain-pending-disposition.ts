import { resolveLaneKey } from "./ingress-drain-state.js";
import type { ChannelIngressQueue, ChannelIngressQueueRecord } from "./ingress-queue.js";

type ChannelIngressPendingDisposition = {
  kind: "fail";
  reason: string;
  message: string;
};

type ChannelIngressPendingDispositionContext = {
  laneKey: string;
  now: number;
};

/**
 * Optional channel policy hook, called once per pending row per drain pass,
 * before any claim. Return a disposition to settle the row terminally instead of
 * dispatching it; return null/undefined to retain it as a normal claim
 * candidate.
 *
 * The record is the row as stored: its payload has not been through the channel
 * payload codec, which runs at claim time. Narrow before reading it and retain
 * anything unreadable so the canonical claim-time invalid-event path owns it.
 * Throwing aborts the whole drain pass, so a corrupt row must never throw here.
 *
 * The commit is CAS-fenced. A concurrent claim can win the race, in which case
 * the row is retained, its lane is blocked for this pass, and no committed
 * callback fires.
 */
export type ResolveChannelIngressPendingDisposition<TPayload, TMetadata> = (
  record: ChannelIngressQueueRecord<TPayload, TMetadata>,
  context: ChannelIngressPendingDispositionContext,
) =>
  | ChannelIngressPendingDisposition
  | null
  | undefined
  | Promise<ChannelIngressPendingDisposition | null | undefined>;

/**
 * Fires only after a disposition was durably committed, exactly once per
 * settled row. Observer failures are reported after the terminal write and
 * cannot affect delivery.
 */
export type OnChannelIngressPendingDispositionCommitted<TPayload, TMetadata> = (
  record: ChannelIngressQueueRecord<TPayload, TMetadata>,
  disposition: ChannelIngressPendingDisposition,
  context: ChannelIngressPendingDispositionContext,
) => void | Promise<void>;

type ApplyPendingDispositionsParams<TPayload, TMetadata, TCompletedMetadata> = {
  pending: Array<ChannelIngressQueueRecord<TPayload, TMetadata>>;
  dispositionNow: number;
  queue: Pick<ChannelIngressQueue<TPayload, TMetadata, TCompletedMetadata>, "fail">;
  resolvePendingDisposition?: ResolveChannelIngressPendingDisposition<TPayload, TMetadata>;
  onPendingDispositionCommitted?: OnChannelIngressPendingDispositionCommitted<TPayload, TMetadata>;
  deriveLaneKey?: (record: ChannelIngressQueueRecord<TPayload, TMetadata>) => string | undefined;
  reconcileStoredLaneKey?: (
    record: ChannelIngressQueueRecord<TPayload, TMetadata>,
    storedLaneKey: string,
    derivedLaneKey: string,
  ) => boolean;
  formatError: (error: unknown) => string;
  log: (message: string) => void;
};

type AppliedIngressPendingDispositions<TPayload, TMetadata> = {
  pending: Array<ChannelIngressQueueRecord<TPayload, TMetadata>>;
  blockedLaneKeys: Set<string>;
};

async function failPendingRecord<TPayload, TMetadata, TCompletedMetadata>(
  queue: Pick<ChannelIngressQueue<TPayload, TMetadata, TCompletedMetadata>, "fail">,
  record: ChannelIngressQueueRecord<TPayload, TMetadata>,
  disposition: ChannelIngressPendingDisposition,
  failedAt: number,
): Promise<boolean> {
  const reason = disposition.reason.trim() || "pending-disposition";
  const message = disposition.message.trim() || reason;
  return await queue.fail(record.id, { reason, message, failedAt });
}

export async function applyIngressPendingDispositions<TPayload, TMetadata, TCompletedMetadata>(
  params: ApplyPendingDispositionsParams<TPayload, TMetadata, TCompletedMetadata>,
): Promise<AppliedIngressPendingDispositions<TPayload, TMetadata>> {
  if (!params.resolvePendingDisposition) {
    return { pending: params.pending, blockedLaneKeys: new Set() };
  }
  const retained: Array<ChannelIngressQueueRecord<TPayload, TMetadata>> = [];
  const blockedLaneKeys = new Set<string>();
  for (const event of params.pending) {
    const laneKey = resolveLaneKey(event, params.deriveLaneKey, params.reconcileStoredLaneKey);
    const disposition = await params.resolvePendingDisposition(event, {
      laneKey,
      now: params.dispositionNow,
    });
    if (!disposition) {
      retained.push(event);
      continue;
    }
    if (disposition.kind === "fail") {
      const failed = await failPendingRecord(
        params.queue,
        event,
        disposition,
        params.dispositionNow,
      );
      if (!failed) {
        params.log(`ingress drain: pending disposition lost race for event ${event.id}`);
        retained.push(event);
        blockedLaneKeys.add(laneKey);
        continue;
      }
      try {
        await params.onPendingDispositionCommitted?.(event, disposition, {
          laneKey,
          now: params.dispositionNow,
        });
      } catch (error) {
        params.log(
          `ingress drain: pending disposition observer failed for event ${event.id}: ${params.formatError(error)}`,
        );
      }
    }
  }
  return { pending: retained, blockedLaneKeys };
}
