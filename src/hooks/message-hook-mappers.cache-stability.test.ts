import { describe, expect, it } from "vitest";
import type { FinalizedMsgContext } from "../auto-reply/templating.js";
import {
  deriveInboundMessageHookContext,
  toPluginInboundClaimPair,
} from "./message-hook-mappers.js";

describe("message hook media cache-stability regression", () => {
  it("keeps mixed remote/local attachments ordered in event.media while legacy aliases compact", () => {
    const canonical = deriveInboundMessageHookContext({
      From: "discord:user:123",
      To: "discord:channel:456",
      Body: "compare these",
      Provider: "discord",
      Surface: "discord",
      OriginatingChannel: "discord",
      OriginatingTo: "discord:channel:456",
      SessionKey: "agent:main:discord:channel:456",
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
    } as FinalizedMsgContext);

    const { event } = toPluginInboundClaimPair(canonical);

    expect(event.media).toEqual([
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
    ]);

    // Deprecated metadata projections compact missing fields independently and
    // therefore are deliberately not safe to zip by index.
    expect(event.metadata?.mediaPaths).toEqual(["/tmp/local.png"]);
    expect(event.metadata?.mediaUrls).toEqual([
      "https://example.test/remote.webp",
      "https://example.test/local.png",
    ]);
    expect(event.metadata?.mediaTypes).toEqual(["image/webp", "image/png"]);
  });
});