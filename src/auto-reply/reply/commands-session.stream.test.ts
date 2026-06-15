// Tests persistence guarantees for the per-session preview streaming command.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HandleCommandsParams } from "./commands-types.js";

const persistCommandSessionMock = vi.hoisted(() => vi.fn(async () => true));
const getChannelPluginMock = vi.hoisted(() =>
  vi.fn(() => ({ streaming: { sessionModeDefault: "progress" as const } })),
);
const persistenceConflictReply = vi.hoisted(() => ({
  shouldContinue: false,
  reply: { text: "retry stream command" },
}));

vi.mock("./commands-session-store.js", () => ({
  persistCommandSession: persistCommandSessionMock,
  sessionEntryPersistenceConflictReply: () => persistenceConflictReply,
}));

vi.mock("../../channels/plugins/index.js", async () => {
  const actual = await vi.importActual<typeof import("../../channels/plugins/index.js")>(
    "../../channels/plugins/index.js",
  );
  return { ...actual, getChannelPlugin: getChannelPluginMock };
});

function buildStreamParams(commandBodyNormalized: string): HandleCommandsParams {
  const sessionEntry = { sessionId: "session-1", updatedAt: 1, streamingMode: "block" as const };
  return {
    cfg: { commands: { text: true } },
    ctx: { CommandSource: "text", Provider: "telegram", Surface: "telegram" },
    command: {
      commandBodyNormalized,
      isAuthorizedSender: true,
      senderIsOwner: true,
      senderId: "owner",
      channel: "telegram",
      channelId: "telegram",
      surface: "telegram",
      ownerList: ["owner"],
      from: "owner",
      to: "bot",
    },
    directives: {},
    elevated: { enabled: true, allowed: true, failures: [] },
    sessionKey: "telegram:dm:owner",
    sessionEntry,
    sessionStore: { "telegram:dm:owner": sessionEntry },
    workspaceDir: "/tmp/workspace",
    defaultGroupActivation: () => "mention",
    resolvedVerboseLevel: "off",
    resolvedReasoningLevel: "off",
    resolveDefaultThinkingLevel: async () => undefined,
    provider: "openai",
    model: "gpt-5.5",
    contextTokens: 0,
    isGroup: false,
  } as unknown as HandleCommandsParams;
}

describe("handleStreamCommand persistence", () => {
  beforeEach(() => {
    persistCommandSessionMock.mockClear();
    persistCommandSessionMock.mockResolvedValue(true);
    getChannelPluginMock.mockClear();
  });

  it("persists only the streaming mode field", async () => {
    const { handleStreamCommand } = await import("./commands-session.js");
    const params = buildStreamParams("/stream progress");

    await expect(handleStreamCommand(params, true)).resolves.toMatchObject({
      reply: { text: "⚙️ Stream mode set to progress." },
    });
    expect(persistCommandSessionMock).toHaveBeenCalledWith({
      ...params,
      sessionEntry: params.sessionEntry,
      touchedFields: ["streamingMode"],
    });
  });

  it("reports a concurrent session change instead of acknowledging a reset", async () => {
    const { handleStreamCommand } = await import("./commands-session.js");
    const params = buildStreamParams("/stream default");
    persistCommandSessionMock.mockResolvedValueOnce(false);

    await expect(handleStreamCommand(params, true)).resolves.toEqual(persistenceConflictReply);
    expect(persistCommandSessionMock).toHaveBeenCalledWith({
      ...params,
      sessionEntry: params.sessionEntry,
      touchedFields: ["streamingMode"],
    });
  });
});
