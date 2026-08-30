// Cron shared-store regression tests: a scheduler-disabled gateway's CRUD must
// not clobber runtime state a separate scheduler gateway wrote to the same
// SQLite state store, and must apply its edits to the current shared rows (#131401).
import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { setupCronServiceSuite } from "../service.test-harness.js";
import { loadCronJobsStoreWithConfigJobs, saveCronStore } from "../store.js";
import { cronStoreKey } from "../store/key.js";
import { updateCronRuntimeRows, upsertCronJobRow } from "../store/row-codec.js";
import type { CronJob } from "../types.js";
import { removeAgentJobsTransactional, update, updateWithPrecondition } from "./ops-mutations.js";
import { createCronServiceState } from "./state.js";
import { ensureLoaded } from "./store.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "cron-shared-store-runtime",
});

const SEED_UPDATED_AT_MS = 1_000;
const FOREIGN_CONFIG_UPDATED_AT_MS = 5_000;
const FOREIGN_RUNTIME_UPDATED_AT_MS = 8_000;
const FOREIGN_NEXT_RUN_AT_MS = 9_000;

function createSharedStoreJob(params?: {
  id?: string;
  description?: string;
  agentId?: string;
}): CronJob {
  return {
    id: params?.id ?? "shared-job",
    name: params?.id ?? "shared-job",
    enabled: true,
    createdAtMs: 0,
    updatedAtMs: SEED_UPDATED_AT_MS,
    schedule: { kind: "cron", expr: "0 6 * * *", tz: "UTC" },
    sessionTarget: "main",
    wakeMode: "now",
    payload: { kind: "systemEvent", text: "tick" },
    ...(params?.agentId === undefined ? {} : { agentId: params.agentId }),
    ...(params?.description === undefined ? {} : { description: params.description }),
    state: {},
  };
}

function createGatewayState(storePath: string, cronEnabled: boolean) {
  return createCronServiceState({
    storePath,
    cronEnabled,
    log: logger,
    nowMs: () => Date.now(),
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
  });
}

/** Commits runtime rows the way a separate scheduler gateway process would,
 *  without bumping this process's revision map. */
function commitForeignRuntimeRows(storePath: string, jobs: CronJob[]) {
  const storeKey = cronStoreKey(path.resolve(storePath));
  runOpenClawStateWriteTransaction(({ db }) => {
    updateCronRuntimeRows(db, storeKey, { version: 1, jobs });
  });
}

/** Commits one full row the way a separate gateway's CRUD process would. */
function commitForeignJobRow(storePath: string, job: CronJob, sortOrder: number) {
  const storeKey = cronStoreKey(path.resolve(storePath));
  runOpenClawStateWriteTransaction(({ db }) => {
    upsertCronJobRow(db, storeKey, job, sortOrder);
  });
}

async function loadPersistedJob(storePath: string, jobId: string) {
  const loaded = await loadCronJobsStoreWithConfigJobs(storePath);
  const job = loaded.store.jobs.find((entry) => entry.id === jobId);
  if (!job) {
    throw new Error(`missing persisted job ${jobId}`);
  }
  return job;
}

