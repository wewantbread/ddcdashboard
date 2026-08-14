// Zalouser tests cover monitor.group gating plugin behavior.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ChannelAccountSnapshot } from "openclaw/plugin-sdk/channel-contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";
import "./monitor.send.test-mocks.js";
import "./zalo-js.test-mocks.js";
import { resolveZalouserAccountSync } from "./accounts.js";
import {
  createRawZalouserMessageFromNormalized,
  waitForZalouserIngressVerdict,
  withZalouserIngressTestQueue,
} from "./ingress.test-support.js";
import {
  dispatchReplyCall,
  installGroupCommandAuthRuntime,
  installRuntime,
  mockCallArg,
} from "./monitor.group-gating.test-support.js";
import { monitorZalouserProvider } from "./monitor.js";
import {
  sendDeliveredZalouserMock,
  sendMessageZalouserMock,
  sendSeenZalouserMock,
  sendTypingZalouserMock,
} from "./monitor.send.test-mocks.js";
import { createZalouserSendReceipt } from "./send-receipt.js";
import { sendMessageZalouser } from "./send.js";
import { createZalouserRuntimeEnv } from "./test-helpers.js";
import type { ResolvedZalouserAccount, ZaloInboundMessage } from "./types.js";
import {
  listZaloFriendsMock,
  listZaloGroupsMock,
  startZaloListenerMock,
} from "./zalo-js.test-mocks.js";

function createAccount(): ResolvedZalouserAccount {
  return {
    accountId: "default",
    enabled: true,
    profile: "default",
    authenticated: true,
    config: {
      dmPolicy: "open",
      allowFrom: ["*"],
      groupPolicy: "open",
      groups: {
        "*": { requireMention: true },
      },
    },
  };
}

function createConfig(): OpenClawConfig {
  return {
    channels: {
      zalouser: {
        enabled: true,
        dmPolicy: "open",
        allowFrom: ["*"],
        groups: {
          "*": { requireMention: true },
        },
      },
    },
  };
}

const kernelProofTempDirs = new Set<string>();

async function createKernelProofConfig(): Promise<OpenClawConfig> {
  const tempDir = await mkdtemp(path.join(tmpdir(), "openclaw-zalouser-kernel-proof-"));
  kernelProofTempDirs.add(tempDir);
  return {
    ...createConfig(),
    session: { store: path.join(tempDir, "sessions.json") },
  };
}

const createRuntimeEnv = () => createZalouserRuntimeEnv();

async function processMessageThroughMonitor(params: {
  message?: ZaloInboundMessage;
  messages?: ZaloInboundMessage[];
  account: ResolvedZalouserAccount;
  config: OpenClawConfig;
  runtime: ReturnType<typeof createZalouserRuntimeEnv>;
  historyState?: { historyLimit?: number };
  statusSink?: (patch: Omit<ChannelAccountSnapshot, "accountId">) => void;
}): Promise<void> {
  const messages = params.messages ?? (params.message ? [params.message] : []);
  const account = params.historyState?.historyLimit
    ? {
        ...params.account,
        config: { ...params.account.config, historyLimit: params.historyState.historyLimit },
      }
    : params.account;
  await withZalouserIngressTestQueue(async (ingressQueue) => {
    const abortController = new AbortController();
    let resolveProcessed: (() => void) | undefined;
    const processed = new Promise<void>((resolve) => {
      resolveProcessed = resolve;
    });
    startZaloListenerMock.mockImplementationOnce(async (listenerParams) => {
      for (const message of messages) {
        await listenerParams.onMessage(createRawZalouserMessageFromNormalized(message));
        if (!message.msgId) {
          throw new Error("Zalouser monitor test message requires msgId");
        }
        await waitForZalouserIngressVerdict(ingressQueue, message.msgId, "completed");
      }
      resolveProcessed?.();
      return { stop: vi.fn() };
    });
    const run = monitorZalouserProvider({
      account,
      config: params.config,
      runtime: params.runtime,
      abortSignal: abortController.signal,
      statusSink: params.statusSink,
      ingressQueue,
    });
    await processed;
    abortController.abort();
    await run;
  });
}

async function processGroupControlCommand(params: {
  account: ResolvedZalouserAccount;
  content?: string;
  commandContent?: string;
}) {
  await processMessageThroughMonitor({
    message: createGroupMessage({
      content: params.content ?? "/new",
      commandContent: params.commandContent ?? "/new",
      hasAnyMention: true,
      wasExplicitlyMentioned: true,
    }),
    account: params.account,
    config: createConfig(),
    runtime: createRuntimeEnv(),
  });
}

