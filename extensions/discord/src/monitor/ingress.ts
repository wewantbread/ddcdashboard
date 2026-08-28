// Discord plugin module owns raw gateway-message durable ingress and replay draining.
import {
  ChannelType,
  GatewayDispatchEvents,
  MessageReferenceType,
  MessageType,
  type APIMessage,
} from "discord-api-types/v10";
import {
  createChannelIngressError,
  createChannelIngressMonitor,
  DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS,
  type ChannelIngressQueue,
  type ChannelIngressMonitorDeliveryResult,
  type ChannelIngressMonitorLifecycle,
} from "openclaw/plugin-sdk/channel-outbound";
import { hasControlCommand } from "openclaw/plugin-sdk/command-detection";
import { shouldHandleTextCommands } from "openclaw/plugin-sdk/command-surface";
import type { DiscordAccountConfig, OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { danger, type RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import {
  isRecord,
  normalizeNullableString as nonEmptyString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import type { Client } from "../internal/discord.js";
import { mapGatewayDispatchData } from "../internal/gateway-dispatch.js";
import { getDiscordRuntime } from "../runtime.js";
import {
  normalizeDiscordSlug,
  resolveDiscordChannelConfigWithFallback,
  resolveDiscordGuildEntry,
  type DiscordGuildEntryResolved,
} from "./allow-list.js";
import { resolveDiscordChannelInfoSafe } from "./channel-access.js";
import type { DiscordMessageEvent } from "./listeners.js";
import { hasRawDiscordUserMention } from "./message-handler.raw-mention.js";

const DISCORD_INGRESS_PAYLOAD_VERSION = 1;
const DISCORD_INGRESS_DRAIN_INTERVAL_MS = 1_000;
const DISCORD_STALE_AMBIENT_BACKLOG_MS = 15 * 60 * 1_000;
const DISCORD_AUDIO_ATTACHMENT_EXTENSIONS =
  /\.(?:aac|caf|flac|m4a|mp3|oga|ogg|opus|wav)(?:[?#]|$)/i;
const loadMentionRuntime = createLazyRuntimeModule(
  () => import("openclaw/plugin-sdk/channel-inbound"),
);

type DiscordGatewayAttachment = APIMessage["attachments"][number] & {
  contentType?: unknown;
};

/**
 * Raw MESSAGE_CREATE frame. The gateway forwards optional envelope extras that
 * `APIMessage` does not declare; the durable queue stores the frame verbatim, so
 * they must be typed here rather than cast at each read site.
 */
type DiscordGatewayMessage = Omit<APIMessage, "attachments"> & {
  attachments: DiscordGatewayAttachment[];
  channel?: unknown;
  channel_type?: unknown;
  guild_id?: unknown;
};

/** Closed channel-kind fact persisted at durable admission. */
type DiscordIngressChannelKind = "non-thread" | "thread";

type DiscordIngressPayload = {
  version: 1;
  receivedAt: number;
  rawMessage: DiscordGatewayMessage;
  channelKind?: DiscordIngressChannelKind;
};

type DiscordIngressBody = Omit<DiscordIngressPayload, "version">;

/** Narrowed view of an unvalidated pending row's stored payload. */
type DiscordIngressPendingRow = {
  rawMessage: DiscordGatewayMessage;
  payloadReceivedAt: number | null;
  channelKind: DiscordIngressChannelKind | undefined;
};

export type DiscordIngressLifecycle = Omit<ChannelIngressMonitorLifecycle, "admission">;

export type DiscordIngressDispatchResult = ChannelIngressMonitorDeliveryResult;

type DiscordIngressDispatch = (
  event: DiscordMessageEvent,
  lifecycle: DiscordIngressLifecycle,
) => Promise<DiscordIngressDispatchResult | void> | DiscordIngressDispatchResult | void;

type DiscordThreadBindingLookup = {
  getByThreadId?: (threadId: string) => unknown;
  listBySessionKey?: (targetSessionKey: string) => unknown[];
  touchThread?: (params: { threadId: string; at?: number; persist?: boolean }) => unknown;
};

type DiscordIngressMonitor = {
  accept: (rawMessage: DiscordGatewayMessage) => Promise<void>;
  start: () => void;
  stop: () => Promise<void>;
};

const DiscordIngressPayloadError = createChannelIngressError("DiscordIngressPayloadError");

/** Identity facts every durable Discord row must carry. Null means unusable. */
function readDiscordMessageFacts(rawMessage: unknown): { eventId: string; laneKey: string } | null {
  if (!isRecord(rawMessage)) {
    return null;
  }
  const eventId = nonEmptyString(rawMessage.id);
  const channelId = nonEmptyString(rawMessage.channel_id);
  if (!eventId || !channelId) {
    return null;
  }
  return { eventId, laneKey: `channel:${channelId}` };
}

function inspectDiscordMessage(rawMessage: unknown): { eventId: string; laneKey: string } {
  if (!isRecord(rawMessage)) {
    throw new DiscordIngressPayloadError("Discord MESSAGE_CREATE payload must be an object");
  }
  if (!nonEmptyString(rawMessage.id)) {
    throw new DiscordIngressPayloadError("Discord MESSAGE_CREATE payload is missing its snowflake");
  }
  const facts = readDiscordMessageFacts(rawMessage);
  if (!facts) {
    throw new DiscordIngressPayloadError("Discord MESSAGE_CREATE payload is missing channel_id");
  }
  return facts;
}

/**
 * Maps a gateway channel type onto the closed kind the stale fence needs.
 * Undefined means unproven: `channel_type` is optional on MESSAGE_CREATE, and an
 * absent or unrecognized value must never be read as "definitely not a thread".
 */
function resolveDiscordIngressChannelKind(type: unknown): DiscordIngressChannelKind | undefined {
  if (isDiscordThreadChannelType(type)) {
    return "thread";
  }
  if (
    type === ChannelType.GuildText ||
    type === ChannelType.GuildAnnouncement ||
    type === ChannelType.GuildVoice ||
    type === ChannelType.GuildStageVoice ||
    type === ChannelType.DM ||
    type === ChannelType.GroupDM
  ) {
    return "non-thread";
  }
  return undefined;
}

function decodeDiscordIngressChannelKind(value: unknown): DiscordIngressChannelKind | undefined {
  return value === "non-thread" || value === "thread" ? value : undefined;
}

/**
 * Pending rows are unvalidated stored bytes: the payload codec only runs at claim
 * time. Null means the row is corrupt rather than a policy question, so the
 * caller must leave it to the canonical claim-time invalid-event owner.
 */
function readDiscordIngressPendingRow(payload: unknown): DiscordIngressPendingRow | null {
  if (!isRecord(payload)) {
    return null;
  }
  const rawMessage = payload.rawMessage;
  if (!readDiscordMessageFacts(rawMessage)) {
    return null;
  }
  const gatewayMessage = rawMessage as DiscordGatewayMessage;
  const payloadReceivedAt = payload.receivedAt;
  return {
    rawMessage: gatewayMessage,
    payloadReceivedAt:
      typeof payloadReceivedAt === "number" && Number.isFinite(payloadReceivedAt)
        ? payloadReceivedAt
        : null,
    channelKind:
      decodeDiscordIngressChannelKind(payload.channelKind) ??
      resolveDiscordIngressChannelKind(gatewayMessage.channel_type),
  };
}

function decodeDiscordIngressPayload(
  payload: DiscordIngressPayload,
  claimedId: string,
): { version: unknown; body: DiscordIngressBody } {
  const row = readDiscordIngressPendingRow(payload);
  if (!row) {
    throw new DiscordIngressPayloadError(`Discord ingress payload ${claimedId} is invalid`);
  }
  return {
    version: (payload as Partial<DiscordIngressPayload>).version,
    body: {
      receivedAt: row.payloadReceivedAt as number,
      rawMessage: row.rawMessage,
      ...(row.channelKind ? { channelKind: row.channelKind } : {}),
    },
  };
}

function isDiscordAuthenticationFailure(error: unknown): boolean {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const candidate = current as { status?: unknown; statusCode?: unknown; cause?: unknown };
    if (candidate.status === 401 || candidate.statusCode === 401) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}

function discordMessageSentAtMs(rawMessage: DiscordGatewayMessage): number | null {
  const sentAt = Date.parse(rawMessage.timestamp);
  return Number.isFinite(sentAt) ? sentAt : null;
}

/**
 * Age anchor for the freshness fence. A durable row re-admitted later than the
 * payload recorded is treated as arriving then, so a replayed row cannot be aged
 * out by its original send time.
 */
function discordIngressRowSentAtMs(
  record: { receivedAt: number },
  row: DiscordIngressPendingRow,
): number {
  const payloadReceivedAt = row.payloadReceivedAt ?? record.receivedAt;
  return record.receivedAt > payloadReceivedAt
    ? record.receivedAt
    : (discordMessageSentAtMs(row.rawMessage) ?? record.receivedAt);
}

function isDiscordGuildMessage(rawMessage: DiscordGatewayMessage): boolean {
  return typeof rawMessage.guild_id === "string";
}

function hasPotentialDiscordAudioAttachment(rawMessage: DiscordGatewayMessage): boolean {
  for (const attachment of rawMessage.attachments ?? []) {
    const contentType = nonEmptyString(attachment.content_type ?? attachment.contentType);
    if (contentType?.startsWith("audio/")) {
      return true;
    }
    if (typeof attachment.duration_secs === "number") {
      return true;
    }
    if (nonEmptyString(attachment.waveform)) {
      return true;
    }
    const filename = nonEmptyString(attachment.filename);
    const url = nonEmptyString(attachment.url);
    if (
      (filename && DISCORD_AUDIO_ATTACHMENT_EXTENSIONS.test(filename)) ||
      (url && DISCORD_AUDIO_ATTACHMENT_EXTENSIONS.test(url))
    ) {
      return true;
    }
  }
  return false;
}

function listConfiguredAgentIds(cfg?: OpenClawConfig): string[] {
  const ids = new Set<string>();
  const agents = cfg?.agents;
  if (isRecord(agents?.entries)) {
    for (const id of Object.keys(agents.entries)) {
      const normalized = nonEmptyString(id);
      if (normalized) {
        ids.add(normalized);
      }
    }
  }
  for (const entry of agents?.list ?? []) {
    const normalized = nonEmptyString(entry?.id);
    if (normalized) {
      ids.add(normalized);
    }
  }
  return [...ids];
}

function isDiscordThreadChannelType(type: unknown): boolean {
  return (
    type === ChannelType.PublicThread ||
    type === ChannelType.PrivateThread ||
    type === ChannelType.AnnouncementThread
  );
}

function hasConfiguredDiscordChannels(guildInfo: DiscordGuildEntryResolved | null): boolean {
  return Boolean(guildInfo?.channels && Object.keys(guildInfo.channels).length > 0);
}

function hasCachedThreadChannel(rawMessage: DiscordGatewayMessage): boolean {
  const channel = rawMessage.channel;
  if (!isRecord(channel)) {
    return false;
  }
  const isThread = channel.isThread;
  if (typeof isThread === "function") {
    try {
      return isThread() === true;
    } catch {
      return true;
    }
  }
  return isDiscordThreadChannelType(channel.type);
}

function hasBoundThread(
  rawMessage: DiscordGatewayMessage,
  threadBindings?: DiscordThreadBindingLookup,
) {
  const channelId = nonEmptyString(rawMessage.channel_id);
  if (!channelId || typeof threadBindings?.getByThreadId !== "function") {
    return false;
  }
  try {
    return Boolean(threadBindings.getByThreadId(channelId));
  } catch {
    return true;
  }
}

function isDiscordAddressedMessage(rawMessage: DiscordGatewayMessage, botUserId?: string): boolean {
  if (!isDiscordGuildMessage(rawMessage)) {
    return true;
  }
  if (rawMessage.mention_everyone) {
    return true;
  }
  const botId = nonEmptyString(botUserId);
  if (!botId) {
    return true;
  }
  return (
    rawMessage.mentions?.some((user) => user.id === botId) ||
    rawMessage.referenced_message?.author?.id === botId ||
    hasRawDiscordUserMention(rawMessage.content ?? "", botId)
  );
}

function hasHydrateableDiscordReplyReference(rawMessage: DiscordGatewayMessage): boolean {
  const reference = rawMessage.message_reference;
  if (!reference || !nonEmptyString(reference.message_id)) {
    return false;
  }
  if (reference.type != null && reference.type !== MessageReferenceType.Default) {
    return false;
  }
  if (rawMessage.type != null && rawMessage.type !== MessageType.Reply) {
    return false;
  }
  if (!Object.hasOwn(rawMessage, "referenced_message")) {
    return true;
  }
  // A nested payload that does not answer the reference is not the referenced
  // message: preflight can still hydrate it, so addressability stays unproven.
  const nested = rawMessage.referenced_message;
  if (!isRecord(nested)) {
    return true;
  }
  return nonEmptyString(nested.id) !== nonEmptyString(reference.message_id);
}

function canExpireDiscordStaleAmbientBacklog(
  rawMessage: DiscordGatewayMessage,
  channelKind: DiscordIngressChannelKind | undefined,
  params: {
    guildEntries?: Record<string, DiscordGuildEntryResolved>;
  },
): boolean {
  // Only a positive non-thread fact proves this is not an unhydrated thread; an
  // unknown kind keeps the row claimable rather than expiring it unproven.
  if (!isDiscordGuildMessage(rawMessage) || channelKind !== "non-thread") {
    return false;
  }
  const guildInfo = resolveDiscordGuildEntry({
    guildId: nonEmptyString(rawMessage.guild_id),
    guildEntries: params.guildEntries,
  });
  if (params.guildEntries && Object.keys(params.guildEntries).length > 0 && !guildInfo) {
    return false;
  }

  const channelId = nonEmptyString(rawMessage.channel_id);
  const channelInfo = resolveDiscordChannelInfoSafe(rawMessage.channel);
  const channelSlug = channelInfo.name ? normalizeDiscordSlug(channelInfo.name) : "";
  const parentSlug = channelInfo.parentName ? normalizeDiscordSlug(channelInfo.parentName) : "";
  const channelConfig = channelId
    ? resolveDiscordChannelConfigWithFallback({
        guildInfo,
        channelId,
        channelName: channelInfo.name,
        channelSlug,
        parentId: channelInfo.parentId,
        parentName: channelInfo.parentName,
        parentSlug,
        scope: "channel",
      })
    : null;

  if (hasConfiguredDiscordChannels(guildInfo) && channelConfig?.allowed === false) {
    return false;
  }
  // Freshness is independent of room activation. Mention-gating still decides
  // who may speak; it must not keep day-old ambient rows claimable on
  // direct-open rooms. Unknown, thread, and DM rows already failed open above.
  return true;
}

async function matchesConfiguredDiscordMentionText(
  rawMessage: DiscordGatewayMessage,
  params: {
    cfg?: OpenClawConfig;
    discordConfig?: DiscordAccountConfig | null;
  },
): Promise<boolean> {
  const text = typeof rawMessage.content === "string" ? rawMessage.content : "";
  const conversationId = nonEmptyString(rawMessage.channel_id);
  const agentIds = listConfiguredAgentIds(params.cfg);
  // Audio-only messages can satisfy preflight after transcription; pre-claim
  // cannot transcribe, so a configured mention regex is enough to preserve them.
  const hasAudioOnlyMentionCandidate =
    !text.trim() && hasPotentialDiscordAudioAttachment(rawMessage);
  if (!text.trim() && !hasAudioOnlyMentionCandidate) {
    return false;
  }
  if (!params.cfg) {
    return false;
  }
  try {
    const { buildMentionRegexes, matchesMentionPatterns } = await loadMentionRuntime();
    for (const agentId of [undefined, ...agentIds]) {
      const mentionRegexes = buildMentionRegexes(params.cfg, agentId, {
        provider: "discord",
        conversationId,
        providerPolicy: params.discordConfig?.mentionPatterns,
      });
      if (hasAudioOnlyMentionCandidate && mentionRegexes.length > 0) {
        return true;
      }
      if (matchesMentionPatterns(text, mentionRegexes)) {
        return true;
      }
    }
  } catch {
    // Missing or rejected regex state makes addressability unproven, not ambient.
    return true;
  }
  return false;
}

function hasPotentialActiveDiscordTextControlCommand(
  rawMessage: DiscordGatewayMessage,
  cfg?: OpenClawConfig,
): boolean {
  const text = typeof rawMessage.content === "string" ? rawMessage.content : "";
  if (!hasControlCommand(text, cfg)) {
    return false;
  }
  try {
    return shouldHandleTextCommands({
      cfg: cfg ?? {},
      surface: "discord",
      commandSource: "text",
    });
  } catch {
    // Pre-claim cannot prove registry/surface state; preserve possible control
    // commands for the canonical preflight authorization gate.
    return true;
  }
}

async function hasUnresolvedDiscordAddressForm(
  rawMessage: DiscordGatewayMessage,
  params: {
    cfg?: OpenClawConfig;
    discordConfig?: DiscordAccountConfig | null;
    threadBindings?: DiscordThreadBindingLookup;
  },
): Promise<boolean> {
  // Pre-claim rows do not have route/preflight facts. Preserve rows when a
  // later preflight path may prove them addressed instead of dead-lettering.
  return (
    hasHydrateableDiscordReplyReference(rawMessage) ||
    hasBoundThread(rawMessage, params.threadBindings) ||
    hasCachedThreadChannel(rawMessage) ||
    (await matchesConfiguredDiscordMentionText(rawMessage, params))
  );
}

export function createDiscordIngressMonitor(params: {
  accountId: string;
  client: Client;
  runtime: Pick<RuntimeEnv, "error" | "log">;
  dispatch: DiscordIngressDispatch;
  botUserId?: string;
  cfg?: OpenClawConfig;
  discordConfig?: DiscordAccountConfig | null;
  guildEntries?: Record<string, DiscordGuildEntryResolved>;
  threadBindings?: DiscordThreadBindingLookup;
  queue?: ChannelIngressQueue<DiscordIngressPayload>;
  now?: () => number;
}): DiscordIngressMonitor {
  const queue =
    params.queue ??
    getDiscordRuntime().state.openChannelIngressQueue<DiscordIngressPayload>({
      accountId: params.accountId,
    });
  const monitor = createChannelIngressMonitor<
    DiscordGatewayMessage,
    DiscordIngressBody,
    DiscordIngressPayload
  >({
    queue,
    now: params.now,
    inspect: inspectDiscordMessage,
    payload: {
      version: DISCORD_INGRESS_PAYLOAD_VERSION,
      // The durable append is the first thing that happens to an inbound message
      // and must never wait on network I/O, so the kind is read from the gateway
      // envelope only. An absent channel_type persists no kind and fails open.
      serialize: (rawMessage, { receivedAt }) => {
        const channelKind = resolveDiscordIngressChannelKind(rawMessage.channel_type);
        return { receivedAt, rawMessage, ...(channelKind ? { channelKind } : {}) };
      },
      deserialize: (body) => body.rawMessage,
      encode: ({ body }) => ({ version: DISCORD_INGRESS_PAYLOAD_VERSION, ...body }),
      decode: (payload, { claim }) => decodeDiscordIngressPayload(payload, claim.id),
      createClaimError: (kind) =>
        new DiscordIngressPayloadError(
          kind === "invalid-version"
            ? "Discord ingress payload version is unsupported"
            : "Discord message identity changed after durable admission",
        ),
    },
    // Gateway mapping is intentionally delayed until after the durable claim.
    deliver: async (rawMessage, lifecycle) => {
      const event = mapGatewayDispatchData(
        params.client,
        GatewayDispatchEvents.MessageCreate,
        rawMessage,
      ) as DiscordMessageEvent;
      return await params.dispatch(event, lifecycle);
    },
    pollIntervalMs: DISCORD_INGRESS_DRAIN_INTERVAL_MS,
    retention: {
      // Discord previously pruned before every enqueue rather than on a timed cadence.
      pruneIntervalMs: 0,
      completedMaxEntries: 5_000,
      failedMaxEntries: 5_000,
    },
    appendRetryDelaysMs: [0],
    drain: {
      onPendingDispositionCommitted: (record, disposition, context) => {
        const row = readDiscordIngressPendingRow(record.payload);
        if (!row || disposition.kind !== "fail" || disposition.reason !== "stale-ambient-backlog") {
          return;
        }
        const rawMessage = row.rawMessage;
        params.runtime.log?.(
          {
            level: "debug",
            source: "discord",
            accountId: params.accountId,
            eventId: record.id,
            sourceEventId: rawMessage.id,
            laneKey: context.laneKey,
            channelId: rawMessage.channel_id,
            receivedAt: new Date(record.receivedAt).toISOString(),
            ageMs: Math.max(0, context.now - discordIngressRowSentAtMs(record, row)),
            thresholdMs: DISCORD_STALE_AMBIENT_BACKLOG_MS,
            disposition: "failed",
            reason: "stale-ambient-backlog",
          },
          "discord ingress stale ambient backlog suppressed",
        );
      },
      resolvePendingDisposition: async (record, context) => {
        const row = readDiscordIngressPendingRow(record.payload);
        if (!row) {
          // A stored payload this cannot narrow is corrupt, not a policy
          // question. Retaining it hands the row to the canonical claim-time
          // codec, which fails it once as invalid-event with the pump intact.
          return null;
        }
        const rawMessage = row.rawMessage;
        if (isDiscordAddressedMessage(rawMessage, params.botUserId)) {
          return null;
        }
        if (
          context.now - discordIngressRowSentAtMs(record, row) <=
          DISCORD_STALE_AMBIENT_BACKLOG_MS
        ) {
          return null;
        }
        if (hasPotentialActiveDiscordTextControlCommand(rawMessage, params.cfg)) {
          return null;
        }
        if (
          await hasUnresolvedDiscordAddressForm(rawMessage, {
            cfg: params.cfg,
            discordConfig: params.discordConfig,
            threadBindings: params.threadBindings,
          })
        ) {
          return null;
        }
        if (
          !canExpireDiscordStaleAmbientBacklog(rawMessage, row.channelKind, {
            guildEntries: params.guildEntries,
          })
        ) {
          return null;
        }
        return {
          kind: "fail",
          reason: "stale-ambient-backlog",
          message:
            `Discord ambient message ${record.id} on ${context.laneKey} is older than ` +
            `${DISCORD_STALE_AMBIENT_BACKLOG_MS}ms; suppressing stale backlog before dispatch.`,
        };
      },
      retryPolicy: {
        maxAttempts: DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS,
        deadLetterMinAgeMs: 0,
      },
      resolveNonRetryableFailure: (error) => {
        if (error instanceof DiscordIngressPayloadError) {
          return { reason: "invalid-event", message: error.message };
        }
        if (isDiscordAuthenticationFailure(error)) {
          return { reason: "authentication-failed", message: formatErrorMessage(error) };
        }
        return null;
      },
      onLog: (message) => params.runtime.error?.(danger(`discord ingress: ${message}`)),
    },
    onError: (error) =>
      params.runtime.error?.(danger(`discord ingress drain failed: ${formatErrorMessage(error)}`)),
  });

  return {
    accept: async (rawMessage) => {
      await monitor.admit(rawMessage);
    },
    start: monitor.start,
    stop: monitor.stop,
  };
}
