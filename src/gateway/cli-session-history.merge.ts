// Imported CLI history merge helpers.
// Deduplicates external history messages against local OpenClaw transcripts.
import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import {
  normalizeOptionalString,
  readStringValue,
} from "@openclaw/normalization-core/string-coerce";
import { stripInboundMetadata } from "../auto-reply/reply/strip-inbound-meta.js";
import { stripInlineDirectiveTagsForDisplay } from "../utils/directive-tags.js";

const DEDUPE_TIMESTAMP_WINDOW_MS = 5 * 60 * 1000;

type ComparableHistoryMessage = {
  message: unknown;
  order: number;
  externalIdentityKey?: string;
  role?: string;
  text?: string;
  timestamp?: number;
  // CLI turn-aggregate facts, derived from the same single read of each raw
  // field, so turn-level suppression adds no second pass over the messages.
  isCliAggregate?: boolean;
  hasNonTextContent?: boolean;
  isToolResultOnly?: boolean;
  provider?: string;
  importedFrom?: string;
};

type TimestampSummary = {
  hasMissingTimestamp: boolean;
  buckets: Map<number, { min: number; max: number }>;
};

type RoleTextIndex = Map<string, Map<string, TimestampSummary>>;

function buildComparableText(
  rawText: unknown,
  rawContent: unknown,
  role: string | undefined,
): string | undefined {
  const parts: string[] = [];
  const text = readStringValue(rawText);
  if (text !== undefined) {
    parts.push(text);
  }
  const content = readStringValue(rawContent);
  if (content !== undefined) {
    parts.push(content);
  } else if (Array.isArray(rawContent)) {
    for (const block of rawContent) {
      if (block && typeof block === "object" && "text" in block) {
        const blockText = readStringValue(block.text);
        if (blockText !== undefined) {
          parts.push(blockText);
        }
      }
    }
  }
  if (parts.length === 0) {
    return undefined;
  }
  const joined = parts.join("\n").trim();
  if (!joined) {
    return undefined;
  }
  const visible = stripInlineDirectiveTagsForDisplay(
    role === "user" ? stripInboundMetadata(joined) : joined,
  ).text;
  const normalized = visible.replace(/\s+/g, " ").trim();
  return normalized || undefined;
}

function prepareComparableMessage(message: unknown, order: number): ComparableHistoryMessage {
  if (!message || typeof message !== "object") {
    return { message, order };
  }
  // Each raw field is read exactly once here; every derived fact below reuses
  // these locals so the merge keeps its one-read-per-field invariant.
  const record = message as {
    role?: unknown;
    text?: unknown;
    content?: unknown;
    timestamp?: unknown;
    api?: unknown;
    idempotencyKey?: unknown;
    provider?: unknown;
  };
  const role = readStringValue(record.role);
  const rawContent = record.content;
  const meta = readOpenClawMeta(message);
  return {
    message,
    order,
    externalIdentityKey: resolveImportedExternalIdentityKey(meta),
    role,
    text: buildComparableText(record.text, rawContent, role),
    timestamp: asFiniteNumber(record.timestamp),
    isCliAggregate: isPersistedCliAggregate(record.api, record.idempotencyKey),
    hasNonTextContent: hasNonTextContentBlock(rawContent),
    isToolResultOnly: isToolResultOnlyContent(role, rawContent),
    provider: normalizeOptionalString(record.provider),
    importedFrom: normalizeOptionalString(meta?.importedFrom),
  };
}

// External identity survives text edits, so it is the strongest match signal
// for imported messages from Claude CLI or similar external histories.
function resolveImportedExternalIdentityKey(
  meta: Record<string, unknown> | undefined,
): string | undefined {
  const externalId = normalizeOptionalString(meta?.externalId);
  return externalId
    ? JSON.stringify([
        externalId,
        normalizeOptionalString(meta?.importedFrom),
        normalizeOptionalString(meta?.cliSessionId),
      ])
    : undefined;
}

