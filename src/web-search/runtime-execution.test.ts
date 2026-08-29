// Coverage for candidate fallback attribution and availability detection.
import { describe, expect, it } from "vitest";
import { executeWebSearchCandidates } from "./runtime-execution.js";

function candidate(id: string, execute: () => Promise<unknown>) {
  return {
    id,
    createTool: () => ({
      description: id,
      parameters: {},
      execute,
    }),
  } as unknown as Parameters<typeof executeWebSearchCandidates>[0]["candidates"][number];
}

describe("executeWebSearchCandidates", () => {
  it("surfaces the first candidate's error when every candidate fails", async () => {
    await expect(
      executeWebSearchCandidates({
        candidates: [
          candidate("google", async () => {
            throw new Error("google unreachable");
          }),
          candidate("duckduckgo", async () => {
            throw new Error("duckduckgo unreachable");
          }),
        ],
        args: {},
        allowFallback: true,
      }),
    ).rejects.toThrow("google unreachable");
  });

  it("falls through to the next candidate on a missing base URL", async () => {
    await expect(
      executeWebSearchCandidates({
        candidates: [
          candidate("searxng", async () => ({ error: "missing_searxng_base_url" })),
          candidate("backup", async () => ({ query: "ok", provider: "backup" })),
        ],
        args: {},
        allowFallback: true,
      }),
    ).resolves.toEqual({
      provider: "backup",
      result: { query: "ok", provider: "backup" },
    });
  });

  it("does not fall through on a validation error", async () => {
    await expect(
      executeWebSearchCandidates({
        candidates: [
          candidate("google", async () => ({ error: "invalid_freshness" })),
          candidate("duckduckgo", async () => ({ query: "unreached" })),
        ],
        args: {},
        allowFallback: true,
      }),
    ).resolves.toEqual({
      provider: "google",
      result: { error: "invalid_freshness" },
    });
  });
});
