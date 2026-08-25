// Codex plugin module implements conversation turn input behavior.
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PluginHookInboundClaimEvent } from "openclaw/plugin-sdk/plugin-entry";
import type { CodexUserInput } from "./app-server/protocol.js";

type InboundMedia = {
  path?: string;
  url?: string;
  mimeType?: string;
  kind?: string;
};

const IMAGE_EXTENSIONS = new Set([".avif", ".gif", ".jpeg", ".jpg", ".png", ".webp"]);

export function buildCodexConversationTurnInput(params: {
  prompt: string;
  event: PluginHookInboundClaimEvent;
}): CodexUserInput[] {
  return [
    { type: "text", text: params.prompt, text_elements: [] },
    ...extractInboundMedia(params.event)
      .map(toCodexImageInput)
      .filter((item): item is CodexUserInput => item !== undefined),
  ];
}

function extractInboundMedia(event: PluginHookInboundClaimEvent): InboundMedia[] {
  // event.media is the canonical ordered attachment representation. The legacy
  // metadata aliases are independently compacted projections, so their indexes
  // cannot safely be zipped back together for mixed remote/local attachments.
  return (event.media ?? []).map((media) => ({
    path: media.path,
    url: media.url,
    mimeType: media.contentType,
    kind: media.kind,
  }));
}

function toCodexImageInput(media: InboundMedia): CodexUserInput | undefined {
  if (!isImageMedia(media)) {
    return undefined;
  }
  const localPath = media.path ?? readLocalMediaPath(media.url);
  if (localPath) {
    const normalized = normalizeFileUrl(localPath);
    return normalized ? { type: "localImage", path: normalized } : undefined;
  }
  return media.url ? { type: "image", url: media.url } : undefined;
}

function isImageMedia(media: InboundMedia): boolean {
  if (media.kind === "image" || media.mimeType?.toLowerCase().startsWith("image/")) {
    return true;
  }
  const candidate = media.path ?? media.url;
  if (!candidate) {
    return false;
  }
  return IMAGE_EXTENSIONS.has(path.extname(candidate.split(/[?#]/, 1)[0] ?? "").toLowerCase());
}

function normalizeFileUrl(value: string): string | undefined {
  if (!value.startsWith("file://")) {
    return value;
  }
  try {
    return fileURLToPath(value);
  } catch {
    return undefined;
  }
}

function readLocalMediaPath(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  if (value.startsWith("file://")) {
    return value;
  }
  if (value.startsWith("//")) {
    return undefined;
  }
  if (path.isAbsolute(value) || path.win32.isAbsolute(value)) {
    return value;
  }
  return /^[a-z][a-z0-9+.-]*:/i.test(value) ? undefined : value;
}
