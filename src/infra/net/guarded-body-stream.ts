/**
 * Shared body-stream cleanup for guarded fetch consumers (`fetchWithSsrFGuard`
 * callers that re-wrap streaming responses).
 */

// Catches wrapper bodies abandoned without cancel/consume so guarded dispatchers
// (and caller resources hooked into `cleanup`) do not leak with the stream.
const guardedBodyCleanupRegistry = new FinalizationRegistry<{ finalize: () => Promise<void> }>(
  (held) => {
    void held.finalize();
  },
);

/**
 * Wraps a guarded response body so caller cleanup runs exactly once when the
 * stream completes, errors, is cancelled, or is garbage-collected unconsumed.
 * Cleanup failures are swallowed: releasing guard resources must never break
 * response consumption.
 */
export function wrapGuardedBodyStream(params: {
  body: ReadableStream<Uint8Array>;
  cleanup: () => Promise<void> | void;
  refreshTimeout?: () => void;
  /**
   * Optional hard cap on total body bytes. When exceeded, the source is
   * cancelled, cleanup runs, and the consumer sees `limitError` (or a
   * default overflow Error). Chunks that would cross the cap are not enqueued.
   */
  maxBytes?: number;
  /** Factory for the error surfaced when `maxBytes` is exceeded. */
  limitError?: () => Error;
}): ReadableStream<Uint8Array> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let finalized = false;
  let receivedBytes = 0;
  const maxBytes =
    params.maxBytes !== undefined && Number.isFinite(params.maxBytes) && params.maxBytes > 0
      ? Math.floor(params.maxBytes)
      : undefined;
  const cleanupRegistrationToken = {};
  const finalize = async (
    cancelReader: () => Promise<void> = async () => {
      await reader?.cancel().catch(() => undefined);
    },
  ) => {
    if (finalized) {
      return;
    }
    finalized = true;
    guardedBodyCleanupRegistry.unregister(cleanupRegistrationToken);
    try {
      await cancelReader();
    } finally {
      try {
        reader?.releaseLock();
      } finally {
        try {
          await params.cleanup();
        } catch {
          // Best effort: guard cleanup must not surface into stream consumers.
        }
      }
    }
  };
  const wrappedBody = new ReadableStream<Uint8Array>({
    start() {
      reader = params.body.getReader();
    },
    async pull(controller) {
      try {
        const chunk = await reader?.read();
        if (!chunk || chunk.done) {
          controller.close();
          await finalize();
          return;
        }
        if (maxBytes !== undefined) {
          receivedBytes += chunk.value.byteLength;
          if (receivedBytes > maxBytes) {
            const error =
              params.limitError?.() ?? new Error(`Response body exceeds ${maxBytes} bytes`);
            controller.error(error);
            await finalize();
            return;
          }
        }
        params.refreshTimeout?.();
        controller.enqueue(chunk.value);
      } catch (error) {
        controller.error(error);
        await finalize();
      }
    },
    async cancel(reason) {
      await finalize(async () => await reader?.cancel(reason));
    },
  });
  guardedBodyCleanupRegistry.register(wrappedBody, { finalize }, cleanupRegistrationToken);
  return wrappedBody;
}
