// Copy-text presentation tests cover normalization, legacy bridging, and visible fallback.
import { describe, expect, it } from "vitest";
import {
  normalizeMessagePresentation,
  presentationToInteractiveReply,
  renderMessagePresentationFallbackText,
} from "./payload.js";

describe("copy-text presentation actions", () => {
  it("preserves exact nonblank copy text through normalization and the legacy bridge", () => {
    const copyText = "\n openclaw status \n";
    const normalized = normalizeMessagePresentation({
      blocks: [
        {
          type: "buttons",
          buttons: [
            {
              label: "Copy command",
              action: { type: "copy-text", text: copyText },
            },
          ],
        },
      ],
    });

    const expected = {
      blocks: [
        {
          type: "buttons" as const,
          buttons: [
            {
              label: "Copy command",
              action: { type: "copy-text" as const, text: copyText },
            },
          ],
        },
      ],
    };
    expect(normalized).toEqual(expected);
    expect(presentationToInteractiveReply(normalized!)).toEqual(expected);
  });

  it("rejects empty copy text and keeps valid text visible in fallback", () => {
    expect(
      normalizeMessagePresentation({
        blocks: [
          {
            type: "buttons",
            buttons: [{ label: "Copy", action: { type: "copy-text", text: "   " } }],
          },
        ],
      }),
    ).toBeUndefined();

    expect(
      renderMessagePresentationFallbackText({
        presentation: {
          blocks: [
            {
              type: "buttons",
              buttons: [
                {
                  label: "Copy token",
                  action: { type: "copy-text", text: "TOKEN-7319" },
                },
              ],
            },
          ],
        },
      }),
    ).toBe("- Copy token: `TOKEN-7319`");
  });
});
