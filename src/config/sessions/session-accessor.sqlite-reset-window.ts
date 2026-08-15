// Reset boundaries project a logical message window without rewriting raw cursor positions.
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import { pruneMapToMaxSize } from "../../infra/map-size.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type { TranscriptEvent } from "./session-accessor.sqlite-contract.js";
import { resolveSqliteTranscriptReadScope } from "./session-accessor.sqlite-scope.js";
import type { SessionTranscriptProjectionState } from "./session-transcript-index.js";

type ResetWindowDatabase = Pick<
  OpenClawAgentKyselyDatabase,
  | "session_transcript_active_events"
  | "transcript_rewrite_watermarks"
  | "transcript_event_identities"
  | "transcript_events"
>;

type ResetWindowProjection = {
  database: OpenClawAgentDatabase;
  resolved: ReturnType<typeof resolveSqliteTranscriptReadScope>;
  state: SessionTranscriptProjectionState;
};

type VisibleMessagePositions = {
  kept: number[];
  postStart: number;
  total: number;
};

type ResetWindowMessageEvent = {
  event: TranscriptEvent;
  seq: number;
};

type ResetMessageWindow = {
  generation: string | undefined;
  indexedSeq: number;
  keptMessagePositions: number[];
  postBoundaryMessagePosition: number;
  // A compaction after the reset reopens the whole active path, so the kept-tail
  // window stops describing what is visible. The position the reset admitted still
  // does, and readers that must not cross the reset depend on it.
  shadowedByNewerBoundary: boolean;
};

type ResetMessageWindowCacheEntry = {
  generation: string | undefined;
  indexedSeq: number;
  window: ResetMessageWindow | null;
};

const resetMessageWindowCache = new Map<string, ResetMessageWindowCacheEntry>();
const MAX_RESET_MESSAGE_WINDOW_CACHE = 64;

function getResetWindowKysely(database: OpenClawAgentDatabase) {
  return getNodeSqliteKysely<ResetWindowDatabase>(database.db);
}

function parseMessageEventRow(row: {
  event_json: string;
  message_position: number | null;
}): ResetWindowMessageEvent {
  if (row.message_position === null) {
    throw new Error("Active transcript message row is missing its message position");
  }
  return {
    event: JSON.parse(row.event_json) as TranscriptEvent,
    seq: row.message_position + 1,
  };
}

function readMessageRange(
  projection: ResetWindowProjection,
  start: number,
  endExclusive: number,
): ResetWindowMessageEvent[] {
  if (endExclusive <= start) {
    return [];
  }
  const db = getResetWindowKysely(projection.database);
  return executeSqliteQuerySync(
    projection.database.db,
    db
      .selectFrom("session_transcript_active_events as active")
      .innerJoin("transcript_events as event", (join) =>
        join
          .onRef("event.session_id", "=", "active.session_id")
          .onRef("event.seq", "=", "active.event_seq"),
      )
      .select(["active.message_position", "event.event_json"])
      .where("active.session_id", "=", projection.resolved.sessionId)
      .where("active.message_position", "is not", null)
      .where("active.message_position", ">=", start)
      .where("active.message_position", "<", endExclusive)
      .orderBy("active.message_position", "asc"),
  ).rows.map(parseMessageEventRow);
}

function resetMessageWindowCacheKey(projection: ResetWindowProjection): string {
  return `${projection.database.path}\0${projection.resolved.sessionId}`;
}

export function readTranscriptProjectionGeneration(
  projection: ResetWindowProjection,
): string | undefined {
  return executeSqliteQueryTakeFirstSync(
    projection.database.db,
    getResetWindowKysely(projection.database)
      .selectFrom("transcript_rewrite_watermarks")
      .select("generation")
      .where("session_id", "=", projection.resolved.sessionId),
  )?.generation;
}

function cacheResetMessageWindow(key: string, entry: ResetMessageWindowCacheEntry): void {
  resetMessageWindowCache.delete(key);
  resetMessageWindowCache.set(key, entry);
  pruneMapToMaxSize(resetMessageWindowCache, MAX_RESET_MESSAGE_WINDOW_CACHE);
}