describe("shared SQLite cron store across gateways", () => {
  it("keeps newer foreign runtime state when a scheduler-disabled gateway edits an unrelated job", async () => {
    const { storePath } = await makeStorePath();
    const jobA = createSharedStoreJob({ id: "shared-job-a" });
    const jobB = createSharedStoreJob({ id: "shared-job-b" });
    await saveCronStore(storePath, { version: 1, jobs: [jobA, jobB] });

    const managementGateway = createGatewayState(storePath, false);
    await ensureLoaded(managementGateway, { skipRecompute: true });

    // A separate scheduler gateway advances job A's runtime state in the
    // shared store after the management gateway loaded its stale snapshot.
    commitForeignRuntimeRows(storePath, [
      {
        ...jobA,
        updatedAtMs: FOREIGN_RUNTIME_UPDATED_AT_MS,
        state: {
          nextRunAtMs: FOREIGN_NEXT_RUN_AT_MS,
          lastRunAtMs: FOREIGN_RUNTIME_UPDATED_AT_MS,
        },
      },
    ]);

    await update(managementGateway, "shared-job-b", {
      description: "edited by management gateway",
    });

    const persistedJobA = await loadPersistedJob(storePath, "shared-job-a");
    expect(persistedJobA.state.nextRunAtMs).toBe(FOREIGN_NEXT_RUN_AT_MS);
    expect(persistedJobA.state.lastRunAtMs).toBe(FOREIGN_RUNTIME_UPDATED_AT_MS);
    expect(persistedJobA.updatedAtMs).toBe(FOREIGN_RUNTIME_UPDATED_AT_MS);

    const persistedJobB = await loadPersistedJob(storePath, "shared-job-b");
    expect(persistedJobB.description).toBe("edited by management gateway");
  });

  it("preserves config-identical rows' newer runtime state during a full store rewrite", async () => {
    const { storePath } = await makeStorePath();
    const jobA = createSharedStoreJob({ id: "shared-job-a" });
    const jobB = createSharedStoreJob({ id: "shared-job-b" });
    await saveCronStore(storePath, { version: 1, jobs: [jobA, jobB] });

    // Even an enabled gateway keeps its in-process snapshot when the foreign
    // commit does not touch this process's revision map.
    const gateway = createGatewayState(storePath, true);
    await ensureLoaded(gateway, { skipRecompute: true });

    commitForeignRuntimeRows(storePath, [
      {
        ...jobA,
        updatedAtMs: FOREIGN_RUNTIME_UPDATED_AT_MS,
        state: {
          nextRunAtMs: FOREIGN_NEXT_RUN_AT_MS,
          lastRunAtMs: FOREIGN_RUNTIME_UPDATED_AT_MS,
        },
      },
    ]);

    await update(gateway, "shared-job-b", {
      description: "edited by gateway",
    });

    const persistedJobA = await loadPersistedJob(storePath, "shared-job-a");
    expect(persistedJobA.state.nextRunAtMs).toBe(FOREIGN_NEXT_RUN_AT_MS);
    expect(persistedJobA.state.lastRunAtMs).toBe(FOREIGN_RUNTIME_UPDATED_AT_MS);
    expect(persistedJobA.updatedAtMs).toBe(FOREIGN_RUNTIME_UPDATED_AT_MS);
  });

  it("applies scheduler-disabled CRUD to current shared rows instead of a stale snapshot", async () => {
    const { storePath } = await makeStorePath();
    const jobB = createSharedStoreJob({ id: "shared-job-b" });
    await saveCronStore(storePath, { version: 1, jobs: [jobB] });

    const managementGateway = createGatewayState(storePath, false);
    await ensureLoaded(managementGateway, { skipRecompute: true });

    // A separate gateway edits the same job's config after the snapshot was taken.
    commitForeignJobRow(
      storePath,
      { ...jobB, description: "foreign edit", updatedAtMs: FOREIGN_CONFIG_UPDATED_AT_MS },
      0,
    );

    await update(managementGateway, "shared-job-b", {
      name: "renamed by management gateway",
    });

    const persistedJobB = await loadPersistedJob(storePath, "shared-job-b");
    expect(persistedJobB.name).toBe("renamed by management gateway");
    expect(persistedJobB.description).toBe("foreign edit");
    expect(persistedJobB.updatedAtMs).toBeGreaterThan(FOREIGN_CONFIG_UPDATED_AT_MS);
  });

  it("preserves scheduler runtime committed between reload and write for the edited job", async () => {
    const { storePath } = await makeStorePath();
    const jobB = createSharedStoreJob({ id: "shared-job-b" });
    await saveCronStore(storePath, { version: 1, jobs: [jobB] });

    const managementGateway = createGatewayState(storePath, false);
    await ensureLoaded(managementGateway, { skipRecompute: true });

    // The precondition runs after the mutation-time reload but before the
    // write transaction, so a scheduler commit landing in that interval is a
    // same-job runtime update newer than the reloaded snapshot.
    await updateWithPrecondition(
      managementGateway,
      "shared-job-b",
      { name: "renamed by management gateway" },
      async () => {
        commitForeignRuntimeRows(storePath, [
          {
            ...jobB,
            updatedAtMs: FOREIGN_RUNTIME_UPDATED_AT_MS,
            state: {
              nextRunAtMs: FOREIGN_NEXT_RUN_AT_MS,
              lastRunAtMs: FOREIGN_RUNTIME_UPDATED_AT_MS,
            },
          },
        ]);
      },
    );

    const persistedJobB = await loadPersistedJob(storePath, "shared-job-b");
    expect(persistedJobB.name).toBe("renamed by management gateway");
    expect(persistedJobB.state.nextRunAtMs).toBe(FOREIGN_NEXT_RUN_AT_MS);
    expect(persistedJobB.state.lastRunAtMs).toBe(FOREIGN_RUNTIME_UPDATED_AT_MS);
    expect(persistedJobB.updatedAtMs).toBe(FOREIGN_RUNTIME_UPDATED_AT_MS);
  });

  it("lets a scheduling edit recompute runtime instead of keeping foreign runtime", async () => {
    const { storePath } = await makeStorePath();
    const jobB = createSharedStoreJob({ id: "shared-job-b" });
    await saveCronStore(storePath, { version: 1, jobs: [jobB] });

    const managementGateway = createGatewayState(storePath, false);
    await ensureLoaded(managementGateway, { skipRecompute: true });

    await updateWithPrecondition(
      managementGateway,
      "shared-job-b",
      { schedule: { kind: "cron", expr: "0 7 * * *", tz: "UTC" } },
      async () => {
        commitForeignRuntimeRows(storePath, [
          {
            ...jobB,
            updatedAtMs: FOREIGN_RUNTIME_UPDATED_AT_MS,
            state: {
              nextRunAtMs: FOREIGN_NEXT_RUN_AT_MS,
              lastRunAtMs: FOREIGN_RUNTIME_UPDATED_AT_MS,
            },
          },
        ]);
      },
    );

    // The new schedule owns scheduling state: its recomputed next run replaces
    // the stale slot the scheduler wrote under the previous schedule.
    const persistedJobB = await loadPersistedJob(storePath, "shared-job-b");
    expect(persistedJobB.schedule).toEqual({ kind: "cron", expr: "0 7 * * *", tz: "UTC" });
    expect(persistedJobB.state.nextRunAtMs).not.toBe(FOREIGN_NEXT_RUN_AT_MS);
    expect(persistedJobB.updatedAtMs).toBeGreaterThan(FOREIGN_RUNTIME_UPDATED_AT_MS);
  });

  it("detects equal-timestamp foreign runtime commits by comparing state content", async () => {
    const { storePath } = await makeStorePath();
    const jobB = createSharedStoreJob({ id: "shared-job-b" });
    await saveCronStore(storePath, { version: 1, jobs: [jobB] });

    const managementGateway = createGatewayState(storePath, false);
    await ensureLoaded(managementGateway, { skipRecompute: true });

    await updateWithPrecondition(
      managementGateway,
      "shared-job-b",
      { name: "renamed by management gateway" },
      async () => {
        // The foreign runtime commit carries the same runtime timestamp as the
        // reload baseline; only its state content differs.
        commitForeignRuntimeRows(storePath, [
          {
            ...jobB,
            updatedAtMs: SEED_UPDATED_AT_MS,
            state: {
              nextRunAtMs: FOREIGN_NEXT_RUN_AT_MS,
              lastRunAtMs: SEED_UPDATED_AT_MS,
            },
          },
        ]);
      },
    );

    const persistedJobB = await loadPersistedJob(storePath, "shared-job-b");
    expect(persistedJobB.name).toBe("renamed by management gateway");
    expect(persistedJobB.state.nextRunAtMs).toBe(FOREIGN_NEXT_RUN_AT_MS);
    expect(persistedJobB.state.lastRunAtMs).toBe(SEED_UPDATED_AT_MS);
  });

  it("hydrates preserved foreign runtime into the service state", async () => {
    const { storePath } = await makeStorePath();
    const jobB = createSharedStoreJob({ id: "shared-job-b" });
    await saveCronStore(storePath, { version: 1, jobs: [jobB] });

    const managementGateway = createGatewayState(storePath, false);
    await ensureLoaded(managementGateway, { skipRecompute: true });

    const updated = await updateWithPrecondition(
      managementGateway,
      "shared-job-b",
      { name: "renamed by management gateway" },
      async () => {
        commitForeignRuntimeRows(storePath, [
          {
            ...jobB,
            updatedAtMs: FOREIGN_RUNTIME_UPDATED_AT_MS,
            state: {
              nextRunAtMs: FOREIGN_NEXT_RUN_AT_MS,
              lastRunAtMs: FOREIGN_RUNTIME_UPDATED_AT_MS,
            },
          },
        ]);
      },
    );

    // The update response and the in-memory service store both reflect the
    // preserved foreign runtime instead of the stale snapshot values.
    expect(updated.state.nextRunAtMs).toBe(FOREIGN_NEXT_RUN_AT_MS);
    const inMemoryJob = managementGateway.store?.jobs.find((job) => job.id === "shared-job-b");
    expect(inMemoryJob?.state.nextRunAtMs).toBe(FOREIGN_NEXT_RUN_AT_MS);
    expect(inMemoryJob?.state.lastRunAtMs).toBe(FOREIGN_RUNTIME_UPDATED_AT_MS);
  });

  it("keeps explicitly patched runtime fields instead of the foreign row", async () => {
    const { storePath } = await makeStorePath();
    const jobB = createSharedStoreJob({ id: "shared-job-b" });
    await saveCronStore(storePath, { version: 1, jobs: [jobB] });

    const managementGateway = createGatewayState(storePath, false);
    await ensureLoaded(managementGateway, { skipRecompute: true });

    await updateWithPrecondition(
      managementGateway,
      "shared-job-b",
      { name: "renamed", state: { lastRunAtMs: 5555, lastRunStatus: "ok" } },
      async () => {
        commitForeignRuntimeRows(storePath, [
          {
            ...jobB,
            updatedAtMs: FOREIGN_RUNTIME_UPDATED_AT_MS,
            state: { nextRunAtMs: FOREIGN_NEXT_RUN_AT_MS, lastRunAtMs: 8000 },
          },
        ]);
      },
    );

    // An explicit state patch owns the row's runtime: the foreign row must not
    // silently replace the caller-requested fields.
    const persistedJobB = await loadPersistedJob(storePath, "shared-job-b");
    expect(persistedJobB.state.lastRunAtMs).toBe(5555);
    expect(persistedJobB.state.lastRunStatus).toBe("ok");
    expect(persistedJobB.state.nextRunAtMs).not.toBe(FOREIGN_NEXT_RUN_AT_MS);
  });

  it("does not keep foreign runtime computed for a concurrently changed schedule", async () => {
    const { storePath } = await makeStorePath();
    const jobB = createSharedStoreJob({ id: "shared-job-b" });
    await saveCronStore(storePath, { version: 1, jobs: [jobB] });

    const managementGateway = createGatewayState(storePath, false);
    await ensureLoaded(managementGateway, { skipRecompute: true });

    await updateWithPrecondition(
      managementGateway,
      "shared-job-b",
      { name: "renamed" },
      async () => {
        // A separate gateway changes the schedule after the reload; its runtime
        // belongs to that new schedule and must not survive a cosmetic edit
        // that writes the previous schedule back.
        commitForeignJobRow(
          storePath,
          {
            ...jobB,
            schedule: { kind: "cron", expr: "0 7 * * *", tz: "UTC" },
            updatedAtMs: FOREIGN_RUNTIME_UPDATED_AT_MS,
            state: { nextRunAtMs: FOREIGN_NEXT_RUN_AT_MS, lastRunAtMs: 8000 },
          },
          0,
        );
      },
    );

    const persistedJobB = await loadPersistedJob(storePath, "shared-job-b");
    expect(persistedJobB.state.nextRunAtMs).not.toBe(FOREIGN_NEXT_RUN_AT_MS);
    expect(persistedJobB.state.lastRunAtMs).not.toBe(FOREIGN_RUNTIME_UPDATED_AT_MS);
  });

  it("preserves foreign runtime through an agent-deletion rollback", async () => {
    const { storePath } = await makeStorePath();
    const jobA = createSharedStoreJob({ id: "agent-job", agentId: "agent-x" });
    const jobB = createSharedStoreJob({ id: "shared-job-b" });
    await saveCronStore(storePath, { version: 1, jobs: [jobA, jobB] });

    const managementGateway = createGatewayState(storePath, false);
    await ensureLoaded(managementGateway, { skipRecompute: true });

    await expect(
      removeAgentJobsTransactional(managementGateway, "agent-x", async () => {
        // The scheduler advances the unrelated job while the roster commit is
        // in flight; the rollback must not replay the stale snapshot over it.
        commitForeignRuntimeRows(storePath, [
          {
            ...jobB,
            updatedAtMs: FOREIGN_RUNTIME_UPDATED_AT_MS,
            state: { nextRunAtMs: FOREIGN_NEXT_RUN_AT_MS, lastRunAtMs: 8000 },
          },
        ]);
        throw new Error("roster commit failed");
      }),
    ).rejects.toThrow("roster commit failed");

    const persistedJobB = await loadPersistedJob(storePath, "shared-job-b");
    expect(persistedJobB.state.nextRunAtMs).toBe(FOREIGN_NEXT_RUN_AT_MS);
    expect(persistedJobB.state.lastRunAtMs).toBe(FOREIGN_RUNTIME_UPDATED_AT_MS);
    expect(await loadPersistedJob(storePath, "agent-job")).toBeTruthy();
  });
});
it("does not revive old trigger state when the trigger definition is replaced", async () => {
  const { storePath } = await makeStorePath();
  const jobB: CronJob = {
    ...createSharedStoreJob({ id: "shared-job-b" }),
    trigger: { script: "return false" },
    state: { triggerState: { seen: 1 }, triggerEvalCount: 3 },
  };
  await saveCronStore(storePath, { version: 1, jobs: [jobB] });

  const managementGateway = createGatewayState(storePath, false);
  await ensureLoaded(managementGateway, { skipRecompute: true });

  await updateWithPrecondition(
    managementGateway,
    "shared-job-b",
    { trigger: { script: "return true" } },
    async () => {
      commitForeignRuntimeRows(storePath, [
        {
          ...jobB,
          updatedAtMs: FOREIGN_RUNTIME_UPDATED_AT_MS,
          state: {
            ...jobB.state,
            nextRunAtMs: FOREIGN_NEXT_RUN_AT_MS,
            lastRunAtMs: FOREIGN_RUNTIME_UPDATED_AT_MS,
          },
        },
      ]);
    },
  );

  // Replacing the trigger definition retires its evaluation state; the kept
  // foreign runtime must not reattach old triggerState to the new script.
  const persistedJobB = await loadPersistedJob(storePath, "shared-job-b");
  expect(persistedJobB.trigger).toEqual({ script: "return true" });
  expect(persistedJobB.state.triggerState).toBeUndefined();
  expect(persistedJobB.state.triggerEvalCount).toBeUndefined();
});