function createGroupMessage(overrides: Partial<ZaloInboundMessage> = {}): ZaloInboundMessage {
  return {
    threadId: "g-1",
    isGroup: true,
    senderId: "123",
    senderName: "Alice",
    groupName: "Team",
    content: "hello",
    timestampMs: Date.now(),
    msgId: "m-1",
    hasAnyMention: false,
    wasExplicitlyMentioned: false,
    canResolveExplicitMention: true,
    implicitMention: false,
    raw: { source: "test" },
    ...overrides,
  };
}

function createDmMessage(overrides: Partial<ZaloInboundMessage> = {}): ZaloInboundMessage {
  return {
    threadId: "u-1",
    isGroup: false,
    senderId: "321",
    senderName: "Bob",
    groupName: undefined,
    content: "hello",
    timestampMs: Date.now(),
    msgId: "dm-1",
    raw: { source: "test" },
    ...overrides,
  };
}

describe("zalouser monitor group mention gating", () => {
  beforeEach(() => {
    sendMessageZalouserMock.mockClear();
    sendTypingZalouserMock.mockClear();
    sendDeliveredZalouserMock.mockClear();
    sendSeenZalouserMock.mockClear();
    listZaloFriendsMock.mockReset();
    listZaloFriendsMock.mockResolvedValue([]);
    listZaloGroupsMock.mockReset();
    listZaloGroupsMock.mockResolvedValue([]);
    startZaloListenerMock.mockReset();
    startZaloListenerMock.mockResolvedValue({ stop: vi.fn() });
  });

  afterEach(async () => {
    await Promise.all(
      Array.from(kernelProofTempDirs, (tempDir) => rm(tempDir, { recursive: true, force: true })),
    );
    kernelProofTempDirs.clear();
  });

  async function processMessageWithDefaults(params: {
    message: ZaloInboundMessage;
    account?: ResolvedZalouserAccount;
    historyState?: {
      historyLimit: number;
      groupHistories: Map<
        string,
        Array<{ sender: string; body: string; timestamp?: number; messageId?: string }>
      >;
    };
  }) {
    await processMessageThroughMonitor({
      message: params.message,
      account: params.account ?? createAccount(),
      config: createConfig(),
      runtime: createZalouserRuntimeEnv(),
      historyState: params.historyState,
    });
  }

  async function expectSkippedGroupMessage(message?: Partial<ZaloInboundMessage>) {
    const { dispatchReplyWithBufferedBlockDispatcher } = installRuntime({
      commandAuthorized: false,
    });
    await processMessageWithDefaults({
      message: createGroupMessage(message),
    });
    expect(dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
    expect(sendTypingZalouserMock).not.toHaveBeenCalled();
  }

  async function startMonitorForStartupResolution(
    accountConfig: ResolvedZalouserAccount["config"],
  ) {
    installRuntime({ commandAuthorized: false });
    const abortController = new AbortController();
    abortController.abort();
    await withZalouserIngressTestQueue(async (ingressQueue) => {
      await monitorZalouserProvider({
        account: {
          ...createAccount(),
          config: accountConfig,
        },
        config: createConfig(),
        runtime: createRuntimeEnv(),
        abortSignal: abortController.signal,
        ingressQueue,
      });
    });
  }

  async function expectGroupCommandAuthorizers(params: {
    accountConfig: ResolvedZalouserAccount["config"];
    expectedCommandAuthorized: boolean;
  }) {
    const { dispatchReplyWithBufferedBlockDispatcher, resolveCommandAuthorizedFromAuthorizers } =
      installGroupCommandAuthRuntime();
    await processGroupControlCommand({
      account: {
        ...createAccount(),
        config: params.accountConfig,
      },
    });
    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
    expect(resolveCommandAuthorizedFromAuthorizers).not.toHaveBeenCalled();
    const callArg = dispatchReplyCall(dispatchReplyWithBufferedBlockDispatcher);
    expect(callArg?.ctx?.CommandAuthorized).toBe(params.expectedCommandAuthorized);
  }

  async function processOpenDmMessage(params?: { message?: Partial<ZaloInboundMessage> }) {
    const runtime = installRuntime({
      commandAuthorized: false,
    });
    await processMessageWithDefaults({
      message: createDmMessage(params?.message),
      account: createAccount(),
    });
    return runtime;
  }

  async function expectDangerousNameMatching(params: {
    dangerouslyAllowNameMatching?: boolean;
    expectedDispatches: number;
  }) {
    const { dispatchReplyWithBufferedBlockDispatcher } = installRuntime({
      commandAuthorized: false,
    });
    await processMessageWithDefaults({
      message: createGroupMessage({
        threadId: "g-attacker-001",
        groupName: "Trusted Team",
        senderId: "666",
        hasAnyMention: true,
        wasExplicitlyMentioned: true,
        content: "ping @bot",
      }),
      account: {
        ...createAccount(),
        config: {
          ...createAccount().config,
          ...(params.dangerouslyAllowNameMatching ? { dangerouslyAllowNameMatching: true } : {}),
          groupPolicy: "allowlist",
          groupAllowFrom: ["*"],
          groups: {
            "group:g-trusted-001": { enabled: true },
            "Trusted Team": { enabled: true },
          },
        },
      },
    });
    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(
      params.expectedDispatches,
    );
    return dispatchReplyWithBufferedBlockDispatcher;
  }

  async function dispatchGroupMessage(params: {
    commandAuthorized: boolean;
    message: Partial<ZaloInboundMessage>;
  }) {
    const { dispatchReplyWithBufferedBlockDispatcher } = installRuntime({
      commandAuthorized: params.commandAuthorized,
    });
    await processMessageWithDefaults({
      message: createGroupMessage(params.message),
    });
    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
    return dispatchReplyCall(dispatchReplyWithBufferedBlockDispatcher);
  }

  it("skips unmentioned group messages when requireMention=true", async () => {
    await expectSkippedGroupMessage();
  });

  it("blocks mentioned group messages by default when groupPolicy is omitted", async () => {
    const { dispatchReplyWithBufferedBlockDispatcher } = installRuntime({
      commandAuthorized: false,
    });
    const cfg: OpenClawConfig = {
      channels: {
        zalouser: {
          enabled: true,
        },
      },
    };
    const account = resolveZalouserAccountSync({ cfg, accountId: "default" });

    await processMessageThroughMonitor({
      message: createGroupMessage({
        content: "ping @bot",
        hasAnyMention: true,
        wasExplicitlyMentioned: true,
      }),
      account,
      config: cfg,
      runtime: createRuntimeEnv(),
    });

    expect(account.config.groupPolicy).toBe("allowlist");
    expect(dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
  });

  it("fails closed when requireMention=true but mention detection is unavailable", async () => {
    await expectSkippedGroupMessage({
      canResolveExplicitMention: false,
      hasAnyMention: false,
      wasExplicitlyMentioned: false,
    });
  });

  it("dispatches explicitly-mentioned group messages and marks WasMentioned", async () => {
    const callArg = await dispatchGroupMessage({
      commandAuthorized: false,
      message: {
        hasAnyMention: true,
        wasExplicitlyMentioned: true,
        content: "ping @bot",
      },
    });
    expect(callArg?.ctx?.WasMentioned).toBe(true);
    expect(callArg?.ctx?.To).toBe("zalouser:group:g-1");
    expect(callArg?.ctx?.OriginatingTo).toBe("zalouser:group:g-1");
    expect(sendTypingZalouserMock).toHaveBeenCalledWith("g-1", {
      profile: "default",
      isGroup: true,
    });
  });

  it("allows authorized control commands to bypass mention gating", async () => {
    const callArg = await dispatchGroupMessage({
      commandAuthorized: true,
      message: {
        content: "/status",
        hasAnyMention: false,
        wasExplicitlyMentioned: false,
      },
    });
    expect(callArg?.ctx?.WasMentioned).toBe(true);
  });

  it("passes long markdown replies through once so formatting happens before chunking", async () => {
    const replyText = `**${"a".repeat(2501)}**`;
    const statusSink = vi.fn();
    installRuntime({
      commandAuthorized: false,
      replyPayload: { text: replyText },
    });

    await processMessageThroughMonitor({
      message: createDmMessage(),
      account: createAccount(),
      config: createConfig(),
      runtime: createRuntimeEnv(),
      statusSink,
    });

    expect(sendMessageZalouserMock).toHaveBeenCalledTimes(1);
    expect(sendMessageZalouserMock).toHaveBeenCalledWith("u-1", replyText, {
      isGroup: false,
      profile: "default",
      textMode: "markdown",
      textChunkMode: "length",
      textChunkLimit: 1200,
      onDeliveryResult: expect.any(Function),
    });
    expect(statusSink).toHaveBeenCalledWith({ lastOutboundAt: expect.any(Number) });
  });

  it.each([
    {
      name: "text block",
      kind: "block" as const,
      payload: { text: "reply" },
    },
    {
      name: "first attachment tool",
      kind: "tool" as const,
      payload: { text: "caption", mediaUrls: ["https://a/1"] },
    },
    {
      name: "later attachment block",
      kind: "block" as const,
      payload: {
        text: "caption",
        mediaUrls: ["https://a/1", "https://a/2", "https://a/3"],
      },
      partial: true,
      successfulSends: 1,
    },
    {
      name: "later text chunk block",
      kind: "block" as const,
      payload: { text: "reply" },
      partial: true,
    },
  ])("reports $name delivery failures through the canonical dispatcher", async (testCase) => {
    const failure = new Error(`${testCase.name} unavailable`);
    if (testCase.partial) {
      vi.mocked(sendMessageZalouser).mockImplementationOnce(async (_threadId, _text, options) => {
        const result = {
          ok: true,
          messageId: "accepted-1",
          receipt: createZalouserSendReceipt({ messageId: "accepted-1", threadId: "u-1" }),
        };
        await options?.onDeliveryResult?.(result);
        if (!testCase.successfulSends) {
          throw failure;
        }
        return result;
      });
    }
    if (!testCase.partial || testCase.successfulSends) {
      sendMessageZalouserMock.mockRejectedValueOnce(failure);
    }
    const runtime = { ...createRuntimeEnv(), error: vi.fn() };
    const statusSink = vi.fn();
    const { deliveryErrors } = installRuntime({
      replyPayload: testCase.payload,
      replyKind: testCase.kind,
    });

    await processMessageThroughMonitor({
      message: createDmMessage(),
      account: createAccount(),
      config: createConfig(),
      runtime,
      statusSink,
    });

    expect(sendMessageZalouserMock).toHaveBeenCalledTimes((testCase.successfulSends ?? 0) + 1);
    expect(runtime.error).toHaveBeenCalledTimes(1);
    expect(runtime.error).toHaveBeenCalledWith(
      `[default] Zalouser ${testCase.kind} reply failed: Error: ${testCase.name} unavailable`,
    );
    expect(deliveryErrors).toHaveLength(1);
    if (testCase.partial) {
      expect(deliveryErrors[0]).toMatchObject({
        cause: failure,
        sentBeforeError: true,
        deliveryResult: { messageIds: ["accepted-1"], visibleReplySent: true },
      });
      expect(statusSink).toHaveBeenCalledWith({ lastOutboundAt: expect.any(Number) });
    } else {
      expect(deliveryErrors[0]).toBe(failure);
      expect(statusSink).not.toHaveBeenCalledWith({ lastOutboundAt: expect.any(Number) });
    }
    if (testCase.successfulSends) {
      expect(sendMessageZalouserMock).toHaveBeenNthCalledWith(
        1,
        "u-1",
        "caption",
        expect.objectContaining({ mediaUrl: "https://a/1" }),
      );
      expect(sendMessageZalouserMock).toHaveBeenNthCalledWith(
        2,
        "u-1",
        "",
        expect.objectContaining({ mediaUrl: "https://a/2" }),
      );
    }
  });

  it("sanitizes custom inbound replies while preserving media delivery", async () => {
    const { actualKernelDispatchResults } = installRuntime({
      commandAuthorized: false,
      replyPayload: {
        text: "Done.\n⚠️ 🛠️ `search repos (agent)` failed",
        mediaUrl: "https://example.com/a.png",
      },
      useActualKernel: true,
    });

    await processMessageThroughMonitor({
      message: createDmMessage({ threadId: "u-mixed", msgId: "dm-mixed" }),
      account: createAccount(),
      config: await createKernelProofConfig(),
      runtime: createRuntimeEnv(),
    });

    expect(actualKernelDispatchResults).toMatchObject([
      { dispatched: true, dispatchResult: { queuedFinal: false } },
    ]);
    expect(sendMessageZalouserMock).toHaveBeenCalledOnce();
    expect(sendMessageZalouserMock).toHaveBeenCalledWith(
      "u-mixed",
      "Done.",
      expect.objectContaining({
        isGroup: false,
        mediaUrl: "https://example.com/a.png",
        profile: "default",
        textChunkLimit: 1200,
        textChunkMode: "length",
        textMode: "markdown",
      }),
    );
  });

  it("suppresses trace-only custom inbound replies", async () => {
    const { actualKernelDispatchResults } = installRuntime({
      commandAuthorized: false,
      replyPayload: { text: "⚠️ 🛠️ `search repos (agent)` failed" },
      useActualKernel: true,
    });

    await processMessageThroughMonitor({
      message: createDmMessage({ threadId: "u-trace", msgId: "dm-trace" }),
      account: createAccount(),
      config: await createKernelProofConfig(),
      runtime: createRuntimeEnv(),
    });

    expect(actualKernelDispatchResults).toHaveLength(1);
    expect(sendMessageZalouserMock).not.toHaveBeenCalled();
  });

  it("passes ordinary markdown through the actual inbound turn kernel", async () => {
    const replyText = "**Done.**\n\n- first\n- second";
    const { actualKernelDispatchResults } = installRuntime({
      commandAuthorized: false,
      replyPayload: { text: replyText },
      useActualKernel: true,
    });

    await processMessageThroughMonitor({
      message: createDmMessage({ threadId: "u-markdown", msgId: "dm-markdown" }),
      account: createAccount(),
      config: await createKernelProofConfig(),
      runtime: createRuntimeEnv(),
    });

    expect(actualKernelDispatchResults).toMatchObject([
      { dispatched: true, dispatchResult: { queuedFinal: false } },
    ]);
    expect(sendMessageZalouserMock).toHaveBeenCalledOnce();
    expect(sendMessageZalouserMock).toHaveBeenCalledWith(
      "u-markdown",
      replyText,
      expect.objectContaining({ textMode: "markdown" }),
    );
  });

  it("sanitizes a tool-result caption once across multi-media delivery", async () => {
    const { actualKernelDispatchResults } = installRuntime({
      commandAuthorized: false,
      replyKind: "tool",
      replyPayload: {
        text: "Caption.\n⚠️ 🛠️ `search repos (agent)` failed",
        mediaUrls: ["https://example.com/a.png", "https://example.com/b.png"],
      },
      useActualKernel: true,
    });

    await processMessageThroughMonitor({
      message: createDmMessage({ threadId: "u-tool", msgId: "dm-tool" }),
      account: createAccount(),
      config: {
        ...(await createKernelProofConfig()),
        agents: { defaults: { verboseDefault: "on" } },
      },
      runtime: createRuntimeEnv(),
    });

    expect(actualKernelDispatchResults).toMatchObject([
      { dispatched: true, dispatchResult: { queuedFinal: false } },
    ]);
    expect(sendMessageZalouserMock).toHaveBeenCalledTimes(2);
    expect(sendMessageZalouserMock).toHaveBeenNthCalledWith(
      1,
      "u-tool",
      "Caption.",
      expect.objectContaining({ mediaUrl: "https://example.com/a.png" }),
    );
    expect(sendMessageZalouserMock).toHaveBeenNthCalledWith(
      2,
      "u-tool",
      "",
      expect.objectContaining({ mediaUrl: "https://example.com/b.png" }),
    );
  });

  it("allows DM senders from static access groups", async () => {
    const { dispatchReplyWithBufferedBlockDispatcher } = installRuntime({
      commandAuthorized: false,
    });
    await processMessageThroughMonitor({
      message: createDmMessage({ senderId: "321" }),
      account: {
        ...createAccount(),
        config: {
          ...createAccount().config,
          dmPolicy: "allowlist",
          allowFrom: ["accessGroup:operators"],
        },
      },
      config: {
        ...createConfig(),
        accessGroups: {
          operators: {
            type: "message.senders",
            members: { zalouser: ["321"] },
          },
        },
      },
      runtime: createRuntimeEnv(),
    });

    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
  });

  it("uses commandContent for mention-prefixed control commands", async () => {
    const callArg = await dispatchGroupMessage({
      commandAuthorized: true,
      message: {
        content: "@Bot /new",
        commandContent: "/new",
        hasAnyMention: true,
        wasExplicitlyMentioned: true,
      },
    });
    expect(callArg?.ctx?.CommandBody).toBe("/new");
    expect(callArg?.ctx?.BodyForCommands).toBe("/new");
  });

  it("allows group control commands when only allowFrom is configured", async () => {
    await expectGroupCommandAuthorizers({
      accountConfig: {
        ...createAccount().config,
        allowFrom: ["123"],
      },
      expectedCommandAuthorized: true,
    });
  });

  it("blocks routed allowlist groups without an explicit group sender allowlist", async () => {
    const { dispatchReplyWithBufferedBlockDispatcher } = installRuntime({
      commandAuthorized: false,
    });
    await processMessageThroughMonitor({
      message: createGroupMessage({
        content: "ping @bot",
        hasAnyMention: true,
        wasExplicitlyMentioned: true,
        senderId: "456",
      }),
      account: {
        ...createAccount(),
        config: {
          ...createAccount().config,
          groupPolicy: "allowlist",
          allowFrom: ["123"],
          groups: {
            "group:g-1": { enabled: true, requireMention: true },
          },
        },
      },
      config: createConfig(),
      runtime: createRuntimeEnv(),
    });

    expect(dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
  });

  it("allows group senders from static access groups", async () => {
    const { dispatchReplyWithBufferedBlockDispatcher } = installRuntime({
      commandAuthorized: false,
    });
    await processMessageThroughMonitor({
      message: createGroupMessage({
        content: "ping @bot",
        hasAnyMention: true,
        wasExplicitlyMentioned: true,
        senderId: "123",
      }),
      account: {
        ...createAccount(),
        config: {
          ...createAccount().config,
          groupPolicy: "allowlist",
          groupAllowFrom: ["accessGroup:operators"],
        },
      },
      config: {
        ...createConfig(),
        accessGroups: {
          operators: {
            type: "message.senders",
            members: { zalouser: ["123"] },
          },
        },
      },
      runtime: createRuntimeEnv(),
    });

    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
  });

  it("blocks group messages when sender is not in groupAllowFrom", async () => {
    const { dispatchReplyWithBufferedBlockDispatcher } = installRuntime({
      commandAuthorized: false,
    });
    await processMessageThroughMonitor({
      message: createGroupMessage({
        content: "ping @bot",
        hasAnyMention: true,
        wasExplicitlyMentioned: true,
      }),
      account: {
        ...createAccount(),
        config: {
          ...createAccount().config,
          groupPolicy: "allowlist",
          allowFrom: ["999"],
          groupAllowFrom: ["999"],
        },
      },
      config: createConfig(),
      runtime: createRuntimeEnv(),
    });

    expect(dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
  });

  it("does not accept a different group id by matching only the mutable group name by default", async () => {
    await expectDangerousNameMatching({ expectedDispatches: 0 });
  });

  it("accepts mutable group-name matches only when dangerouslyAllowNameMatching is enabled", async () => {
    const dispatchReplyWithBufferedBlockDispatcher = await expectDangerousNameMatching({
      dangerouslyAllowNameMatching: true,
      expectedDispatches: 1,
    });
    const callArg = dispatchReplyCall(dispatchReplyWithBufferedBlockDispatcher);
    expect(callArg?.ctx?.To).toBe("zalouser:group:g-attacker-001");
  });

  it("does not resolve mutable allowlist or group names at startup by default", async () => {
    listZaloFriendsMock.mockResolvedValue([{ userId: "999", displayName: "Alice" }]);
    listZaloGroupsMock.mockResolvedValue([{ groupId: "g-other", name: "Trusted Team" }]);

    await startMonitorForStartupResolution({
      ...createAccount().config,
      dmPolicy: "allowlist",
      allowFrom: ["Alice"],
      groupPolicy: "allowlist",
      groupAllowFrom: ["Alice"],
      groups: {
        "Trusted Team": { enabled: true },
      },
    });

    expect(listZaloFriendsMock).not.toHaveBeenCalled();
    expect(listZaloGroupsMock).not.toHaveBeenCalled();
  });

  it("resolves mutable allowlist and group names at startup when enabled", async () => {
    listZaloFriendsMock.mockResolvedValue([{ userId: "123", displayName: "Alice" }]);
    listZaloGroupsMock.mockResolvedValue([{ groupId: "g-trusted", name: "Trusted Team" }]);

    await startMonitorForStartupResolution({
      ...createAccount().config,
      dangerouslyAllowNameMatching: true,
      dmPolicy: "allowlist",
      allowFrom: ["Alice"],
      groupPolicy: "allowlist",
      groupAllowFrom: ["Alice"],
      groups: {
        "Trusted Team": { enabled: true },
      },
    });

    expect(listZaloFriendsMock).toHaveBeenCalledWith("default");
    expect(listZaloGroupsMock).toHaveBeenCalledWith("default");
  });

  it("allows group control commands when sender is in groupAllowFrom", async () => {
    await expectGroupCommandAuthorizers({
      accountConfig: {
        ...createAccount().config,
        allowFrom: ["999"],
        groupAllowFrom: ["123"],
      },
      expectedCommandAuthorized: true,
    });
  });

  it("routes DM messages with direct peer kind", async () => {
    const { dispatchReplyWithBufferedBlockDispatcher, resolveAgentRoute } =
      await processOpenDmMessage();

    const routeInput = mockCallArg(resolveAgentRoute, "resolve agent route") as {
      peer?: unknown;
    };
    expect(routeInput?.peer).toEqual({ kind: "direct", id: "321" });
    const callArg = dispatchReplyCall(dispatchReplyWithBufferedBlockDispatcher);
    expect(callArg?.ctx?.SessionKey).toBe("agent:main:zalouser:direct:321");
  });

  it("surfaces quote metadata in inbound reply context", async () => {
    const { dispatchReplyWithBufferedBlockDispatcher } = await processOpenDmMessage({
      message: {
        quotedGlobalMsgId: "987654321234",
        quotedOwnerId: "555444333",
        quotedBody: "Previous bot message content",
      },
    });

    const callArg = dispatchReplyCall(dispatchReplyWithBufferedBlockDispatcher);
    expect(callArg?.ctx?.ReplyToId).toBe("987654321234");
    expect(callArg?.ctx?.ReplyToBody).toBe("Previous bot message content");
    expect(callArg?.ctx?.ReplyToIsQuote).toBe(true);
  });

  it("skips pairing store read for open DM control commands", async () => {
    const { readAllowFromStore } = installRuntime({
      commandAuthorized: false,
    });
    await processMessageThroughMonitor({
      message: createDmMessage({ content: "/new", commandContent: "/new" }),
      account: createAccount(),
      config: createConfig(),
      runtime: createRuntimeEnv(),
    });

    expect(readAllowFromStore).not.toHaveBeenCalled();
  });

  it("skips pairing store read for open DM non-command messages", async () => {
    const { readAllowFromStore } = installRuntime({
      commandAuthorized: false,
    });
    await processMessageThroughMonitor({
      message: createDmMessage({ content: "hello there" }),
      account: createAccount(),
      config: createConfig(),
      runtime: createRuntimeEnv(),
    });

    expect(readAllowFromStore).not.toHaveBeenCalled();
  });

  it("includes skipped group messages as InboundHistory on the next processed message", async () => {
    const { dispatchReplyWithBufferedBlockDispatcher } = installRuntime({
      commandAuthorized: false,
    });
    const account = createAccount();
    const config = createConfig();
    await processMessageThroughMonitor({
      messages: [
        createGroupMessage({
          content: "first unmentioned line",
          msgId: "history-1",
          timestampMs: 1700000000000,
          hasAnyMention: false,
          wasExplicitlyMentioned: false,
        }),
        createGroupMessage({
          content: "second line @bot",
          msgId: "history-2",
          hasAnyMention: true,
          wasExplicitlyMentioned: true,
        }),
        createGroupMessage({
          content: "third line @bot",
          msgId: "history-3",
          hasAnyMention: true,
          wasExplicitlyMentioned: true,
        }),
      ],
      account,
      config,
      runtime: createRuntimeEnv(),
      historyState: { historyLimit: 5 },
    });
    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(2);
    const firstDispatch = dispatchReplyCall(dispatchReplyWithBufferedBlockDispatcher);
    expect(firstDispatch?.ctx?.InboundHistory).toEqual([
      {
        sender: "Alice",
        body: "first unmentioned line",
        messageId: "history-1",
        timestamp: 1700000000000,
      },
    ]);
    expect(firstDispatch?.ctx?.Body ?? "").toContain("first unmentioned line");

    const secondDispatch = dispatchReplyCall(dispatchReplyWithBufferedBlockDispatcher, 1);
    expect(secondDispatch?.ctx?.InboundHistory).toStrictEqual([]);
  });
});
