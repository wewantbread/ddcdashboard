import { describe, expect, it, vi } from "vitest";
import { createSolidPngBuffer } from "../../test/helpers/image-fixtures.js";
import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/types.js";
import { readImageMetadataFromHeader } from "../media/media-services.js";
import type { MediaAttachmentCache } from "./attachments.js";
import type { ImageDescriptionRequest, MediaUnderstandingProvider } from "./types.js";

vi.mock("../agents/image-compression-policy.js", () => ({
  resolveImageCompressionModelPolicy: vi.fn(async () => ({
    maxSidePx: 1600,
    preferredSidePx: 1600,
  })),
}));

const { runProviderEntry } = await import("./runner.entries.js");

describe("runProviderEntry image resize boundary", () => {
  it.each([
    { quality: "high" as const, expectedSide: 1600 },
    { quality: "efficient" as const, expectedSide: 1280 },
  ])(
    "applies $quality quality before calling a custom provider",
    async ({ quality, expectedSide }) => {
      const source = createSolidPngBuffer(1600, 1200, { r: 24, g: 96, b: 208 });
      const observedDimensions: Array<{ width: number; height: number }> = [];
      const describeImage = vi.fn(async (request: ImageDescriptionRequest) => {
        const dimensions = readImageMetadataFromHeader(request.buffer);
        if (!dimensions) {
          throw new Error("provider received undecodable image bytes");
        }
        observedDimensions.push(dimensions);
        return { text: "described", model: "vision-v1" };
      });
      const getBuffer = vi.fn(async () => ({
        buffer: source,
        fileName: "phone.png",
        mime: "image/png",
        size: source.length,
      }));
      const cfg = { agents: { defaults: { imageQuality: quality } } } as OpenClawConfig;

      await expect(
        runProviderEntry({
          capability: "image",
          entry: { provider: "vision-plugin", model: "vision-v1" },
          cfg,
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
      expect(describeImage).toHaveBeenCalledWith(
        expect.objectContaining({
          fileName: expect.stringMatching(/^phone\.(png|jpg)$/),
          provider: "vision-plugin",
          model: "vision-v1",
        }),
      );
      expect(observedDimensions).toEqual([
        expectedSide === 1600 ? { width: 1600, height: 1200 } : { width: 1280, height: 960 },
      ]);
    },
  );

  it("maps an irreducible image back to the existing maxBytes skip", async () => {
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
            buffer: Buffer.alloc(10 * 1024 * 1024 + 1),
            fileName: "phone.custom",
            mime: "image/x-custom",
            size: 10 * 1024 * 1024 + 1,
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