function addRoleTextCandidate(index: RoleTextIndex, entry: ComparableHistoryMessage): void {
  if (!entry.role || !entry.text) {
    return;
  }
  let byText = index.get(entry.role);
  if (!byText) {
    byText = new Map();
    index.set(entry.role, byText);
  }
  let summary = byText.get(entry.text);
  if (!summary) {
    summary = { hasMissingTimestamp: false, buckets: new Map() };
    byText.set(entry.text, summary);
  }
  if (entry.timestamp === undefined) {
    summary.hasMissingTimestamp = true;
    return;
  }
  const bucketKey = Math.floor(entry.timestamp / DEDUPE_TIMESTAMP_WINDOW_MS);
  const bucket = summary.buckets.get(bucketKey);
  if (bucket) {
    bucket.min = Math.min(bucket.min, entry.timestamp);
    bucket.max = Math.max(bucket.max, entry.timestamp);
  } else {
    summary.buckets.set(bucketKey, { min: entry.timestamp, max: entry.timestamp });
  }
}

function hasRoleTextCandidate(index: RoleTextIndex, entry: ComparableHistoryMessage): boolean {
  if (!entry.role || !entry.text) {
    return false;
  }
  const summary = index.get(entry.role)?.get(entry.text);
  if (!summary) {
    return false;
  }
  if (entry.timestamp === undefined || summary.hasMissingTimestamp) {
    return true;
  }
  const bucketKey = Math.floor(entry.timestamp / DEDUPE_TIMESTAMP_WINDOW_MS);
  if (summary.buckets.has(bucketKey)) {
    return true;
  }
  const previous = summary.buckets.get(bucketKey - 1);
  if (previous && previous.max >= entry.timestamp - DEDUPE_TIMESTAMP_WINDOW_MS) {
    return true;
  }
  const next = summary.buckets.get(bucketKey + 1);
  return next !== undefined && next.min <= entry.timestamp + DEDUPE_TIMESTAMP_WINDOW_MS;
}

function readOpenClawMeta(message: unknown): Record<string, unknown> | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const rawMeta = (message as { __openclaw?: unknown })["__openclaw"];
  return rawMeta && typeof rawMeta === "object" ? (rawMeta as Record<string, unknown>) : undefined;
}

// CLI backends persist each assistant turn as one synthetic aggregate
// (`api: "cli"`) whose text is the turn's text blocks joined with blank lines.
const CLI_AGGREGATE_API = "cli";
// `api: "cli"` alone is not unique to the synthetic aggregate — ordinary CLI
// assistant replies share that shape. The aggregate producer stamps
// `idempotencyKey: "cli-assistant:<runId>"`, which the transcript append copies
// onto the stored message, so that key is the authoritative discriminator.
const CLI_AGGREGATE_IDEMPOTENCY_PREFIX = "cli-assistant:";

function isPersistedCliAggregate(rawApi: unknown, rawIdempotencyKey: unknown): boolean {
  if (readStringValue(rawApi) !== CLI_AGGREGATE_API) {
    return false;
  }
  const idempotencyKey = normalizeOptionalString(rawIdempotencyKey);
  return (
    idempotencyKey !== undefined && idempotencyKey.startsWith(CLI_AGGREGATE_IDEMPOTENCY_PREFIX)
  );
}

function normalizeContentBlockType(block: unknown): string | undefined {
  if (!block || typeof block !== "object") {
    return undefined;
  }
  const normalized = readStringValue((block as { type?: unknown }).type)?.toLowerCase();
  return normalized ? normalized.replace(/_/g, "") : undefined;
}

function hasNonTextContentBlock(rawContent: unknown): boolean {
  if (!Array.isArray(rawContent)) {
    return false;
  }
  return rawContent.some((block) => {
    const type = normalizeContentBlockType(block);
    return type !== undefined && type !== "text";
  });
}

