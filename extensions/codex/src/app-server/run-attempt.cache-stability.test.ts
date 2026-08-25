import type { EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import { describe, expect, it } from "vitest";
import { resolveCodexDurableToolRegistrationParams } from "./run-attempt-tool-setup.js";

function params(
  overrides: Partial<EmbeddedRunAttemptParams>,
): EmbeddedRunAttemptParams {
  return overrides as EmbeddedRunAttemptParams;
}

describe("Codex durable tool registration cache stability", () => {
  it("advertises an owner-capable image-neutral superset for a non-owner image turn", () => {
    const runtimeParams = params({
      senderIsOwner: false,
      images: [{ type: "image", data: "AA==", mimeType: "image/png" }],
    });

    const durable = resolveCodexDurableToolRegistrationParams(runtimeParams);

    expect(durable).not.toBe(runtimeParams);
    expect(durable.senderIsOwner).toBe(true);
    expect(durable.images).toBeUndefined();

    // Durable schema normalization must not mutate the real executable turn.
    expect(runtimeParams.senderIsOwner).toBe(false);
    expect(runtimeParams.images).toHaveLength(1);
  });

  it("keeps an already stable owner/no-image registration unchanged", () => {
    const runtimeParams = params({ senderIsOwner: true, images: undefined });

    expect(resolveCodexDurableToolRegistrationParams(runtimeParams)).toBe(runtimeParams);
  });

  it("normalizes owner and non-owner turns to the same registration authority state", () => {
    const owner = resolveCodexDurableToolRegistrationParams(
      params({ senderIsOwner: true, images: undefined }),
    );
    const nonOwner = resolveCodexDurableToolRegistrationParams(
      params({ senderIsOwner: false, images: undefined }),
    );

    expect(owner.senderIsOwner).toBe(true);
    expect(nonOwner.senderIsOwner).toBe(true);
    expect(owner.images).toBeUndefined();
    expect(nonOwner.images).toBeUndefined();
  });
});