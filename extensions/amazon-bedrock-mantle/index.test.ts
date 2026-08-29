// Amazon Bedrock Mantle tests cover index plugin behavior.
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import bedrockMantlePlugin from "./index.js";

function createGpt56ResponsesModel() {
  return {
    id: "openai.gpt-5.6-luna",
    name: "GPT-5.6 Luna",
    api: "openai-responses",
    provider: "amazon-bedrock-mantle",
    baseUrl: "https://bedrock-mantle.us-east-1.api.aws/openai/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0.22, output: 1.32, cacheRead: 0.022, cacheWrite: 0.275 },
    contextWindow: 272_000,
    maxTokens: 65_536,
  };
}

describe("amazon-bedrock-mantle provider plugin", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("uses live plugin config to disable catalog discovery", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("unexpected fetch"));
    const provider = await registerSingleProviderPlugin(bedrockMantlePlugin);
    const catalog = provider.catalog;
    if (!catalog) {
      throw new Error("catalog registration missing");
    }

    const result = await catalog.run({
      config: {
        plugins: {
          entries: {
            "amazon-bedrock-mantle": {
              config: {
                discovery: { enabled: false },
              },
            },
          },
        },
      },
      env: {
        AWS_BEARER_TOKEN_BEDROCK: "test-token",
        AWS_REGION: "us-east-1",
      },
    } as never);

    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns raw discovery for the host to merge with materialized config", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            {
              id: "anthropic.claude-opus-4-7",
              object: "model",
              input_modalities: ["text", "image"],
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const provider = await registerSingleProviderPlugin(bedrockMantlePlugin);

    const result = await provider.catalog?.run({
      config: {
        models: {
          providers: {
            "amazon-bedrock-mantle": {
              baseUrl: "https://explicit.example.test/v1",
              models: [{ id: "anthropic.claude-opus-4-7", input: ["text"] }],
            },
          },
        },
      },
      env: {
        AWS_BEARER_TOKEN_BEDROCK: "test-token",
        AWS_REGION: "us-east-1",
      },
    } as never);

    if (!result || !("provider" in result)) {
      throw new Error("expected single provider catalog result");
    }
    expect(result.provider.baseUrl).toBe("https://bedrock-mantle.us-east-1.api.aws/v1");
    expect(result.provider.models[0]?.input).toEqual(["text", "image"]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("registers with correct provider ID and label", async () => {
    const provider = await registerSingleProviderPlugin(bedrockMantlePlugin);
    expect(provider.id).toBe("amazon-bedrock-mantle");
    expect(provider.label).toBe("Amazon Bedrock Mantle (OpenAI-compatible)");
  });

  it("classifies rate limit errors for failover", async () => {
    const provider = await registerSingleProviderPlugin(bedrockMantlePlugin);
    expect(
      provider.classifyFailoverReason?.({ errorMessage: "rate_limit exceeded" } as never),
    ).toBe("rate_limit");
    expect(
      provider.classifyFailoverReason?.({ errorMessage: "429 Too Many Requests" } as never),
    ).toBe("rate_limit");
    expect(
      provider.classifyFailoverReason?.({ errorMessage: "some other error" } as never),
    ).toBeUndefined();
    expect(provider.classifyFailoverReason?.({ errorMessage: "overloaded_error" } as never)).toBe(
      "overloaded",
    );
  });

  it("provides a custom stream only for Mantle Anthropic models", async () => {
    const provider = await registerSingleProviderPlugin(bedrockMantlePlugin);

    expect(
      typeof provider.createStreamFn?.({
        provider: "amazon-bedrock-mantle",
        modelId: "anthropic.claude-opus-4-7",
        model: {
          api: "anthropic-messages",
        },
      } as never),
    ).toBe("function");

    expect(
      provider.createStreamFn?.({
        provider: "amazon-bedrock-mantle",
        modelId: "openai.gpt-oss-120b",
        model: {
          api: "openai-completions",
        },
      } as never),
    ).toBeUndefined();
  });

  it("injects explicit prompt caching for Mantle GPT-5.6 Responses models", async () => {
    const provider = await registerSingleProviderPlugin(bedrockMantlePlugin);
    const model = createGpt56ResponsesModel();
    let capturedPayload: Record<string, unknown> = {};
    const baseStreamFn: StreamFn = (selectedModel, _context, options) => {
      const payload = {
        model: selectedModel.id,
        input: [
          {
            type: "message",
            role: "developer",
            content: [
              {
                type: "input_text",
                text: "Stable system prompt\nDynamic runtime context",
              },
            ],
          },
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Hello" }],
          },
        ],
        prompt_cache_key: "session-123",
        stream: true,
      };
      void options?.onPayload?.(payload, selectedModel);
      capturedPayload = payload;
      return {} as ReturnType<StreamFn>;
    };

    const wrapped = provider.wrapStreamFn?.({
      provider: "amazon-bedrock-mantle",
      modelId: model.id,
      model,
      streamFn: baseStreamFn,
    } as never);
    expect(wrapped).toBeTypeOf("function");
    if (!wrapped) {
      throw new Error("Mantle GPT-5.6 Responses wrapper missing");
    }
    void wrapped(
      model as never,
      {
        systemPrompt:
          "Stable system prompt\n<!-- OPENCLAW_CACHE_BOUNDARY -->\nDynamic runtime context",
        messages: [],
      },
      {},
    );

    expect(capturedPayload.prompt_cache_options).toEqual({ mode: "explicit" });
    expect(capturedPayload.input).toEqual([
      {
        type: "message",
        role: "developer",
        content: [
          {
            type: "input_text",
            text: "Stable system prompt",
            prompt_cache_breakpoint: { mode: "explicit" },
          },
          {
            type: "input_text",
            text: "Dynamic runtime context",
          },
        ],
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Hello" }],
      },
    ]);

    const normalized = provider.normalizeResolvedModel?.({
      provider: "amazon-bedrock-mantle",
      modelId: model.id,
      model,
    } as never);
    expect(normalized?.compat).toMatchObject({
      supportsLongCacheRetention: false,
      supportsPromptCacheKey: true,
    });

    capturedPayload = {};
    void wrapped(
      model as never,
      { systemPrompt: "Stable system prompt", messages: [] },
      { cacheRetention: "none" },
    );
    expect(capturedPayload.prompt_cache_options).toEqual({ mode: "explicit" });
    expect(JSON.stringify(capturedPayload)).not.toContain("prompt_cache_breakpoint");

    expect(
      provider.wrapStreamFn?.({
        provider: "amazon-bedrock-mantle",
        modelId: "openai.gpt-5.5",
        model: { ...model, id: "openai.gpt-5.5" },
        streamFn: baseStreamFn,
      } as never),
    ).toBeUndefined();
  });

  it("retains the shared Responses payload policy on Mantle cache requests", async () => {
    const provider = await registerSingleProviderPlugin(bedrockMantlePlugin);
    const model = createGpt56ResponsesModel();
    const normalized =
      provider.normalizeResolvedModel?.({
        provider: "amazon-bedrock-mantle",
        modelId: model.id,
        model,
      } as never) ?? model;
    let capturedPayload: Record<string, unknown> = {};
    const baseStreamFn: StreamFn = (selectedModel, _context, options) => {
      const payload = {
        model: selectedModel.id,
        input: [
          {
            type: "message",
            role: "developer",
            content: [{ type: "input_text", text: "Stable system prompt" }],
          },
          {
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "Earlier reply" }],
          },
        ],
        reasoning: { effort: "none", summary: "auto" },
        prompt_cache_key: "session-123",
        stream: true,
      };
      void options?.onPayload?.(payload, selectedModel);
      capturedPayload = payload;
      return {} as ReturnType<StreamFn>;
    };
    const wrapped = provider.wrapStreamFn?.({
      provider: "amazon-bedrock-mantle",
      modelId: model.id,
      model: normalized,
      streamFn: baseStreamFn,
    } as never);
    if (!wrapped) {
      throw new Error("Mantle GPT-5.6 Responses wrapper missing");
    }

    void wrapped(normalized as never, { systemPrompt: "Stable system prompt", messages: [] }, {});

    expect(capturedPayload).not.toHaveProperty("reasoning");
    expect(capturedPayload.input).toEqual([
      {
        type: "message",
        role: "developer",
        content: [
          {
            type: "input_text",
            text: "Stable system prompt",
            prompt_cache_breakpoint: { mode: "explicit" },
          },
        ],
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Earlier reply" }],
      },
    ]);
  });

  it("applies explicit caching to simple completions without 24-hour retention", async () => {
    const provider = await registerSingleProviderPlugin(bedrockMantlePlugin);
    const model = createGpt56ResponsesModel();
    const normalized =
      provider.normalizeResolvedModel?.({
        provider: "amazon-bedrock-mantle",
        modelId: model.id,
        model,
      } as never) ?? model;
    let capturedPayload: Record<string, unknown> = {};
    const baseStreamFn: StreamFn = (selectedModel, _context, options) => {
      const supportsLongCacheRetention = selectedModel.compat?.supportsLongCacheRetention !== false;
      const payload = {
        model: selectedModel.id,
        input: [
          {
            type: "message",
            role: "developer",
            content: [{ type: "input_text", text: "Stable system prompt" }],
          },
        ],
        prompt_cache_key: "session-123",
        ...(options?.cacheRetention === "long" && supportsLongCacheRetention
          ? { prompt_cache_retention: "24h" }
          : {}),
        stream: true,
      };
      void options?.onPayload?.(payload, selectedModel);
      capturedPayload = payload;
      return {} as ReturnType<StreamFn>;
    };
    const simpleCompletionModel = {
      ...normalized,
      api: "openclaw-provider-stream:amazon-bedrock-mantle",
    };
    const wrapped = provider.wrapSimpleCompletionStreamFn?.({
      provider: "amazon-bedrock-mantle",
      modelId: model.id,
      model: simpleCompletionModel,
      sourceApi: "openai-responses",
      streamFn: baseStreamFn,
    } as never);
    expect(wrapped).toBeTypeOf("function");
    if (!wrapped) {
      throw new Error("Mantle GPT-5.6 simple-completion wrapper missing");
    }

    void wrapped(
      simpleCompletionModel as never,
      { systemPrompt: "Stable system prompt", messages: [] },
      { cacheRetention: "long" },
    );

    expect(capturedPayload.prompt_cache_options).toEqual({ mode: "explicit" });
    expect(JSON.stringify(capturedPayload)).not.toContain("prompt_cache_retention");
  });

  it("restores missing or stale Opus 5 pricing during runtime normalization", async () => {
    const provider = await registerSingleProviderPlugin(bedrockMantlePlugin);
    const model = {
      id: "anthropic.claude-opus-5",
      name: "Claude Opus 5",
      api: "anthropic-messages",
      provider: "amazon-bedrock-mantle",
      baseUrl: "https://bedrock-mantle.us-east-1.api.aws/anthropic",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      params: { canonicalModelId: "claude-opus-5" },
    };
    const expectedCost = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 };

    for (const cost of [undefined, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }]) {
      const normalized = provider.normalizeResolvedModel?.({
        provider: "amazon-bedrock-mantle",
        modelId: "anthropic.claude-opus-5",
        model: { ...model, cost },
      } as never);
      expect(normalized?.cost).toEqual(expectedCost);
    }
  });

  it("restores missing or stale Sonnet 5 pricing during runtime normalization", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 8, 1));
    try {
      const provider = await registerSingleProviderPlugin(bedrockMantlePlugin);
      const model = {
        id: "anthropic.claude-sonnet-5",
        name: "Claude Sonnet 5",
        api: "anthropic-messages",
        provider: "amazon-bedrock-mantle",
        baseUrl: "https://bedrock-mantle.us-east-1.api.aws/anthropic",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 1_000_000,
        maxTokens: 128_000,
        params: { canonicalModelId: "claude-sonnet-5" },
      };
      const expectedCost = {
        input: 3,
        output: 15,
        cacheRead: 0.3,
        cacheWrite: 3.75,
      };

      for (const cost of [undefined, { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }]) {
        const normalized = provider.normalizeResolvedModel?.({
          provider: "amazon-bedrock-mantle",
          modelId: "anthropic.claude-sonnet-5",
          model: { ...model, cost },
        } as never);
        expect(normalized?.cost).toEqual(expectedCost);
      }
    } finally {
      vi.useRealTimers();
    }
  });
});
