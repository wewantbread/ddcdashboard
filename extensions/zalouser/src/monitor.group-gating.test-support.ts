import { dispatchChannelInboundTurn } from "openclaw/plugin-sdk/channel-inbound";
// Zalouser helpers support monitor group-gating tests.
import { createChannelMessageReplyPipeline } from "openclaw/plugin-sdk/channel-outbound";
import { vi } from "vitest";
import type { OpenClawConfig, PluginRuntime } from "../runtime-api.js";
import { setZalouserRuntime } from "./runtime.js";

type DispatchReplyCallArg = {
  ctx?: {
    Body?: string;
    BodyForCommands?: string;
    CommandAuthorized?: boolean;
    CommandBody?: string;
    InboundHistory?: unknown;
    OriginatingTo?: string;
    ReplyToBody?: string;
    ReplyToId?: string;
    ReplyToIsQuote?: boolean;
    SessionKey?: string;
    To?: string;
    WasMentioned?: boolean;
  };
};

export function mockCallArg(mock: unknown, label: string, index = 0) {
  const call = (mock as { mock?: { calls?: unknown[][] } }).mock?.calls?.at(index);
  if (!call) {
    throw new Error(`Expected ${label} call ${index + 1}`);
  }
  return call[0];
}

export function dispatchReplyCall(mock: unknown, index = 0): DispatchReplyCallArg {
  return mockCallArg(mock, "dispatch reply", index) as DispatchReplyCallArg;
}

