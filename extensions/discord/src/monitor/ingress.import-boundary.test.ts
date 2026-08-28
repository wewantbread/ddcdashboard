// Discord ingress import-boundary tests keep pre-claim helpers lightweight.
import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";

async function sourceText(relativePath: string): Promise<string> {
  return await fs.readFile(new URL(relativePath, import.meta.url), "utf8");
}

describe("Discord ingress import boundary", () => {
  it("keeps raw mention parsing off the channel-inbound preflight module graph", async () => {
    const [ingressSource, rawMentionSource] = await Promise.all([
      sourceText("./ingress.ts"),
      sourceText("./message-handler.raw-mention.ts"),
    ]);

    expect(ingressSource).toContain('from "./message-handler.raw-mention.js"');
    expect(ingressSource).not.toContain("./message-handler.preflight-helpers.js");
    expect(rawMentionSource).not.toContain("channel-inbound");
  });
});