function isToolResultOnlyContent(role: string | undefined, rawContent: unknown): boolean {
  if (role !== "user" || !Array.isArray(rawContent) || rawContent.length === 0) {
    return false;
  }
  return rawContent.every((block) => normalizeContentBlockType(block) === "toolresult");
}

type ImportedAssistantTurn = {
  claimed: boolean;
  importedFrom: string;
  timestamps: number[];
};

// Keyed by the text a covering aggregate carries, so each aggregate resolves its
// candidates with one lookup instead of a scan that grows with the imported
// history — the same bound the per-message dedupe indexes already keep.
type ImportedTurnIndex = Map<string, ImportedAssistantTurn[]>;

type PartialAssistantTurn = {
  fragments: string[];
  hasNonTextContent: boolean;
  importedFrom?: string;
  timestamps: number[];
};

/**
 * Indexes the imported assistant turns by the aggregate text that would cover
 * them. Reads no raw fields: every fact comes from the prepared entries.
 */
function indexImportedAssistantTurns(
  importedEntries: ComparableHistoryMessage[],
): ImportedTurnIndex {
  const index: ImportedTurnIndex = new Map();
  let current: PartialAssistantTurn | undefined;
  const closeTurn = (): void => {
    const turn = current;
    current = undefined;
    if (!turn || turn.fragments.length === 0) {
      return;
    }
    // Turns that can never cover an aggregate stay out of the index instead of
    // being re-rejected once per aggregate: no timestamp to place them in the
    // dedupe window, no provider to match, or — for a lone text-only fragment —
    // an exact-equality case the per-message dedupe already resolves by
    // keeping the local copy.
    if (turn.timestamps.length === 0 || turn.importedFrom === undefined) {
      return;
    }
    if (turn.fragments.length < 2 && !turn.hasNonTextContent) {
      return;
    }
    const aggregateText = turn.fragments.join(" ");
    const covering: ImportedAssistantTurn = {
      claimed: false,
      importedFrom: turn.importedFrom,
      timestamps: turn.timestamps,
    };
    const bucket = index.get(aggregateText);
    if (bucket) {
      bucket.push(covering);
    } else {
      index.set(aggregateText, [covering]);
    }
  };
  for (const entry of importedEntries) {
    if (entry.role === "assistant") {
      current ??= { fragments: [], hasNonTextContent: false, timestamps: [] };
      if (entry.text !== undefined) {
        current.fragments.push(entry.text);
      }
      current.hasNonTextContent ||= entry.hasNonTextContent === true;
      current.importedFrom ??= entry.importedFrom;
      if (entry.timestamp !== undefined) {
        current.timestamps.push(entry.timestamp);
      }
      continue;
    }
    // A tool-result the importer could not pair stays a user-role record, but
    // it continues the surrounding assistant turn rather than starting a new one.
    if (current && entry.isToolResultOnly) {
      current.hasNonTextContent = true;
      continue;
    }
    closeTurn();
  }
  closeTurn();
  return index;
}

/** Distance from the aggregate to its nearest block, or undefined when out of window. */
function turnDistanceToAggregate(
  turn: ImportedAssistantTurn,
  timestamp: number,
): number | undefined {
  let nearest: number | undefined;
  for (const value of turn.timestamps) {
    const distance = Math.abs(value - timestamp);
    if (nearest === undefined || distance < nearest) {
      nearest = distance;
    }
  }
  return nearest !== undefined && nearest <= DEDUPE_TIMESTAMP_WINDOW_MS ? nearest : undefined;
}

/**
 * Claims the nearest-in-time imported turn that still covers this aggregate.
 * Turns are consumed one-to-one: two genuinely repeated replies with identical
 * text are only suppressed when the import actually holds both of them.
 */