it("keeps explicit runtime-state patches when the foreign clock runs ahead", async () => {
  const { storePath } = await makeStorePath();
  const jobB = createSharedStoreJob({ id: "shared-job-b" });
  await saveCronStore(storePath, { version: 1, jobs: [jobB] });

  const managementGateway = createGatewayState(storePath, false);
  await ensureLoaded(managementGateway, { skipRecompute: true });

  const SKEWED_FOREIGN_RUNTIME_AT_MS = 9_999_999_999_999;
  await updateWithPrecondition(
    managementGateway,
    "shared-job-b",
    { state: { lastRunAtMs: 5555 } },
    async () => {
      // The scheduler gateway's clock is far ahead of the management
      // gateway's; its runtime timestamp exceeds every local timestamp.
      commitForeignRuntimeRows(storePath, [
        {
          ...jobB,
          updatedAtMs: SKEWED_FOREIGN_RUNTIME_AT_MS,
          state: { nextRunAtMs: FOREIGN_NEXT_RUN_AT_MS, lastRunAtMs: 8000 },
        },
      ]);
    },
  );

  const persistedJobB = await loadPersistedJob(storePath, "shared-job-b");
  expect(persistedJobB.state.lastRunAtMs).toBe(5555);
  expect(persistedJobB.state.nextRunAtMs).not.toBe(FOREIGN_NEXT_RUN_AT_MS);
});

