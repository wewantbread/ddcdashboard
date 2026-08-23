// Persists task registry records and events through the OpenClaw SQLite state database.
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import type { Insertable, Selectable } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { assertSqliteTableIntegrity } from "../infra/sqlite-integrity.js";
import { normalizeSqliteNumber } from "../infra/sqlite-number.js";
import { runSqliteDeferredTransactionSync } from "../infra/sqlite-transaction.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import { tableExists, tableHasColumns } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabase,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { parseDeliveryContextJson, parseSqliteJsonValue } from "./task-registry.sqlite.shared.js";
import type { TaskRegistryStoreSnapshot } from "./task-registry.store.types.js";
import {
  parseOptionalTaskTerminalOutcome,
  parseTaskDeliveryStatus,
  parseTaskNotifyPolicy,
  parseTaskRuntime,
  parseTaskScopeKind,
  parseTaskStatus,
  type TaskDeliveryState,
  type JsonValue,
  type TaskRecord,
  type TaskRuntime,
} from "./task-registry.types.js";

type TaskRunsTable = OpenClawStateKyselyDatabase["task_runs"];
type TaskDeliveryStateTable = OpenClawStateKyselyDatabase["task_delivery_state"];
type TaskRegistryStoreDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "task_delivery_state" | "task_runs"
>;

type TaskRegistryRow = Selectable<TaskRunsTable> & {
  runtime: string;
  scope_kind: string;
  status: string;
  delivery_status: string;
  notify_policy: string;
  terminal_outcome: string | null;
};

type TaskDeliveryStateRow = Selectable<TaskDeliveryStateTable>;

type TaskRegistryDatabase = {
  db: DatabaseSync;
  path: string;
};

// SQLite-backed task store mirrors task records and delivery state into openclaw-state.db.
const TASK_RUN_SELECT_COLUMNS = [
  "task_id",
  "runtime",
  "task_kind",
  "source_id",
  "requester_session_key",
  "owner_key",
  "scope_kind",
  "child_session_key",
  "parent_flow_id",
  "parent_task_id",
  "agent_id",
  "requester_agent_id",
  "run_id",
  "label",
  "task",
  "status",
  "delivery_status",
  "notify_policy",
  "created_at",
  "started_at",
  "ended_at",
  "last_event_at",
  "cleanup_after",
  "tool_use_count",
  "last_tool_name",
  "error",
  "progress_summary",
  "terminal_summary",
  "terminal_outcome",
  "detail_json",
] as const;

const TASK_DELIVERY_STATE_SELECT_COLUMNS = [
  "task_id",
  "requester_origin_json",
  "last_notified_event_at",
] as const;

type TaskRegistryReadOnlyLoadResult = {
  state: "ready" | "migration-required";
  snapshot: TaskRegistryStoreSnapshot;
};

let cachedDatabase: TaskRegistryDatabase | null = null;

function serializeJson(value: unknown): string | null {
  return value === undefined ? null : (JSON.stringify(value) ?? null);
}

function rowToTaskRecord(row: TaskRegistryRow): TaskRecord {
  const startedAt = normalizeSqliteNumber(row.started_at);
  const endedAt = normalizeSqliteNumber(row.ended_at);
  const lastEventAt = normalizeSqliteNumber(row.last_event_at);
  const cleanupAfter = normalizeSqliteNumber(row.cleanup_after);
  const toolUseCount = normalizeSqliteNumber(row.tool_use_count);
  const scopeKind = parseTaskScopeKind(row.scope_kind);
  const terminalOutcome = parseOptionalTaskTerminalOutcome(row.terminal_outcome);
  const detail = parseSqliteJsonValue<JsonValue>(row.detail_json);
  // System tasks intentionally have no requester session; ownerKey is the lookup anchor.
  const requesterSessionKey =
    scopeKind === "system" ? "" : row.requester_session_key?.trim() || row.owner_key;
  return {
    taskId: row.task_id,
    runtime: parseTaskRuntime(row.runtime),
    ...(row.task_kind ? { taskKind: row.task_kind } : {}),
    ...(row.source_id ? { sourceId: row.source_id } : {}),
    requesterSessionKey,
    ownerKey: row.owner_key,
    scopeKind,
    ...(row.child_session_key ? { childSessionKey: row.child_session_key } : {}),
    ...(row.parent_flow_id ? { parentFlowId: row.parent_flow_id } : {}),
    ...(row.parent_task_id ? { parentTaskId: row.parent_task_id } : {}),
    ...(row.agent_id ? { agentId: row.agent_id } : {}),
    ...(row.requester_agent_id ? { requesterAgentId: row.requester_agent_id } : {}),
    ...(row.run_id ? { runId: row.run_id } : {}),
    ...(row.label ? { label: row.label } : {}),
    task: row.task,
    status: parseTaskStatus(row.status),
    deliveryStatus: parseTaskDeliveryStatus(row.delivery_status),
    notifyPolicy: parseTaskNotifyPolicy(row.notify_policy),
    createdAt: normalizeSqliteNumber(row.created_at) ?? 0,
    ...(startedAt != null ? { startedAt } : {}),
    ...(endedAt != null ? { endedAt } : {}),
    ...(lastEventAt != null ? { lastEventAt } : {}),
    ...(cleanupAfter != null ? { cleanupAfter } : {}),
    ...(toolUseCount != null ? { toolUseCount } : {}),
    ...(row.last_tool_name ? { lastToolName: row.last_tool_name } : {}),
    ...(row.error ? { error: row.error } : {}),
    ...(row.progress_summary ? { progressSummary: row.progress_summary } : {}),
    ...(row.terminal_summary !== null ? { terminalSummary: row.terminal_summary } : {}),
    ...(terminalOutcome ? { terminalOutcome } : {}),
    ...(detail !== undefined ? { detail } : {}),
  };
}