function claimCoveringTurn(index: ImportedTurnIndex, entry: ComparableHistoryMessage): boolean {
  if (entry.role !== "assistant" || entry.isCliAggregate !== true) {
    return false;
  }
  // A local row that already carries an external identity came from a previous
  // import, so it is not a locally persisted aggregate.
  if (entry.externalIdentityKey !== undefined) {
    return false;
  }
  const { provider, text, timestamp } = entry;
  if (provider === undefined || text === undefined || timestamp === undefined) {
    return false;
  }
  const candidates = index.get(text);
  if (candidates === undefined) {
    return false;
  }
  let claim: ImportedAssistantTurn | undefined;
  let claimDistance: number | undefined;
  for (const turn of candidates) {
    if (turn.claimed || turn.importedFrom !== provider) {
      continue;
    }
    const distance = turnDistanceToAggregate(turn, timestamp);
    if (distance === undefined) {
      continue;
    }
    if (claimDistance === undefined || distance < claimDistance) {
      claim = turn;
      claimDistance = distance;
    }
  }
  if (claim === undefined) {
    return false;
  }
  claim.claimed = true;
  return true;
}

function compareHistoryMessages(a: ComparableHistoryMessage, b: ComparableHistoryMessage): number {
  if (a.timestamp !== undefined && b.timestamp !== undefined && a.timestamp !== b.timestamp) {
    return a.timestamp - b.timestamp;
  }
  return a.order - b.order;
}

/**
 * Merges imported CLI transcript messages into local history without duplicating overlaps.
 * Returns `params.localMessages` (same reference) when the merge changes nothing, so
 * callers can detect imports and replacements by identity rather than by length.
 */
export function mergeImportedChatHistoryMessages(params: {
  localMessages: unknown[];
  importedMessages: unknown[];
}): unknown[] {
  if (params.importedMessages.length === 0) {
    return params.localMessages;
  }
  // Both sides are prepared exactly once; every later decision — per-message
  // dedupe and turn-aggregate suppression alike — reads only prepared entries.
  const localEntries = params.localMessages.map(prepareComparableMessage);
  const importedEntries = params.importedMessages.map(prepareComparableMessage);

  // The aggregate and the imported native blocks are two shapes of the same
  // turn, so per-message equality can never pair them and the turn renders
  // twice (openclaw/openclaw#123792). Dropping the covered aggregate keeps the
  // native blocks, which are the copy that carries the tool calls.
  const coveringTurns = indexImportedAssistantTurns(importedEntries);
  const merged =
    coveringTurns.size === 0
      ? localEntries
      : localEntries.filter((entry) => !claimCoveringTurn(coveringTurns, entry));
  const suppressedAggregate = merged.length !== localEntries.length;

  const exactExternalIdentityIndex = new Set<string>();
  const allMessageRoleTextIndex: RoleTextIndex = new Map();
  const identitylessRoleTextIndex: RoleTextIndex = new Map();
  const indexEntry = (entry: ComparableHistoryMessage) => {
    if (entry.externalIdentityKey) {
      exactExternalIdentityIndex.add(entry.externalIdentityKey);
    } else {
      addRoleTextCandidate(identitylessRoleTextIndex, entry);
    }
    addRoleTextCandidate(allMessageRoleTextIndex, entry);
  };
  for (const entry of merged) {
    indexEntry(entry);
  }
  // Local orders stay as prepared, so appending must start past the whole local
  // range: after a suppression `merged.length` is short of it and would collide.
  let nextOrder = localEntries.length;
  let addedImportedMessage = false;
  for (const imported of importedEntries) {
    const duplicate = imported.externalIdentityKey
      ? exactExternalIdentityIndex.has(imported.externalIdentityKey) ||
        hasRoleTextCandidate(identitylessRoleTextIndex, imported)
      : hasRoleTextCandidate(allMessageRoleTextIndex, imported);
    if (duplicate) {
      continue;
    }
    imported.order = nextOrder;
    merged.push(imported);
    indexEntry(imported);
    nextOrder += 1;
    addedImportedMessage = true;
  }
  if (!addedImportedMessage && !suppressedAggregate) {
    return params.localMessages;
  }
  merged.sort(compareHistoryMessages);
  return merged.map((entry) => entry.message);
}
