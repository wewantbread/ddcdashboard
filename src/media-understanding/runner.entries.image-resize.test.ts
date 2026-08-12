import { describe, expect, it, vi } from "vitest";
import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/types.js";
import type { MediaAttachmentCache } from "./attachments.js";
import type { MediaUnderstandingProvider } from "./types.js";

const mocks = vi.hoisted(() => {
  class MockImageOptimizationLimitError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "ImageOptimizationLimitError";
    }
  }
  return {
    MockImageOptimizationLimitError,
    normalizeImageDescriptionInput: vi.fn(async (params: { buffer: Buffer; mime?: string }) => ({
      buffer: params.buffer,
      mime: params.mime,
    })),
    optimizeImageDescriptionInput: vi.fn(async () => ({
      buffer: Buffer.from("compressed-image"),
      fileName: "phone.jpg",
      mime: "image/jpeg",
    })),
  };
});

vi.mock("./image-input-normalize.js", () => ({
  normalizeImageDescriptionInput: mocks.normalizeImageDescriptionInput,
  optimizeImageDescriptionInput: mocks.optimizeImageDescriptionInput,
  resolveImageDescriptionSourceMaxBytes: (maxBytes: number) => Math.max(maxBytes, 50 * 1024 * 1024),
}));

vi.mock("../media/image-optimization-error.js", () => ({
  ImageOptimizationLimitError: mocks.MockImageOptimizationLimitError,
}));

const { runProviderEntry } = await import("./runner.entries.js");

describe("runProviderEntry image resize boundary", () => {
  it("compresses source bytes before calling a custom provider", async () => {
    const describeImage = vi.fn(async () => ({ text: "described", model: "vision-v1" }));
    const getBuffer = vi.fn(async () => ({
      buffer: Buffer.from("oversized-source"),
      fileName: "phone.jpg",
      mime: "image/jpeg",
      size: 16,
    }));

    await expect(
      runProviderEntry({
        capability: "image",
        entry: { provider: "vision-plugin", model: "vision-v1" },
        cfg: {} as OpenClawConfig,
        ctx: {} as MsgContext,
        attachmentIndex: 0,
        cache: { getBuffer } as unknown as MediaAttachmentCache,
        agentDir: "/tmp/agent",
        providerRegistry: new Map<string, MediaUnderstandingProvider>([
          ["vision-plugin", { id: "vision-plugin", capabilities: ["image"], describeImage }],
        ]),
      }),
    ).resolves.toMatchObject({ text: "described", provider: "vision-plugin" });

    expect(getBuffer).toHaveBeenCalledWith({
      attachmentIndex: 0,
      maxBytes: 50 * 1024 * 1024,
      timeoutMs: 60_000,
    });
    expect(mocks.optimizeImageDescriptionInput).toHaveBeenCalledWith(
      expect.objectContaining({
        buffer: Buffer.from("oversized-source"),
        maxBytes: 10 * 1024 * 1024,
        provider: "vision-plugin",
        model: "vision-v1",
      }),
    );
    expect(describeImage).toHaveBeenCalledWith(
      expect.objectContaining({
        buffer: Buffer.from("compressed-image"),
        fileName: "phone.jpg",
        mime: "image/jpeg",
      }),
    );
  });

  it("maps an irreducible image back to the existing maxBytes skip", async () => {
    mocks.optimizeImageDescriptionInput.mockRejectedValueOnce(
      new mocks.MockImageOptimizationLimitError("Image exceeds maxBytes 10485760"),
    );
    const describeImage = vi.fn();

    await expect(
      runProviderEntry({
        capability: "image",
        entry: { provider: "vision-plugin", model: "vision-v1" },
        cfg: {} as OpenClawConfig,
        ctx: {} as MsgContext,
        attachmentIndex: 0,
        cache: {
          getBuffer: vi.fn(async () => ({
            buffer: Buffer.from("oversized-source"),
            fileName: "phone.jpg",
            mime: "image/jpeg",
            size: 16,
          })),
        } as unknown as MediaAttachmentCache,
        agentDir: "/tmp/agent",
        providerRegistry: new Map<string, MediaUnderstandingProvider>([
          ["vision-plugin", { id: "vision-plugin", capabilities: ["image"], describeImage }],
        ]),
      }),
    ).rejects.toMatchObject({
      name: "MediaUnderstandingSkipError",
      reason: "maxBytes",
      message: "Attachment 1 exceeds maxBytes 10485760",
    });
    expect(describeImage).not.toHaveBeenCalled();
  });
});