function rowToTaskDeliveryState(row: TaskDeliveryStateRow): TaskDeliveryState {
  const requesterOrigin = parseDeliveryContextJson(row.requester_origin_json);
  const lastNotifiedEventAt = normalizeSqliteNumber(row.last_notified_event_at);
  return {
    taskId: row.task_id,
    ...(requesterOrigin ? { requesterOrigin } : {}),
    ...(lastNotifiedEventAt != null ? { lastNotifiedEventAt } : {}),
  };
}

export type BoundTaskRecord = Insertable<TaskRunsTable>;
export type BoundTaskDeliveryState = Insertable<TaskDeliveryStateTable>;

/** Canonically serializes a task before an outer transaction acquires the write lock. */
export function bindTaskRecord(record: TaskRecord): BoundTaskRecord {
  return {
    task_id: record.taskId,
    runtime: record.runtime,
    task_kind: record.taskKind ?? null,
    source_id: record.sourceId ?? null,
    requester_session_key: record.scopeKind === "system" ? "" : record.requesterSessionKey,
    owner_key: record.ownerKey,
    scope_kind: record.scopeKind,
    child_session_key: record.childSessionKey ?? null,
    parent_flow_id: record.parentFlowId ?? null,
    parent_task_id: record.parentTaskId ?? null,
    agent_id: record.agentId ?? null,
    requester_agent_id: record.requesterAgentId ?? null,
    run_id: record.runId ?? null,
    label: record.label ?? null,
    task: record.task,
    status: record.status,
    delivery_status: record.deliveryStatus,
    notify_policy: record.notifyPolicy,
    created_at: record.createdAt,
    started_at: record.startedAt ?? null,
    ended_at: record.endedAt ?? null,
    last_event_at: record.lastEventAt ?? null,
    cleanup_after: record.cleanupAfter ?? null,
    tool_use_count: record.toolUseCount ?? null,
    last_tool_name: record.lastToolName ?? null,
    error: record.error ?? null,
    progress_summary: record.progressSummary ?? null,
    terminal_summary: record.terminalSummary ?? null,
    terminal_outcome: record.terminalOutcome ?? null,
    detail_json: serializeJson(record.detail),
  };
}

export function bindTaskDeliveryState(state: TaskDeliveryState): BoundTaskDeliveryState {
  return {
    task_id: state.taskId,
    requester_origin_json: serializeJson(state.requesterOrigin),
    last_notified_event_at: state.lastNotifiedEventAt ?? null,
  };
}

function getTaskRegistryKysely(db: DatabaseSync) {
  return getNodeSqliteKysely<TaskRegistryStoreDatabase>(db);
}

function pruneRowsNotInSnapshot(params: {
  db: DatabaseSync;
  tableName: "task_delivery_state" | "task_runs";
  columnName: "task_id";
  tempTableName: string;
  ids: readonly string[];
}) {
  params.db.exec(`CREATE TEMP TABLE IF NOT EXISTS ${params.tempTableName} (id TEXT PRIMARY KEY)`);
  params.db.exec(`DELETE FROM ${params.tempTableName}`);
  const insert = params.db.prepare(`INSERT OR IGNORE INTO ${params.tempTableName} (id) VALUES (?)`);
  for (const id of params.ids) {
    insert.run(id);
  }
  params.db.exec(`
    DELETE FROM ${params.tableName}
    WHERE NOT EXISTS (
      SELECT 1 FROM ${params.tempTableName}
      WHERE ${params.tempTableName}.id = ${params.tableName}.${params.columnName}
    )
  `);
  params.db.exec(`DELETE FROM ${params.tempTableName}`);
}