export function installRuntime(params: {
  commandAuthorized?: boolean;
  replyPayload?: { text?: string; mediaUrl?: string; mediaUrls?: string[] };
  replyKind?: "block" | "tool";
  useActualKernel?: boolean;
  resolveCommandAuthorizedFromAuthorizers?: (params: {
    useAccessGroups: boolean;
    authorizers: Array<{ configured: boolean; allowed: boolean }>;
  }) => boolean;
}) {
  const deliveryErrors: unknown[] = [];
  const actualKernelDispatchResults: Awaited<ReturnType<typeof dispatchChannelInboundTurn>>[] = [];
  const dispatchReplyWithBufferedBlockDispatcher = vi.fn(async ({ dispatcherOptions, ctx }) => {
    await dispatcherOptions.typingCallbacks?.onReplyStart?.();
    if (params.replyPayload) {
      const info = { kind: params.replyKind ?? "block" };
      try {
        await dispatcherOptions.deliver(params.replyPayload, info);
      } catch (error) {
        deliveryErrors.push(error);
        dispatcherOptions.onError(error, info);
      }
    }
    return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 }, ctx };
  });
  const resolveCommandAuthorizedFromAuthorizers = vi.fn(
    (input: {
      useAccessGroups: boolean;
      authorizers: Array<{ configured: boolean; allowed: boolean }>;
    }) => {
      if (params.resolveCommandAuthorizedFromAuthorizers) {
        return params.resolveCommandAuthorizedFromAuthorizers(input);
      }
      return params.commandAuthorized ?? false;
    },
  );
  const resolveAgentRoute = vi.fn(
    (input: { dmScope?: string; peer?: { kind?: string; id?: string } }) => {
      const peerKind = input.peer?.kind === "direct" ? "direct" : "group";
      const peerId = input.peer?.id ?? "1";
      return {
        agentId: "main",
        sessionKey:
          peerKind === "direct" && input.dmScope === "main"
            ? "agent:main:main"
            : `agent:main:zalouser:${peerKind}:${peerId}`,
        accountId: "default",
        mainSessionKey: "agent:main:main",
      };
    },
  );
  const readAllowFromStore = vi.fn(async () => []);
  type TurnPlan = Parameters<PluginRuntime["channel"]["inbound"]["dispatch"]>[0];
  const recordInboundSession = vi.fn(async (_params: unknown) => {});
  const dispatch = vi.fn(async (plan: TurnPlan) => {
    if (params.useActualKernel) {
      const sessionMetaTasks: Promise<unknown>[] = [];
      const result = await dispatchChannelInboundTurn({
        ...plan,
        record: {
          ...plan.record,
          trackSessionMetaTask: (task) => {
            sessionMetaTasks.push(task);
            plan.record?.trackSessionMetaTask?.(task);
          },
        },
        replyResolver: async (_ctx, options) => {
          if (params.replyKind === "tool") {
            await options?.onToolResult?.(params.replyPayload ?? {});
          } else {
            await options?.onBlockReply?.(params.replyPayload ?? {});
          }
          return undefined;
        },
      });
      await Promise.all(sessionMetaTasks);
      actualKernelDispatchResults.push(result);
      return result;
    }
    const turn = {
      ...plan,
      agentId: plan.route.agentId,
      routeSessionKey: plan.route.sessionKey,
      storePath: "/tmp",
      recordInboundSession,
      dispatchReplyWithBufferedBlockDispatcher,
    };
    await turn.recordInboundSession({
      storePath: turn.storePath,
      sessionKey: turn.ctxPayload.SessionKey ?? turn.routeSessionKey,
      ctx: turn.ctxPayload,
      groupResolution: turn.record?.groupResolution,
      createIfMissing: turn.record?.createIfMissing,
      updateLastRoute: turn.record?.updateLastRoute,
      onRecordError: turn.record?.onRecordError ?? (() => undefined),
    });
    const { onModelSelected, ...replyPipeline } = createChannelMessageReplyPipeline({
      cfg: turn.cfg,
      agentId: turn.agentId,
      channel: "zalouser",
      accountId: turn.accountId,
      ...turn.replyPipeline,
    });
    const dispatchResult = await turn.dispatchReplyWithBufferedBlockDispatcher({
      ctx: turn.ctxPayload,
      cfg: turn.cfg,
      dispatcherOptions: {
        ...replyPipeline,
        ...turn.dispatcherOptions,
        deliver: async (...args: Parameters<typeof turn.delivery.deliver>) => {
          const info = args[1] ?? { kind: "final" as const };
          const payload = turn.delivery.preparePayload
            ? await turn.delivery.preparePayload(args[0], info)
            : args[0];
          if (payload === null) {
            const result = {
              visibleReplySent: false,
              suppression: { reason: "no_visible_payload" as const },
            };
            await turn.delivery.onDelivered?.(args[0], info, result);
            return result;
          }
          const result = await turn.delivery.deliver(payload, info);
          await turn.delivery.onDelivered?.(payload, info, result);
          return result;
        },
        onError: turn.delivery.onError,
      },
      replyOptions: {
        onModelSelected,
        ...turn.replyOptions,
      },
      replyResolver: turn.replyResolver,
    });
    return {
      admission: { kind: "dispatch" as const },
      dispatched: true,
      ctxPayload: turn.ctxPayload,
      routeSessionKey: turn.routeSessionKey,
      dispatchResult,
    };
  });
  const buildContext = vi.fn(
    (paramsLocal: Parameters<PluginRuntime["channel"]["inbound"]["buildContext"]>[0]) =>
      ({
        Body: paramsLocal.message.body ?? paramsLocal.message.rawBody,
        BodyForAgent: paramsLocal.message.bodyForAgent ?? paramsLocal.message.rawBody,
        InboundHistory: paramsLocal.message.inboundHistory,
        RawBody: paramsLocal.message.rawBody,
        CommandBody: paramsLocal.message.commandBody ?? paramsLocal.message.rawBody,
        BodyForCommands: paramsLocal.message.commandBody ?? paramsLocal.message.rawBody,
        From: paramsLocal.from,
        To: paramsLocal.reply.to,
        SessionKey: paramsLocal.route.dispatchSessionKey ?? paramsLocal.route.routeSessionKey,
        AccountId: paramsLocal.route.accountId ?? paramsLocal.accountId,
        ChatType: paramsLocal.conversation.kind,
        ConversationLabel: paramsLocal.conversation.label,
        SenderName: paramsLocal.sender.name,
        SenderId: paramsLocal.sender.id,
        Provider: paramsLocal.provider ?? paramsLocal.channel,
        Surface: paramsLocal.surface ?? paramsLocal.provider ?? paramsLocal.channel,
        MessageSid: paramsLocal.messageId,
        MessageSidFull: paramsLocal.messageIdFull,
        OriginatingChannel: paramsLocal.channel,
        OriginatingTo: paramsLocal.reply.originatingTo,
        ...paramsLocal.extra,
      }) as Awaited<ReturnType<PluginRuntime["channel"]["inbound"]["buildContext"]>>,
  );
  setZalouserRuntime({
    logging: {
      shouldLogVerbose: () => false,
    },
    channel: {
      pairing: {
        readAllowFromStore,
        upsertPairingRequest: vi.fn(async () => ({ code: "PAIR", created: true })),
        buildPairingReply: vi.fn(() => "pair"),
      },
      commands: {
        shouldComputeCommandAuthorized: vi.fn((body: string) => body.trim().startsWith("/")),
        resolveCommandAuthorizedFromAuthorizers,
        isControlCommandMessage: vi.fn((body: string) => body.trim().startsWith("/")),
        shouldHandleTextCommands: vi.fn(() => true),
      },
      mentions: {
        buildMentionRegexes: vi.fn(() => []),
        matchesMentionWithExplicit: vi.fn(
          (input) => input.explicit?.isExplicitlyMentioned === true,
        ),
      },
      groups: {
        resolveRequireMention: vi.fn((input) => {
          const cfg = input.cfg as OpenClawConfig;
          const groupCfg = cfg.channels?.zalouser?.groups ?? {};
          const typedGroupCfg = groupCfg as Record<string, { requireMention?: boolean }>;
          const groupEntry = input.groupId ? typedGroupCfg[input.groupId] : undefined;
          const defaultEntry = typedGroupCfg["*"];
          if (typeof groupEntry?.requireMention === "boolean") {
            return groupEntry.requireMention;
          }
          if (typeof defaultEntry?.requireMention === "boolean") {
            return defaultEntry.requireMention;
          }
          return true;
        }),
      },
      routing: {
        resolveAgentRoute,
      },
      session: {
        resolveStorePath: vi.fn(() => "/tmp"),
        recordInboundSession,
      },
      reply: {
        resolveEnvelopeFormatOptions: vi.fn(() => undefined),
        formatAgentEnvelope: vi.fn(({ body }) => body),
        finalizeInboundContext: vi.fn((ctx) => ctx),
        dispatchReplyWithBufferedBlockDispatcher,
      },
      inbound: {
        dispatch,
        buildContext:
          buildContext as unknown as PluginRuntime["channel"]["inbound"]["buildContext"],
      },
      text: {
        resolveMarkdownTableMode: vi.fn(() => "code"),
        convertMarkdownTables: vi.fn((text: string) => text),
        resolveChunkMode: vi.fn(() => "length"),
        resolveTextChunkLimit: vi.fn(() => 1200),
        chunkMarkdownTextWithMode: vi.fn((text: string) => [text]),
      },
    },
  } as unknown as PluginRuntime);

  return {
    actualKernelDispatchResults,
    deliveryErrors,
    dispatchReplyWithBufferedBlockDispatcher,
    resolveAgentRoute,
    resolveCommandAuthorizedFromAuthorizers,
    readAllowFromStore,
  };
}

export function installGroupCommandAuthRuntime() {
  return installRuntime({
    resolveCommandAuthorizedFromAuthorizers: ({ useAccessGroups, authorizers }) =>
      useAccessGroups && authorizers.some((entry) => entry.configured && entry.allowed),
  });
}
