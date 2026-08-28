import { AsyncLocalStorage } from "node:async_hooks";
import type { ActiveHandlerState } from "./ingress-drain-state.js";

const ingressCancelCompat = new AsyncLocalStorage<true>();

/**
 * Fan-in cancel falls back to `onAbandoned` for sources that predate
 * `onCancelled`. That invocation is still cancellation: it must not consume
 * retry budget. Genuine `onAbandoned()` callers leave this store unset.
 */
export function runIngressCancelCompat<T>(fn: () => T): T {
  return ingressCancelCompat.run(true, fn);
}

export function isIngressCancelCompat(): boolean {
  return ingressCancelCompat.getStore() === true;
}

export function createIngressSettleOwner<TPayload, TMetadata>(
  state: ActiveHandlerState<TPayload, TMetadata>,
  removeActive: (state: ActiveHandlerState<TPayload, TMetadata>) => void,
): (fn: () => Promise<void>) => Promise<void> {
  let settlePromise: Promise<void> | undefined;
  let settled = false;
  return async (fn) => {
    if (settled) {
      return;
    }
    if (settlePromise) {
      await settlePromise;
      return;
    }
    settlePromise = (async () => {
      // Only mark settled after the tombstone/fail/release write commits.
      // Write failure must keep heartbeat + in-memory ownership (wedged > duplicated).
      await fn();
      settled = true;
      state.phase = "settled";
      removeActive(state);
    })();
    try {
      await settlePromise;
    } catch (err) {
      settlePromise = undefined;
      throw err;
    }
  };
}

/** Full pre-adoption -> adoption ownership lifecycle for one claimed event. */
export type ChannelIngressDispatchLifecycle = {
  /** Pre-adoption only. After adopt the drain treats this signal as inert. */
  abortSignal: AbortSignal;
  /**
   * Fires when recovery-relevant session/run state is durable.
   * Drain completes (tombstones) the claim here -- never at settle.
   */
  onAdopted: () => void | Promise<void>;
  /**
   * Turn ownership deferred to reply-lane admission (queued followup).
   * Claim remains held until adopted or abandoned.
   */
  onDeferred: () => void;
  /**
   * Durable adoption finalization is in progress (e.g. settlement hold while
   * committing dedupe). Clears the pre-adoption stall watchdog so a timeout
   * settlement cannot race and dead-letter an about-to-complete claim.
   * Claim stays held until onAdopted / onAbandoned / fail.
   */
  onAdoptionFinalizing: () => void;
  /** Deferred work terminally failed after dispatch returned. */
  onFailed?: (error: unknown) => void | Promise<void>;
  /** Explicit cancellation before adoption; releases without consuming retry budget. */
  onCancelled?: () => void | Promise<void>;
  /**
   * Deferred turn finished without ever owning the reply lane.
   * Drain applies the bounded retry disposition unless the call is
   * fan-in cancel-compat (see `runIngressCancelCompat`).
   */
  onAbandoned: () => void | Promise<void>;
};

/** Maps a drain lifecycle onto the reply-lane ownership surface. */
export function bindIngressLifecycleToReplyOptions(lifecycle: ChannelIngressDispatchLifecycle): {
  turnAdoptionLifecycle: {
    admission: "exclusive";
    onAdopted: () => void | Promise<void>;
    onDeferred: () => void;
    onCancelled?: () => void | Promise<void>;
    onAbandoned: () => void | Promise<void>;
    abortSignal: AbortSignal;
  };
} {
  return {
    turnAdoptionLifecycle: {
      admission: "exclusive",
      onAdopted: lifecycle.onAdopted,
      onDeferred: lifecycle.onDeferred,
      // Debounce/fan-in cancel uses this object. Omitting onCancelled made
      // cancel fall back to onAbandoned and charge the retry budget.
      ...(lifecycle.onCancelled ? { onCancelled: lifecycle.onCancelled } : {}),
      onAbandoned: lifecycle.onAbandoned,
      abortSignal: lifecycle.abortSignal,
    },
  };
}

// onAdoptionFinalizing stays drain-only (not reply-options); channels call it
// via the spooled-replay ALS lifecycle frame during settlement hold.