function selectTaskRows(db: DatabaseSync): TaskRegistryRow[] {
  const query = getTaskRegistryKysely(db)
    .selectFrom("task_runs")
    .select(TASK_RUN_SELECT_COLUMNS)
    .orderBy("created_at", "asc")
    .orderBy("task_id", "asc");
  return executeSqliteQuerySync(db, query).rows;
}

function selectTaskRowsByOwnerKey(db: DatabaseSync, ownerKey: string): TaskRegistryRow[] {
  const selectColumns = TASK_RUN_SELECT_COLUMNS.join(", ");
  // This lookup gates duplicate media tasks. A table scan is intentional so a
  // stale secondary index cannot hide an existing task between integrity checks.
  return db
    .prepare(
      `SELECT ${selectColumns}
       FROM task_runs NOT INDEXED
       WHERE owner_key = ?
       ORDER BY created_at ASC, task_id ASC`,
    )
    .all(ownerKey) as TaskRegistryRow[];
}

function selectTaskRowsByRuntimeSourceId(
  db: DatabaseSync,
  runtime: TaskRuntime,
  sourceId?: string,
): TaskRegistryRow[] {
  let query = getTaskRegistryKysely(db)
    .selectFrom("task_runs")
    .select(TASK_RUN_SELECT_COLUMNS)
    .where("runtime", "=", runtime);
  if (sourceId !== undefined) {
    query = query.where("source_id", "=", sourceId);
  }
  return executeSqliteQuerySync(db, query.orderBy("created_at", "asc").orderBy("task_id", "asc"))
    .rows;
}

/** Reads task records from the caller's shared-state transaction. */
export function listTaskRecordsByRuntimeSourceIdInDatabase(
  db: DatabaseSync,
  runtime: TaskRuntime,
  sourceId: string,
): TaskRecord[] {
  return selectTaskRowsByRuntimeSourceId(db, runtime, sourceId).map(rowToTaskRecord);
}

function selectTaskDeliveryStateRows(db: DatabaseSync): TaskDeliveryStateRow[] {
  const query = getTaskRegistryKysely(db)
    .selectFrom("task_delivery_state")
    .select(TASK_DELIVERY_STATE_SELECT_COLUMNS)
    .orderBy("task_id", "asc");
  return executeSqliteQuerySync(db, query).rows;
}

/** Upserts a prebound task on the exact supplied shared-state handle. */
export function upsertTaskRunRowInDatabase(
  database: OpenClawStateDatabase,
  row: BoundTaskRecord,
): void {
  const { db } = database;
  const updates = { ...row, task_id: undefined };
  executeSqliteQuerySync(
    db,
    getTaskRegistryKysely(db)
      .insertInto("task_runs")
      .values(row)
      .onConflict((conflict) => conflict.column("task_id").doUpdateSet(updates)),
  );
}

export function insertOrMatchTaskRowsInDatabase(
  database: OpenClawStateDatabase,
  task: BoundTaskRecord,
  delivery?: BoundTaskDeliveryState,
): void {
  const kysely = getTaskRegistryKysely(database.db);
  executeSqliteQuerySync(
    database.db,
    kysely
      .insertInto("task_runs")
      .values(task)
      .onConflict((conflict) => conflict.doNothing()),
  );
  const storedTask = executeSqliteQueryTakeFirstSync(
    database.db,
    kysely.selectFrom("task_runs").selectAll().where("task_id", "=", task.task_id),
  );
  if (!storedTask || !isDeepStrictEqual({ ...storedTask }, task)) {
    throw new Error(`atomic task row conflicts with ${task.task_id}`);
  }
  if (!delivery) {
    return;
  }
  executeSqliteQuerySync(
    database.db,
    kysely
      .insertInto("task_delivery_state")
      .values(delivery)
      .onConflict((conflict) => conflict.doNothing()),
  );
  const storedDelivery = executeSqliteQueryTakeFirstSync(
    database.db,
    kysely.selectFrom("task_delivery_state").selectAll().where("task_id", "=", delivery.task_id),
  );
  if (!storedDelivery || !isDeepStrictEqual({ ...storedDelivery }, delivery)) {
    throw new Error(`atomic task delivery row conflicts with ${delivery.task_id}`);
  }
}

