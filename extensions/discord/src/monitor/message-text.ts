// Discord plugin module implements message text behavior.
import { ComponentType } from "discord-api-types/v10";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { Message } from "../internal/discord.js";
import {
  collectActiveDiscordUserMentionIds,
  hasRawDiscordUserMention,
  rewriteRawDiscordUserMentions,
} from "../mentions.js";
import {
  formatDiscordSnapshotAuthor,
  normalizeDiscordMessageSnapshots,
  resolveDiscordMessageSnapshots,
  resolveDiscordMessageStickers,
  resolveDiscordReferencedForwardMessage,
  resolveDiscordSnapshotStickers,
  type DiscordSnapshotMessage,
} from "./message-forwarded.js";
import { formatDiscordMediaText } from "./message-media.js";

export function resolveDiscordEmbedText(
  embed?: { title?: string | null; description?: string | null } | null,
): string {
  const title = normalizeOptionalString(embed?.title) ?? "";
  const description = normalizeOptionalString(embed?.description) ?? "";
  if (title && description) {
    return `${title}\n${description}`;
  }
  return title || description || "";
}

export function resolveDiscordMessageText(
  message: Message,
  options?: { fallbackText?: string; includeForwarded?: boolean },
): string {
  const embedText = resolveDiscordEmbedText(
    (message.embeds?.[0] as { title?: string | null; description?: string | null } | undefined) ??
      null,
  );
  const componentText = extractDiscordComponentsV2Text(resolveDiscordMessageComponents(message));
  const contentText = normalizeOptionalString(message.content) ? message.content : "";
  const rawText =
    contentText ||
    embedText ||
    componentText ||
    normalizeOptionalString(options?.fallbackText) ||
    "";
  const baseText = normalizeResolvedDiscordMessageText(resolveDiscordMentions(rawText, message));
  if (!options?.includeForwarded) {
    return baseText;
  }
  const forwardedText = resolveDiscordForwardedMessagesText(message);
  if (!forwardedText) {
    return baseText;
  }
  if (!baseText) {
    return forwardedText;
  }
  return `${baseText}\n${forwardedText}`;
}

export function hasDiscordMessageUserMentionToken(message: Message, userId: string): boolean {
  const content = typeof message.content === "string" ? message.content : "";
  if (hasRawDiscordUserMention(content, userId)) {
    return true;
  }
  return hasDiscordComponentsV2UserMentionToken(resolveDiscordMessageComponents(message), userId);
}

/** Adds native media text only for history surfaces that cannot carry structured facts. */
export function resolveDiscordMessageHistoryText(
  message: Message,
  options?: { fallbackText?: string; includeForwarded?: boolean },
): string {
  const text = resolveDiscordMessageText(message, options);
  const mediaText = formatDiscordMediaText({
    attachments: message.attachments ?? undefined,
    stickers: resolveDiscordMessageStickers(message),
  });
  return [text, mediaText].filter(Boolean).join("\n");
}

function resolveDiscordMentions(text: string, message: Message): string {
  if (!text.includes("<")) {
    return text;
  }
  const mentions = message.mentionedUsers ?? [];
  if (!Array.isArray(mentions) || mentions.length === 0) {
    return text;
  }
  const replacements = new Map<string, string>();
  for (const user of mentions) {
    const label = user.globalName || user.username;
    replacements.set(user.id, `@${label}`);
  }
  return rewriteRawDiscordUserMentions(text, replacements);
}

function normalizeResolvedDiscordMessageText(text: string): string {
  const normalized = normalizeOptionalString(text) ?? "";
  if (!normalized || normalized === text) {
    return normalized;
  }
  const activeUserIds = collectActiveDiscordUserMentionIds(text);
  const trimmingActivatesMention = [...collectActiveDiscordUserMentionIds(normalized)].some(
    (userId) => !activeUserIds.has(userId),
  );
  return trimmingActivatesMention ? text.trimEnd() : normalized;
}