function readLatestActiveBoundaryMetadataByType(
  projection: ResetWindowProjection,
  eventType: "compaction" | "reset",
) {
  const db = getResetWindowKysely(projection.database);
  return executeSqliteQueryTakeFirstSync(
    projection.database.db,
    db
      .selectFrom("session_transcript_active_events as active")
      .innerJoin("transcript_event_identities as identity", (join) =>
        join
          .onRef("identity.session_id", "=", "active.session_id")
          .onRef("identity.seq", "=", "active.event_seq"),
      )
      .select(["active.active_position", "identity.event_type", "identity.seq"])
      .where("active.session_id", "=", projection.resolved.sessionId)
      .where("identity.event_type", "=", eventType)
      .orderBy("identity.seq", "desc")
      .limit(1),
  );
}

function readResetBoundary(projection: ResetWindowProjection, seq: number) {
  const row = executeSqliteQueryTakeFirstSync(
    projection.database.db,
    getResetWindowKysely(projection.database)
      .selectFrom("transcript_events")
      .select("event_json")
      .where("session_id", "=", projection.resolved.sessionId)
      .where("seq", "=", seq)
      .limit(1),
  );
  if (!row) {
    throw new Error("Active transcript reset boundary is missing");
  }
  const parsed = JSON.parse(row.event_json) as { firstKeptEntryId?: unknown; type?: unknown };
  if (parsed.type !== "reset") {
    throw new Error("Active transcript reset boundary has invalid payload");
  }
  return parsed;
}

function findLatestResetMessageWindow(
  projection: ResetWindowProjection,
  generation: string | undefined,
): ResetMessageWindow | null {
  const db = getResetWindowKysely(projection.database);
  const latestBoundary = readLatestActiveBoundaryMetadataByType(projection, "reset");
  if (!latestBoundary) {
    return null;
  }
  const latestCompaction = readLatestActiveBoundaryMetadataByType(projection, "compaction");
  const shadowedByNewerBoundary = latestCompaction
    ? !(latestBoundary.seq > latestCompaction.seq)
    : false;
  const postBoundaryMessagePosition =
    executeSqliteQueryTakeFirstSync(
      projection.database.db,
      db
        .selectFrom("session_transcript_active_events")
        .select("message_position")
        .where("session_id", "=", projection.resolved.sessionId)
        .where("active_position", ">", latestBoundary.active_position)
        .where("message_position", "is not", null)
        .orderBy("active_position", "asc")
        .limit(1),
    )?.message_position ?? projection.state.activeMessageCount;
  // Shadowed, the kept tail is not what is visible, so don't spend a payload read on it.
  const reset = shadowedByNewerBoundary
    ? undefined
    : readResetBoundary(projection, latestBoundary.seq);
  let keptMessagePositions: number[] = [];
  if (typeof reset?.firstKeptEntryId === "string") {
    const firstKept = executeSqliteQueryTakeFirstSync(
      projection.database.db,
      db
        .selectFrom("transcript_event_identities as identity")
        .innerJoin("session_transcript_active_events as active", (join) =>
          join
            .onRef("active.session_id", "=", "identity.session_id")
            .onRef("active.event_seq", "=", "identity.seq"),
        )
        .select("active.active_position")
        .where("identity.session_id", "=", projection.resolved.sessionId)
        .where("identity.event_id", "=", reset.firstKeptEntryId),
    );
    if (firstKept && firstKept.active_position < latestBoundary.active_position) {
      keptMessagePositions = executeSqliteQuerySync(
        projection.database.db,
        db
          .selectFrom("session_transcript_active_events as active")
          .innerJoin("transcript_events as event", (join) =>
            join
              .onRef("event.session_id", "=", "active.session_id")
              .onRef("event.seq", "=", "active.event_seq"),
          )
          .select(["active.message_position", "event.event_json"])
          .where("active.session_id", "=", projection.resolved.sessionId)
          .where("active.active_position", ">=", firstKept.active_position)
          .where("active.active_position", "<", latestBoundary.active_position)
          .where("active.message_position", "is not", null)
          .orderBy("active.active_position", "asc"),
      ).rows.flatMap((row) => {
        if (row.message_position === null) {
          return [];
        }
        try {
          const role = (JSON.parse(row.event_json) as { message?: { role?: unknown } }).message
            ?.role;
          return role === "user" || role === "assistant" ? [row.message_position] : [];
        } catch {
          return [];
        }
      });
    }
  }
  return {
    generation,
    indexedSeq: projection.state.indexedSeq,
    keptMessagePositions,
    postBoundaryMessagePosition,
    shadowedByNewerBoundary,
  };
}

