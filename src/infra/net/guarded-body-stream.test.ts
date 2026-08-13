import { describe, expect, it, vi } from "vitest";
import { wrapGuardedBodyStream } from "./guarded-body-stream.js";

describe("wrapGuardedBodyStream", () => {
  it("releases the source reader lock after downstream cancellation", async () => {
    const cancel = vi.fn();
    const cleanup = vi.fn();
    const source = new ReadableStream<Uint8Array>({ cancel });
    const wrapped = wrapGuardedBodyStream({ body: source, cleanup });

    expect(source.locked).toBe(true);
    await wrapped.cancel("consumer stopped");

    expect(cancel).toHaveBeenCalledExactlyOnceWith("consumer stopped");
    expect(cleanup).toHaveBeenCalledOnce();
    expect(source.locked).toBe(false);
  });

  it("propagates downstream cancellation failure after releasing resources", async () => {
    const expected = new Error("source cancellation failed");
    const cleanup = vi.fn();
    const source = new ReadableStream<Uint8Array>({
      async cancel() {
        throw expected;
      },
    });
    const wrapped = wrapGuardedBodyStream({ body: source, cleanup });

    await expect(wrapped.cancel("consumer stopped")).rejects.toBe(expected);

    expect(cleanup).toHaveBeenCalledOnce();
    expect(source.locked).toBe(false);
  });

  it("releases the source reader lock after normal completion", async () => {
    const cleanup = vi.fn();
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("done"));
        controller.close();
      },
    });
    const wrapped = wrapGuardedBodyStream({ body: source, cleanup });
    const reader = wrapped.getReader();

    const chunk = await reader.read();
    expect(new TextDecoder().decode(chunk.value)).toBe("done");
    await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
    reader.releaseLock();

    expect(cleanup).toHaveBeenCalledOnce();
    expect(source.locked).toBe(false);
  });

  it("releases the source reader lock while preserving a read failure", async () => {
    const expected = new Error("source read failed");
    const cleanup = vi.fn();
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(expected);
      },
    });
    const wrapped = wrapGuardedBodyStream({ body: source, cleanup });
    const reader = wrapped.getReader();

    await expect(reader.read()).rejects.toBe(expected);
    reader.releaseLock();

    expect(cleanup).toHaveBeenCalledOnce();
    expect(source.locked).toBe(false);
  });

  it("errors and cleans up when maxBytes is exceeded without enqueueing the overflowing chunk", async () => {
    const cleanup = vi.fn();
    const encoder = new TextEncoder();
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("12345"));
        controller.enqueue(encoder.encode("67890"));
        controller.close();
      },
    });
    const limitError = new Error("too big");
    const wrapped = wrapGuardedBodyStream({
      body: source,
      cleanup,
      maxBytes: 8,
      limitError: () => limitError,
    });
    const reader = wrapped.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe("12345");
    await expect(reader.read()).rejects.toBe(limitError);
    reader.releaseLock();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(source.locked).toBe(false);
  });
});
