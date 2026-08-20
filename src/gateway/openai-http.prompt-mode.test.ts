// HTTP Chat promptMode follows the effective tools profile after final model selection.
import { describe, expect, it } from "vitest";
import { resolveHttpChatPromptModeFromInputs } from "./openai-http-prompt-mode.js";

const agentId = "main";
const codingBaseOpenAiMinimal = {
  tools: {
    profile: "coding",
    byProvider: { openai: { profile: "minimal" } },
  },
  agents: {
    list: [{ id: "main" }],
    defaults: {
      model: { primary: "anthropic/claude-sonnet-4-6" },
      models: {
        "anthropic/claude-sonnet-4-6": {},
        "openai/gpt-5.4": {},
      },
    },
  },
} as never;

describe("resolveHttpChatPromptModeFromInputs", () => {
  it("uses a stored session model instead of the agent default", () => {
    expect(
      resolveHttpChatPromptModeFromInputs({
        cfg: codingBaseOpenAiMinimal,
        agentId,
        sessionKey: "agent:main:openai:stable",
      }),
    ).toBeUndefined();
    expect(
      resolveHttpChatPromptModeFromInputs({
        cfg: codingBaseOpenAiMinimal,
        agentId,
        sessionKey: "agent:main:openai:stable",
        storedProvider: "openai",
        storedModel: "gpt-5.4",
      }),
    ).toBe("minimal");
  });

  it("uses a channel modelByChannel mapping when no stored or explicit model exists", () => {
    const cfg = {
      ...codingBaseOpenAiMinimal,
      channels: {
        modelByChannel: {
          telegram: { "*": "openai/gpt-5.4" },
        },
      },
    } as never;
    expect(
      resolveHttpChatPromptModeFromInputs({
        cfg,
        agentId,
        messageChannel: "telegram",
      }),
    ).toBe("minimal");
    expect(
      resolveHttpChatPromptModeFromInputs({
        cfg,
        agentId,
        messageChannel: "telegram",
        storedProvider: "anthropic",
        storedModel: "claude-sonnet-4-6",
      }),
    ).toBeUndefined();
  });

  it("lets an explicit HTTP model override win over a stored session model", () => {
    expect(
      resolveHttpChatPromptModeFromInputs({
        cfg: codingBaseOpenAiMinimal,
        agentId,
        storedProvider: "openai",
        storedModel: "gpt-5.4",
        modelOverride: "anthropic/claude-sonnet-4-6",
      }),
    ).toBeUndefined();
  });
});
