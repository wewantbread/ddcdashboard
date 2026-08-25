import { describe, expect, it } from "vitest";
import { buildCodexConversationTurnInput } from "./conversation-turn-input.js";

describe("codex conversation turn input cache stability", () => {
  it("uses canonical ordered media instead of deprecated compacted aliases", () => {
    expect(
      buildCodexConversationTurnInput({
        prompt: "compare these",
        event: {
          content: "compare these",
          channel: "discord",
          isGroup: false,
          media: [
            {
              url: "https://example.test/remote.webp",
              contentType: "image/webp",
              kind: "image",
            },
            {
              path: "/tmp/local.png",
              url: "https://example.test/local.png",
              contentType: "image/png",
              kind: "image",
            },
          ],
          metadata: {
            // These deprecated projections are intentionally compacted and therefore
            // misaligned by index for this mixed remote/local attachment sequence.
            mediaPaths: ["/tmp/local.png"],
            mediaPath: "/tmp/local.png",
            mediaUrls: [
              "https://example.test/remote.webp",
              "https://example.test/local.png",
            ],
            mediaUrl: "https://example.test/remote.webp",
            mediaTypes: ["image/webp", "image/png"],
            mediaType: "image/webp",
          },
        },
      }),
    ).toEqual([
      { type: "text", text: "compare these", text_elements: [] },
      { type: "image", url: "https://example.test/remote.webp" },
      { type: "localImage", path: "/tmp/local.png" },
    ]);
  });

  it("preserves genuinely distinct ordered images", () => {
    expect(
      buildCodexConversationTurnInput({
        prompt: "compare these",
        event: {
          content: "compare these",
          channel: "discord",
          isGroup: false,
          media: [
            { path: "/tmp/first.png", contentType: "image/png", kind: "image" },
            { path: "/tmp/second.png", contentType: "image/png", kind: "image" },
          ],
        },
      }),
    ).toEqual([
      { type: "text", text: "compare these", text_elements: [] },
      { type: "localImage", path: "/tmp/first.png" },
      { type: "localImage", path: "/tmp/second.png" },
    ]);
  });

  it("honors canonical image kind when mime and extension are unavailable", () => {
    expect(
      buildCodexConversationTurnInput({
        prompt: "inspect attachment",
        event: {
          content: "inspect attachment",
          channel: "discord",
          isGroup: false,
          media: [{ url: "https://example.test/opaque?id=42", kind: "image" }],
        },
      }),
    ).toEqual([
      { type: "text", text: "inspect attachment", text_elements: [] },
      { type: "image", url: "https://example.test/opaque?id=42" },
    ]);
  });
});