function resolveDiscordForwardedMessagesText(message: Message): string {
  const snapshots = resolveDiscordMessageSnapshots(message);
  if (snapshots.length > 0) {
    return resolveDiscordForwardedMessagesTextFromSnapshots(snapshots);
  }
  const referencedForward = resolveDiscordReferencedForwardMessage(message);
  if (!referencedForward) {
    return "";
  }
  const referencedText = resolveDiscordMessageHistoryText(referencedForward);
  if (!referencedText) {
    return "";
  }
  const authorLabel = formatDiscordSnapshotAuthor(referencedForward.author);
  const heading = authorLabel ? `[Forwarded message from ${authorLabel}]` : "[Forwarded message]";
  return `${heading}\n${referencedText}`;
}

function resolveDiscordMessageComponents(message: Message): unknown {
  const components = (message as { components?: unknown }).components;
  if (components !== undefined) {
    return components;
  }
  try {
    return (message as { rawData?: { components?: unknown } }).rawData?.components;
  } catch {
    return undefined;
  }
}

function extractDiscordComponentsV2Text(components: unknown): string {
  const parts: string[] = [];
  collectDiscordTextDisplayContent(components, parts);
  return parts.join("\n");
}

function collectDiscordTextDisplayContent(value: unknown, parts: string[]): void {
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectDiscordTextDisplayContent(entry, parts);
    }
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }
  const component = value as {
    type?: unknown;
    content?: unknown;
    components?: unknown;
    component?: unknown;
  };
  if (component.type === ComponentType.TextDisplay) {
    const content = normalizeOptionalString(component.content);
    if (content) {
      parts.push(content);
    }
  }
  collectDiscordTextDisplayContent(component.components, parts);
  collectDiscordTextDisplayContent(component.component, parts);
}

function hasDiscordComponentsV2UserMentionToken(value: unknown, userId: string): boolean {
  if (Array.isArray(value)) {
    return value.some((entry) => hasDiscordComponentsV2UserMentionToken(entry, userId));
  }
  if (!value || typeof value !== "object") {
    return false;
  }
  const component = value as {
    type?: unknown;
    content?: unknown;
    components?: unknown;
    component?: unknown;
  };
  if (
    component.type === ComponentType.TextDisplay &&
    typeof component.content === "string" &&
    hasRawDiscordUserMention(component.content, userId)
  ) {
    return true;
  }
  return (
    hasDiscordComponentsV2UserMentionToken(component.components, userId) ||
    hasDiscordComponentsV2UserMentionToken(component.component, userId)
  );
}

export function resolveDiscordForwardedMessagesTextFromSnapshots(snapshots: unknown): string {
  const forwardedBlocks = normalizeDiscordMessageSnapshots(snapshots)
    .map((snapshot) => buildDiscordForwardedMessageBlock(snapshot.message))
    .filter((entry): entry is string => Boolean(entry));
  if (forwardedBlocks.length === 0) {
    return "";
  }
  return forwardedBlocks.join("\n\n");
}

function buildDiscordForwardedMessageBlock(
  snapshotMessage: DiscordSnapshotMessage | null | undefined,
): string | null {
  if (!snapshotMessage) {
    return null;
  }
  const text = resolveDiscordSnapshotMessageText(snapshotMessage);
  if (!text) {
    return null;
  }
  const authorLabel = formatDiscordSnapshotAuthor(snapshotMessage.author);
  const heading = authorLabel ? `[Forwarded message from ${authorLabel}]` : "[Forwarded message]";
  return `${heading}\n${text}`;
}

function resolveDiscordSnapshotMessageText(snapshot: DiscordSnapshotMessage): string {
  const content = normalizeOptionalString(snapshot.content) ?? "";
  const attachmentText = formatDiscordMediaText({
    attachments: snapshot.attachments ?? undefined,
    stickers: resolveDiscordSnapshotStickers(snapshot),
  });
  const embedText = resolveDiscordEmbedText(snapshot.embeds?.[0]);
  const componentText = extractDiscordComponentsV2Text(snapshot.components);
  const text = content || embedText || componentText;
  return [text, attachmentText].filter(Boolean).join("\n");
}
