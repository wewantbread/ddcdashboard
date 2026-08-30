import { createAssistantMessageEventStream } from "@openclaw/llm-core";
import { describe, expect, it } from "vitest";
import { estimateTokens } from "../../packages/agent-core/src/harness/compaction/compaction.js";
import { estimateMessagesTokens } from "./compaction-planning.js";
import { summarizeInStages } from "./compaction.js";
import type { AgentMessage } from "./runtime/index.js";
import { makeAgentAssistantMessage } from "./test-helpers/agent-message-fixtures.js";

type SummaryRequest = { inputTokens: number; outputTokens: number };
type SummarizeParams = Parameters<typeof summarizeInStages>[0];
type SummaryModel = SummarizeParams["model"] & { contextWindow: number };

function makeMessage(id: number, text: string): AgentMessage {
  return {
    role: "user",
    content: text,
    timestamp: id,
  };
}

function makeSummaryModel(contextWindow: number): SummaryModel {
  return {
    id: "gpt-5.6-luna",
    name: "Synthetic compaction model",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://unused.invalid",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens: 8_192,
  };
}

function createRecordingSummaryStream(
  requests: SummaryRequest[],
): NonNullable<SummarizeParams["streamFn"]> {
  return (_model, context, options) => {
    const inputTokens = context.messages.reduce(
      (sum, message) => sum + estimateTokens(message),
      estimateTokens(makeMessage(0, context.systemPrompt ?? "")),
    );
    requests.push({ inputTokens, outputTokens: options?.maxTokens ?? 0 });
    const stream = createAssistantMessageEventStream();
    stream.push({
      type: "done",
      reason: "stop",
      message: makeAgentAssistantMessage({
        content: [{ type: "text", text: "Compact summary." }],
      }),
    });
    stream.end();
    return stream;
  };
}

describe("compaction fit planning", () => {
  it("uses one summary request when the complete serialized request fits the model window", async () => {
    const model = makeSummaryModel(262_144);
    const key = model.id;
    const messages = Array.from({ length: 64 }, (_, index) =>
      makeMessage(index + 1, `history-${index}-${"x".repeat(9_980)}`),
    );
    const maxChunkTokens = Math.floor(model.contextWindow * 0.4) - 4_096;
    const requests: SummaryRequest[] = [];

    expect(estimateMessagesTokens(messages)).toBeGreaterThan(maxChunkTokens);

    const summary = await summarizeInStages({
      messages,
      model,
      apiKey: key,
      signal: AbortSignal.timeout(45_000),
      reserveTokens: 8_192,
      // Mirrors safeguard mode's adaptive 40% target after fixed overhead.
      maxChunkTokens,
      maxChunkTokensSource: "adaptive",
      contextWindow: model.contextWindow,
      customInstructions: "Keep the active task and exact identifiers.",
      previousSummary: "Earlier work remains relevant.",
      streamFn: createRecordingSummaryStream(requests),
    });

    expect(summary).toBe("Compact summary.");
    expect(requests).toHaveLength(1);
    expect(requests[0]!.inputTokens + requests[0]!.outputTokens).toBeLessThanOrEqual(
      model.contextWindow,
    );
  }, 45_000);

  it("keeps staged summarization when full request overhead exceeds the model window", async () => {
    const model = makeSummaryModel(64_000);
    const key = model.id;
    const messages = Array.from({ length: 64 }, (_, index) =>
      makeMessage(index + 1, `history-${index}-${"x".repeat(1_980)}`),
    );
    const requests: SummaryRequest[] = [];

    await summarizeInStages({
      messages,
      model,
      apiKey: key,
      signal: AbortSignal.timeout(45_000),
      reserveTokens: 8_192,
      maxChunkTokens: Math.floor(model.contextWindow * 0.4) - 4_096,
      maxChunkTokensSource: "adaptive",
      contextWindow: model.contextWindow,
      customInstructions: `Preserve this focus: ${"i".repeat(24_000)}`,
      previousSummary: `Prior summary: ${"p".repeat(24_000)}`,
      streamFn: createRecordingSummaryStream(requests),
    });

    expect(requests.length).toBeGreaterThan(1);
    expect(
      requests.every(
        ({ inputTokens, outputTokens }) => inputTokens + outputTokens <= model.contextWindow,
      ),
    ).toBe(true);
  }, 45_000);

  it("preserves an unmarked caller cap even when the complete request fits the model window", async () => {
    const model = makeSummaryModel(262_144);
    const key = model.id;
    const messages = Array.from({ length: 64 }, (_, index) =>
      makeMessage(index + 1, `history-${index}-${"x".repeat(9_980)}`),
    );
    const maxChunkTokens = Math.floor(model.contextWindow * 0.4) - 4_096;
    const requests: SummaryRequest[] = [];

    expect(estimateMessagesTokens(messages)).toBeGreaterThan(maxChunkTokens);

    await summarizeInStages({
      messages,
      model,
      apiKey: key,
      signal: AbortSignal.timeout(45_000),
      reserveTokens: 8_192,
      maxChunkTokens,
      contextWindow: model.contextWindow,
      customInstructions: "Keep the active task and exact identifiers.",
      previousSummary: "Earlier work remains relevant.",
      streamFn: createRecordingSummaryStream(requests),
    });

    expect(requests.length).toBeGreaterThan(1);
  }, 45_000);
});