it("retires foreign trigger state created after the reload when the trigger is replaced", async () => {
  const { storePath } = await makeStorePath();
  const jobB: CronJob = {
    ...createSharedStoreJob({ id: "shared-job-b" }),
    trigger: { script: "return false" },
    state: {},
  };
  await saveCronStore(storePath, { version: 1, jobs: [jobB] });

  const managementGateway = createGatewayState(storePath, false);
  await ensureLoaded(managementGateway, { skipRecompute: true });

  await updateWithPrecondition(
    managementGateway,
    "shared-job-b",
    { trigger: { script: "return true" } },
    async () => {
      // The scheduler evaluates the old trigger after the reload and stores
      // fresh trigger state that the baseline never saw.
      commitForeignRuntimeRows(storePath, [
        {
          ...jobB,
          updatedAtMs: FOREIGN_RUNTIME_UPDATED_AT_MS,
          state: {
            nextRunAtMs: FOREIGN_NEXT_RUN_AT_MS,
            triggerState: { evaluated: true },
            triggerEvalCount: 7,
          },
        },
      ]);
    },
  );

  // The replaced trigger definition owns its evaluation state: scheduler
  // fields survive, but trigger state from the old definition does not.
  const persistedJobB = await loadPersistedJob(storePath, "shared-job-b");
  expect(persistedJobB.trigger).toEqual({ script: "return true" });
  expect(persistedJobB.state.triggerState).toBeUndefined();
  expect(persistedJobB.state.triggerEvalCount).toBeUndefined();
  expect(persistedJobB.state.nextRunAtMs).toBe(FOREIGN_NEXT_RUN_AT_MS);
});