/** Terminalizes matching task projections inside an enclosing shared-state transaction. */
export function transitionTaskRunsToTerminalInDatabase(
  database: OpenClawStateDatabase,
  params: {
    runId: string;
    runtime: TaskRuntime;
    status: Extract<TaskRecord["status"], "succeeded" | "failed" | "lost">;
    endedAt: number;
    error?: string;
  },
): TaskRecord[] {
  const kysely = getTaskRegistryKysely(database.db);
  executeSqliteQuerySync(
    database.db,
    kysely
      .updateTable("task_runs")
      .set({
        status: params.status,
        ended_at: params.endedAt,
        last_event_at: params.endedAt,
        error: params.error ?? null,
      })
      .where("run_id", "=", params.runId)
      .where("runtime", "=", params.runtime)
      .where("status", "in", ["queued", "running"]),
  );
  return executeSqliteQuerySync(
    database.db,
    kysely
      .selectFrom("task_runs")
      .select(TASK_RUN_SELECT_COLUMNS)
      .where("run_id", "=", params.runId)
      .where("runtime", "=", params.runtime)
      .where("status", "=", params.status),
  ).rows.map(rowToTaskRecord);
}

function replaceTaskDeliveryStateRow(
  db: DatabaseSync,
  row: Insertable<TaskDeliveryStateTable>,
): void {
  executeSqliteQuerySync(
    db,
    getTaskRegistryKysely(db)
      .insertInto("task_delivery_state")
      .values(row)
      .onConflict((conflict) =>
        conflict.column("task_id").doUpdateSet({
          requester_origin_json: (eb) => eb.ref("excluded.requester_origin_json"),
          last_notified_event_at: (eb) => eb.ref("excluded.last_notified_event_at"),
        }),
      ),
  );
}

function deleteTaskRowsWithDeliveryState(db: DatabaseSync, taskId: string): void {
  const kysely = getTaskRegistryKysely(db);
  executeSqliteQuerySync(
    db,
    kysely.deleteFrom("task_delivery_state").where("task_id", "=", taskId),
  );
  executeSqliteQuerySync(db, kysely.deleteFrom("task_runs").where("task_id", "=", taskId));
}

function openTaskRegistryDatabase(): TaskRegistryDatabase {
  const database = openOpenClawStateDatabase();
  const pathname = database.path;
  if (cachedDatabase && cachedDatabase.path === pathname && cachedDatabase.db.isOpen) {
    return cachedDatabase;
  }
  if (cachedDatabase && !cachedDatabase.db.isOpen) {
    cachedDatabase = null;
  }
  cachedDatabase = {
    db: database.db,
    path: pathname,
  };
  return cachedDatabase;
}

function withWriteTransaction(write: (database: OpenClawStateDatabase) => void) {
  // Open once before BEGIN; the callback receives that exact shared-state owner.
  openTaskRegistryDatabase();
  runOpenClawStateWriteTransaction((database) => write(database));
}

function readTaskRegistrySnapshot({ db, path }: TaskRegistryDatabase): TaskRegistryStoreSnapshot {
  return runSqliteDeferredTransactionSync(db, () => {
    assertSqliteTableIntegrity(db, path, "task_runs");
    assertSqliteTableIntegrity(db, path, "task_delivery_state");
    const taskRows = selectTaskRows(db);
    const deliveryRows = selectTaskDeliveryStateRows(db);
    return {
      tasks: new Map(taskRows.map((row) => [row.task_id, rowToTaskRecord(row)])),
      deliveryStates: new Map(
        deliveryRows.map((row) => [row.task_id, rowToTaskDeliveryState(row)]),
      ),
    };
  });
}

export function loadTaskRegistryStateFromSqlite(): TaskRegistryStoreSnapshot {
  return readTaskRegistrySnapshot(openTaskRegistryDatabase());
}

/** Loads task records without creating or migrating shared state. */
export function loadTaskRegistryStateFromSqliteReadOnly(): TaskRegistryStoreSnapshot {
  return loadTaskRegistryStateFromSqliteReadOnlyResult().snapshot;
}

/** Reads task state only when the existing database already has the canonical task shape. */
export function loadTaskRegistryStateFromSqliteReadOnlyResult(): TaskRegistryReadOnlyLoadResult {
  return (
    withExistingOpenClawStateDatabaseReadOnly(({ db, path }) => {
      const hasReadableSchema =
        tableExists(db, "task_runs") &&
        tableExists(db, "task_delivery_state") &&
        tableHasColumns(db, "task_runs", TASK_RUN_SELECT_COLUMNS) &&
        tableHasColumns(db, "task_delivery_state", TASK_DELIVERY_STATE_SELECT_COLUMNS);
      return hasReadableSchema
        ? { state: "ready" as const, snapshot: readTaskRegistrySnapshot({ db, path }) }
        : {
            state: "migration-required" as const,
            snapshot: { tasks: new Map(), deliveryStates: new Map() },
          };
    }) ?? {
      state: "ready",
      snapshot: {
        tasks: new Map(),
        deliveryStates: new Map(),
      },
    }
  );
}

