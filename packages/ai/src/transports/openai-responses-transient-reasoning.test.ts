import type { AssistantMessage, Context, Model } from "@openclaw/llm-core";
import { describe, expect, it } from "vitest";
import { convertResponsesMessages as convertProviderResponsesMessages } from "../providers/openai-responses-shared.js";
import { buildOpenAIResponsesReasoningReplayMetadata } from "./openai-responses-compaction-replay.js";
import { convertResponsesMessages } from "./openai-responses-replay-internal.js";
import {
  processResponsesStream,
  type OpenAIResponsesStreamEvent,
} from "./openai-responses-stream-internal.js";

const nativeCodexModel = {
  id: "gpt-5.4",
  name: "GPT-5.4",
  api: "openai-chatgpt-responses",
  provider: "openai",
  baseUrl: "https://chatgpt.com/backend-api/codex",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 8192,
} satisfies Model<"openai-chatgpt-responses">;
const proxiedCodexModel = {
  ...nativeCodexModel,
  baseUrl: "https://proxy.example.com/v1",
} satisfies Model<"openai-chatgpt-responses">;
const replayIdentity = { sessionId: "session-a", authProfileId: "profile-a" };
const reasoningCases = [
  { name: "native temporary", model: nativeCodexModel, id: "rs_tmp_123", persists: false },
  { name: "native stable", model: nativeCodexModel, id: "rs_123", persists: true },
  { name: "proxied temporary-shaped", model: proxiedCodexModel, id: "rs_tmp_123", persists: true },
] as const;

const replayConverters = [
  {
    name: "transport-owned",
    convert: (model: Model, context: Context) =>
      convertResponsesMessages(model, context, new Set(["openai"]), replayIdentity),
  },
  {
    name: "provider-owned",
    convert: (model: Model, context: Context) =>
      convertProviderResponsesMessages(model, context, new Set(["openai"]), replayIdentity),
  },
] as const;

function createOutput(model: Model, content: AssistantMessage["content"] = []): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
  };
}

async function* events(
  values: Record<string, unknown>[],
): AsyncGenerator<OpenAIResponsesStreamEvent> {
  for (const value of values) {
    yield value as OpenAIResponsesStreamEvent;
  }
}

function createPersistedReasoning(model: Model, id: string): AssistantMessage {
  return createOutput(model, [
    {
      type: "thinking",
      thinking: "visible summary",
      thinkingSignature: JSON.stringify({
        type: "reasoning",
        id,
        encrypted_content: "ciphertext",
        summary: [],
      }),
    },
  ]);
}

describe("OpenAI Responses transient reasoning", () => {
  it.each(reasoningCases)("scopes streamed replay state for $name items", async (testCase) => {
    const output = createOutput(testCase.model);
    await processResponsesStream(
      events([
        { type: "response.output_item.added", item: { type: "reasoning" } },
        {
          type: "response.output_item.done",
          item: {
            type: "reasoning",
            id: testCase.id,
            encrypted_content: "ciphertext",
            summary: [{ type: "summary_text", text: "visible summary" }],
          },
        },
        { type: "response.completed", response: { id: "resp_done", status: "completed" } },
      ]),
      output,
      { push: () => undefined },
      testCase.model,
      {
        reasoningReplayMetadata: buildOpenAIResponsesReasoningReplayMetadata(
          testCase.model,
          replayIdentity,
        ),
      },
    );

    expect(output.content).toMatchObject([{ type: "thinking", thinking: "visible summary" }]);
    if (testCase.persists) {
      expect(output.content[0]).toMatchObject({
        thinkingSignature: expect.stringContaining(testCase.id),
        openclawReasoningReplay: expect.objectContaining({
          provider: "openai",
          api: "openai-chatgpt-responses",
        }),
      });
    } else {
      expect(output.content[0]).not.toHaveProperty("thinkingSignature");
      expect(output.content[0]).not.toHaveProperty("openclawReasoningReplay");
    }
  });

  it.each(replayConverters)("$name applies the same route boundary", ({ convert }) => {
    for (const testCase of reasoningCases) {
      const input = convert(testCase.model, {
        messages: [createPersistedReasoning(testCase.model, testCase.id)],
      });
      expect(
        input.filter((item) => item.type === "reasoning"),
        testCase.name,
      ).toHaveLength(testCase.persists ? 1 : 0);
    }
  });
});