describe("real cross-process shared SQLite cron store", () => {
  it("preserves scheduler runtime written by a separate gateway process", async () => {
    const { storePath } = await makeStorePath();
    const stateDir = path.dirname(path.dirname(storePath));
    const jobA = createSharedStoreJob({ id: "shared-job-a" });
    const jobB = createSharedStoreJob({ id: "shared-job-b" });

    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      await saveCronStore(storePath, { version: 1, jobs: [jobA, jobB] });
      const managementGateway = createGatewayState(storePath, false);
      await ensureLoaded(managementGateway, { skipRecompute: true });

      // A real scheduler gateway is a separate OS process: spawn one that
      // advances job A's runtime through its own state database connection.
      const schedulerScript = `
        import { runOpenClawStateWriteTransaction } from ${JSON.stringify(pathToFileURL(path.resolve(import.meta.dirname, "../../state/openclaw-state-db.js")).href)};
        import { cronStoreKey } from ${JSON.stringify(pathToFileURL(path.resolve(import.meta.dirname, "../store/key.js")).href)};
        import { updateCronRuntimeRows } from ${JSON.stringify(pathToFileURL(path.resolve(import.meta.dirname, "../store/row-codec.js")).href)};
        const job = ${JSON.stringify({
          ...jobA,
          updatedAtMs: FOREIGN_RUNTIME_UPDATED_AT_MS,
          state: {
            nextRunAtMs: FOREIGN_NEXT_RUN_AT_MS,
            lastRunAtMs: FOREIGN_RUNTIME_UPDATED_AT_MS,
          },
        })};
        runOpenClawStateWriteTransaction(({ db }) => {
          updateCronRuntimeRows(db, cronStoreKey(${JSON.stringify(path.resolve(storePath))}), {
            version: 1,
            jobs: [job],
          });
        });
        console.log("scheduler committed");
      `;
      const scheduler = spawnSync(
        process.execPath,
        [
          "--import",
          pathToFileURL(path.resolve(import.meta.dirname, "../../../scripts/tsx.mjs")).href,
          "--input-type=module",
          "-e",
          schedulerScript,
        ],
        { encoding: "utf8", timeout: 90_000 },
      );
      expect(scheduler.status).toBe(0);
      expect(scheduler.stdout).toContain("scheduler committed");

      await update(managementGateway, "shared-job-b", {
        description: "edited by management gateway",
      });

      const persistedJobA = await loadPersistedJob(storePath, "shared-job-a");
      expect(persistedJobA.state.nextRunAtMs).toBe(FOREIGN_NEXT_RUN_AT_MS);
      expect(persistedJobA.state.lastRunAtMs).toBe(FOREIGN_RUNTIME_UPDATED_AT_MS);
      const persistedJobB = await loadPersistedJob(storePath, "shared-job-b");
      expect(persistedJobB.description).toBe("edited by management gateway");
    });
  });
});