export function listTaskRegistryRecordsByOwnerKeyFromSqlite(ownerKey: string): TaskRecord[] {
  const key = ownerKey.trim();
  if (!key) {
    return [];
  }
  const { db } = openTaskRegistryDatabase();
  return selectTaskRowsByOwnerKey(db, key).map(rowToTaskRecord);
}

/** Reads task rows for one runtime/source without restoring the process registry snapshot. */
export function listTaskRegistryRecordsByRuntimeSourceIdFromSqlite(params: {
  runtime: TaskRuntime;
  sourceId?: string;
}): TaskRecord[] {
  const sourceId = params.sourceId?.trim();
  if (params.sourceId !== undefined && !sourceId) {
    return [];
  }
  return (
    withExistingOpenClawStateDatabaseReadOnly(({ db }) =>
      selectTaskRowsByRuntimeSourceId(db, params.runtime, sourceId).map(rowToTaskRecord),
    ) ?? []
  );
}

export function saveTaskRegistryStateToSqlite(snapshot: TaskRegistryStoreSnapshot) {
  withWriteTransaction((database) => {
    const { db } = database;
    const kysely = getTaskRegistryKysely(db);
    const taskIds = [...snapshot.tasks.keys()];
    if (taskIds.length === 0) {
      executeSqliteQuerySync(db, kysely.deleteFrom("task_delivery_state"));
      executeSqliteQuerySync(db, kysely.deleteFrom("task_runs"));
      return;
    }
    pruneRowsNotInSnapshot({
      db,
      tableName: "task_runs",
      columnName: "task_id",
      tempTableName: "openclaw_live_task_run_ids",
      ids: taskIds,
    });
    const deliveryTaskIds = [...snapshot.deliveryStates.keys()];
    if (deliveryTaskIds.length === 0) {
      executeSqliteQuerySync(db, kysely.deleteFrom("task_delivery_state"));
    } else {
      pruneRowsNotInSnapshot({
        db,
        tableName: "task_delivery_state",
        columnName: "task_id",
        tempTableName: "openclaw_live_task_delivery_ids",
        ids: deliveryTaskIds,
      });
    }
    for (const task of snapshot.tasks.values()) {
      upsertTaskRunRowInDatabase(database, bindTaskRecord(task));
    }
    for (const state of snapshot.deliveryStates.values()) {
      replaceTaskDeliveryStateRow(db, bindTaskDeliveryState(state));
    }
  });
}

export function upsertTaskRegistryRecordToSqlite(task: TaskRecord) {
  withWriteTransaction((database) => {
    upsertTaskRunRowInDatabase(database, bindTaskRecord(task));
  });
}

export function upsertTaskWithDeliveryStateToSqlite(params: {
  task: TaskRecord;
  deliveryState?: TaskDeliveryState;
}) {
  withWriteTransaction((database) => {
    const { db } = database;
    upsertTaskRunRowInDatabase(database, bindTaskRecord(params.task));
    if (params.deliveryState) {
      replaceTaskDeliveryStateRow(db, bindTaskDeliveryState(params.deliveryState));
    } else {
      executeSqliteQuerySync(
        db,
        getTaskRegistryKysely(db)
          .deleteFrom("task_delivery_state")
          .where("task_id", "=", params.task.taskId),
      );
    }
  });
}

export function deleteTaskRegistryRecordFromSqlite(taskId: string) {
  withWriteTransaction(({ db }) => {
    deleteTaskRowsWithDeliveryState(db, taskId);
  });
}

export function deleteTaskAndDeliveryStateFromSqlite(taskId: string) {
  withWriteTransaction(({ db }) => {
    deleteTaskRowsWithDeliveryState(db, taskId);
  });
}

export function upsertTaskDeliveryStateToSqlite(state: TaskDeliveryState) {
  withWriteTransaction(({ db }) => {
    replaceTaskDeliveryStateRow(db, bindTaskDeliveryState(state));
  });
}

export function deleteTaskDeliveryStateFromSqlite(taskId: string) {
  withWriteTransaction(({ db }) => {
    executeSqliteQuerySync(
      db,
      getTaskRegistryKysely(db).deleteFrom("task_delivery_state").where("task_id", "=", taskId),
    );
  });
}

export function closeTaskRegistryDatabase() {
  cachedDatabase = null;
  closeOpenClawStateDatabase();
}