function resolveResetMessageWindow(projection: ResetWindowProjection): ResetMessageWindow | null {
  const key = resetMessageWindowCacheKey(projection);
  const cached = resetMessageWindowCache.get(key);
  const generation = readTranscriptProjectionGeneration(projection);
  if (cached) {
    if (cached.generation === generation && cached.indexedSeq === projection.state.indexedSeq) {
      return cached.window;
    }
  }
  const window = findLatestResetMessageWindow(projection, generation);
  cacheResetMessageWindow(key, {
    generation,
    indexedSeq: projection.state.indexedSeq,
    window,
  });
  return window;
}

/**
 * Logical index of the first message the latest reset admitted. Readers that must not
 * cross a reset use this instead of the kept-tail length, which a newer compaction
 * empties even though the reset still happened.
 */
export function resolvePostResetVisibleStart(projection: ResetWindowProjection): number {
  const window = resolveResetMessageWindow(projection);
  if (!window) {
    return 0;
  }
  // Once shadowed the visible space is the raw active path, so the admitted message
  // position is already the logical index.
  return window.shadowedByNewerBoundary
    ? window.postBoundaryMessagePosition
    : window.keptMessagePositions.length;
}

export function resolveVisibleMessagePositions(
  projection: ResetWindowProjection,
): VisibleMessagePositions {
  const window = resolveResetMessageWindow(projection);
  if (!window || window.shadowedByNewerBoundary) {
    return { kept: [], postStart: 0, total: projection.state.activeMessageCount };
  }
  return {
    kept: window.keptMessagePositions,
    postStart: window.postBoundaryMessagePosition,
    total:
      window.keptMessagePositions.length +
      Math.max(0, projection.state.activeMessageCount - window.postBoundaryMessagePosition),
  };
}

export function readVisibleMessageRange(
  projection: ResetWindowProjection,
  start: number,
  endExclusive: number,
): ResetWindowMessageEvent[] {
  if (endExclusive <= start) {
    return [];
  }
  const visible = resolveVisibleMessagePositions(projection);
  const boundedStart = Math.min(Math.max(0, start), visible.total);
  const boundedEnd = Math.min(Math.max(boundedStart, endExclusive), visible.total);
  if (boundedEnd <= boundedStart) {
    return [];
  }
  const keptEnd = Math.min(boundedEnd, visible.kept.length);
  const keptEvents = visible.kept
    .slice(boundedStart, keptEnd)
    .flatMap((position) => readMessageRange(projection, position, position + 1));
  const postVisibleStart = Math.max(boundedStart, visible.kept.length);
  const postVisibleEnd = Math.max(postVisibleStart, boundedEnd);
  const postEvents = readMessageRange(
    projection,
    visible.postStart + postVisibleStart - visible.kept.length,
    visible.postStart + postVisibleEnd - visible.kept.length,
  );
  return [...keptEvents, ...postEvents];
}

/** Maps a logical visible-message range to its materialized message positions. */
export function resolveVisibleMessagePositionRange(
  projection: ResetWindowProjection,
  start: number,
  endExclusive: number,
): number[] {
  if (endExclusive <= start) {
    return [];
  }
  const visible = resolveVisibleMessagePositions(projection);
  const boundedStart = Math.min(Math.max(0, start), visible.total);
  const boundedEnd = Math.min(Math.max(boundedStart, endExclusive), visible.total);
  const keptEnd = Math.min(boundedEnd, visible.kept.length);
  const positions = visible.kept.slice(boundedStart, keptEnd);
  const postVisibleStart = Math.max(boundedStart, visible.kept.length);
  const postVisibleEnd = Math.max(postVisibleStart, boundedEnd);
  for (let logical = postVisibleStart; logical < postVisibleEnd; logical += 1) {
    positions.push(visible.postStart + logical - visible.kept.length);
  }
  return positions;
}
