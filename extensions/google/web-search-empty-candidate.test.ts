// Regression tests for Gemini empty candidate handling (issue #130550).
import { withFetchPreconnect } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import { createGeminiWebSearchProvider } from "./src/gemini-web-search-provider.js";

function createGeminiTool() {
  return createGeminiWebSearchProvider().createTool({
    config: {
      plugins: {
        entries: {
          google: {
            config: {
              webSearch: {
                apiKey: "AIza-plugin-test",
              },
            },
          },
        },
      },
    },
    searchConfig: { provider: "gemini" },
  });
}

function mockFetchResponse(body: unknown) {
  vi.stubGlobal(
    "fetch",
    withFetchPreconnect(vi.fn(() => Promise.resolve(new Response(JSON.stringify(body))))),
  );
}

describe("Gemini empty candidate handling (#130550)", () => {
  it("returns empty content for empty parts array with STOP finishReason (shape A)", async () => {
    mockFetchResponse({
      candidates: [
        {
          content: { parts: [] },
          finishReason: "STOP",
          groundingMetadata: {},
        },
      ],
    });

    const result = await createGeminiTool()?.execute({ query: "nonexistent person lookup" });

    expect(result).toMatchObject({
      citations: [],
      model: "gemini-2.5-flash",
      provider: "gemini",
    });
    expect(String(result?.content)).toContain("no answer text returned");
  });

  it("returns empty content for empty candidate without parts key (shape B)", async () => {
    mockFetchResponse({
      candidates: [
        {
          content: { role: "model" },
          finishReason: "STOP",
        },
      ],
    });

    const result = await createGeminiTool()?.execute({ query: "nonexistent person lookup" });

    expect(result).toMatchObject({
      citations: [],
      provider: "gemini",
    });
    expect(String(result?.content)).toContain("no answer text returned");
  });

  it("throws naming finishReason for empty content with non-STOP finishReason", async () => {
    mockFetchResponse({
      candidates: [
        {
          content: { parts: [] },
          finishReason: "SAFETY",
        },
      ],
    });

    await expect(createGeminiTool()?.execute({ query: "blocked query" })).rejects.toThrow(
      "Gemini API error: empty result (SAFETY)",
    );
  });

  it("throws naming promptFeedback.blockReason when Gemini blocks content", async () => {
    mockFetchResponse({
      promptFeedback: { blockReason: "SAFETY" },
    });

    await expect(createGeminiTool()?.execute({ query: "blocked query" })).rejects.toThrow(
      "Gemini API error: prompt blocked (SAFETY)",
    );
  });

  it("returns empty content for empty candidates array", async () => {
    mockFetchResponse({ candidates: [] });

    const result = await createGeminiTool()?.execute({ query: "empty results query" });

    expect(result).toMatchObject({
      citations: [],
      provider: "gemini",
    });
  });

  it("rejects content with parts present but not an array", async () => {
    mockFetchResponse({
      candidates: [
        {
          content: { parts: "not-an-array" },
          finishReason: "STOP",
        },
      ],
    });

    await expect(createGeminiTool()?.execute({ query: "OpenClaw docs" })).rejects.toThrow(
      "Gemini API error: malformed JSON response",
    );
  });
});
