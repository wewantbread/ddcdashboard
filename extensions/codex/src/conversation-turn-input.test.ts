// Codex tests cover conversation turn input plugin behavior.
import { describe, expect, it } from "vitest";
import { buildCodexConversationTurnInput } from "./conversation-turn-input.js";

describe("codex conversation turn input", () => {
  it("forwards inbound image attachments to Codex app-server", () => {
    expect(
      buildCodexConversationTurnInput({
        prompt: "what is this?",
        event: {
          content: "what is this?",
          channel: "telegram",
          isGroup: false,
          media: [
            {
              path: "/tmp/photo.png",
              url: "https://example.test/photo.png",
              contentType: "image/png",
              kind: "image",
            },
            {
              path: "/tmp/readme.txt",
              contentType: "text/plain",
              kind: "document",
            },
          ],
        },
      }),
    ).toEqual([
      { type: "text", text: "what is this?", text_elements: [] },
      { type: "localImage", path: "/tmp/photo.png" },
    ]);
  });

  it("uses staged remote-cache paths for remote iMessage image attachments", () => {
    const rawPath = "/Users/demo/Library/Messages/Attachments/ab/cd/photo.jpg";
    const stagedPath = "/tmp/openclaw-proof/.openclaw/media/remote-cache/imessage/photo.jpg";

    const input = buildCodexConversationTurnInput({
      prompt: "what is this?",
      event: {
        content: "what is this?",
        channel: "imessage",
        isGroup: false,
        media: [{ path: stagedPath, contentType: "image/jpeg", kind: "image" }],
        originalMedia: [{ path: rawPath, contentType: "image/jpeg", kind: "image" }],
      },
    });

    expect(input).toEqual([
      { type: "text", text: "what is this?", text_elements: [] },
      { type: "localImage", path: stagedPath },
    ]);
    expect(input).not.toContainEqual({ type: "localImage", path: rawPath });
  });

  it("uses remote image urls when no local path is available", () => {
    expect(
      buildCodexConversationTurnInput({
        prompt: "look",
        event: {
          content: "look",
          channel: "webchat",
          isGroup: false,
          media: [{ url: "https://example.test/photo.webp?sig=1", kind: "image" }],
        },
      }),
    ).toEqual([
      { type: "text", text: "look", text_elements: [] },
      { type: "image", url: "https://example.test/photo.webp?sig=1" },
    ]);
  });

  it("keeps protocol-relative image urls remote", () => {
    expect(
      buildCodexConversationTurnInput({
        prompt: "look",
        event: {
          content: "look",
          channel: "webchat",
          isGroup: false,
          media: [{ url: "//cdn.example.test/photo.webp", kind: "image" }],
        },
      }),
    ).toEqual([
      { type: "text", text: "look", text_elements: [] },
      { type: "image", url: "//cdn.example.test/photo.webp" },
    ]);
  });

  it("decodes local file URLs for Codex local image input", () => {
    expect(
      buildCodexConversationTurnInput({
        prompt: "look",
        event: {
          content: "look",
          channel: "webchat",
          isGroup: false,
          media: [
            {
              path: "file:///tmp/OpenClaw%20QA/photo.png",
              contentType: "image/png",
              kind: "image",
            },
          ],
        },
      }),
    ).toEqual([
      { type: "text", text: "look", text_elements: [] },
      { type: "localImage", path: "/tmp/OpenClaw QA/photo.png" },
    ]);
  });

  it("drops malformed local file URLs instead of throwing", () => {
    expect(
      buildCodexConversationTurnInput({
        prompt: "look",
        event: {
          content: "look",
          channel: "webchat",
          isGroup: false,
          media: [
            {
              path: "file:///tmp/%zz/photo.png",
              contentType: "image/png",
              kind: "image",
            },
          ],
        },
      }),
    ).toEqual([{ type: "text", text: "look", text_elements: [] }]);
  });

  it("treats local media URLs as Codex local image input", () => {
    expect(
      buildCodexConversationTurnInput({
        prompt: "look",
        event: {
          content: "look",
          channel: "webchat",
          isGroup: false,
          media: [
            { url: "/tmp/staged-photo.png", contentType: "image/png", kind: "image" },
            {
              url: "file:///tmp/OpenClaw%20QA/second.jpg",
              contentType: "image/jpeg",
              kind: "image",
            },
          ],
        },
      }),
    ).toEqual([
      { type: "text", text: "look", text_elements: [] },
      { type: "localImage", path: "/tmp/staged-photo.png" },
      { type: "localImage", path: "/tmp/OpenClaw QA/second.jpg" },
    ]);
  });

  it("treats Windows media paths as Codex local image input", () => {
    expect(
      buildCodexConversationTurnInput({
        prompt: "look",
        event: {
          content: "look",
          channel: "webchat",
          isGroup: false,
          media: [
            {
              url: "C:\\OpenClaw QA\\photo.png",
              contentType: "image/png",
              kind: "image",
            },
          ],
        },
      }),
    ).toEqual([
      { type: "text", text: "look", text_elements: [] },
      { type: "localImage", path: "C:\\OpenClaw QA\\photo.png" },
    ]);
  });
});