import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../../state/openclaw-state-db.js";
import { loadTaskRegistryStateFromSqlite } from "../../../tasks/task-registry.store.sqlite.js";
import type { TaskRecord } from "../../../tasks/task-registry.types.js";
import { withEnvAsync } from "../../../test-utils/env.js";
import {
  prepareSubagentLaunchRecord,
  reserveSubagentLaunchRecord,
  transitionDispatchingSubagentLaunchToRunning,
  transitionPreparedSubagentLaunchToDispatching,
  transitionSubagentLaunchToTerminal,
} from "./subagent-registry.store.sqlite.js";
import { loadSubagentRegistryFromSqlite } from "./subagent-registry.store.sqlite.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

function reservedRun(fingerprint = "sha256:first"): SubagentRunRecord {
  return {
    runId: "swarm_stable",
    taskRunId: "swarm_stable",
    childSessionKey: "agent:worker:subagent:stable",
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    requesterAgentId: "main",
    task: "collect",
    cleanup: "delete",
    collect: true,
    swarmRequesterSessionKey: "agent:main:main",
    swarmRunId: "swarm_stable",
    schedulerSlotId: "swarm_stable",
    createdAt: 100,
    execution: { status: "queued" },
    completion: { required: false },
    delivery: { status: "not_required" },
    launch: {
      phase: "reserved",
      replayKey: "code-run:request-1",
      requestFingerprint: fingerprint,
      gatewayIdempotencyKey: "swarm_stable",
      childSessionId: "session_stable",
      childLifecycleRevision: "lifecycle_stable",
      revision: 0,
    },
  };
}

describe("subagent launch reservation store", () => {
  let stateDir = "";

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-launch-reservation-"));
  });

  afterEach(async () => {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("inserts once, replays exact identity, and rejects a mismatched fingerprint", async () => {
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      const first = reserveSubagentLaunchRecord(reservedRun());
      expect(first.action).toBe("reserved");
      expect(reserveSubagentLaunchRecord(reservedRun()).action).toBe("replay");
      expect(reserveSubagentLaunchRecord(reservedRun("sha256:other")).action).toBe("conflict");
      expect(loadSubagentRegistryFromSqlite()).toHaveLength(1);
    });
  });

  it("serializes reservation authority across two SQLite connections", async () => {
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      reserveSubagentLaunchRecord(reservedRun());
      const database = openOpenClawStateDatabase();
      database.db.exec("PRAGMA busy_timeout = 1");
      const contender = new DatabaseSync(database.path);
      try {
        contender.exec("PRAGMA busy_timeout = 1; BEGIN IMMEDIATE");
        expect(() =>
          reserveSubagentLaunchRecord({
            ...reservedRun(),
            runId: "swarm_contended",
            taskRunId: "swarm_contended",
          }),
        ).toThrow(/busy|locked/iu);
      } finally {
        contender.exec("ROLLBACK");
        contender.close();
      }
      expect(reserveSubagentLaunchRecord(reservedRun()).action).toBe("replay");
    });
  });

  it("CASes reserved through dispatching and running without renaming the canonical run", async () => {
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      const reserved = reserveSubagentLaunchRecord(reservedRun()).entry;
      if (!reserved.launch) {
        throw new Error("expected reserved launch");
      }
      const prepared: SubagentRunRecord = {
        ...reserved,
        queuedLaunch: {
          request: { idempotencyKey: reserved.runId },
          timeoutMs: 1000,
          schedulerGroupKey: "group",
          maxConcurrent: 1,
        },
        launch: {
          ...reserved.launch,
          phase: "prepared",
          revision: 1,
          preparedAt: 200,
        },
      };
      expect(prepareSubagentLaunchRecord({ expected: reserved, prepared }).launch?.phase).toBe(
        "prepared",
      );
      const dispatching = transitionPreparedSubagentLaunchToDispatching({
        runId: reserved.runId,
        executionAttemptId: "gateway-attempt",
        dispatchingAt: 300,
      });
      expect(dispatching).toMatchObject({
        runId: "swarm_stable",
        launch: {
          phase: "dispatching",
          executionAttemptId: "gateway-attempt",
          dispatchingAt: 300,
        },
        execution: { status: "running" },
      });
      expect(dispatching?.queuedLaunch).toBeUndefined();
      expect(
        transitionDispatchingSubagentLaunchToRunning({
          runId: reserved.runId,
          runningAt: 400,
        }),
      ).toMatchObject({
        runId: "swarm_stable",
        launch: { phase: "running", runningAt: 400 },
      });
    });
  });

  it.each([
    {
      phase: "dispatching" as const,
      terminalReason: "lost" as const,
      taskStatus: "lost" as const,
    },
    {
      phase: "running" as const,
      terminalReason: "interrupted" as const,
      taskStatus: "failed" as const,
    },
  ])(
    "atomically settles a $phase launch into waitable collector and task terminal state",
    async ({ phase, terminalReason, taskStatus }) => {
      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const reserved = reserveSubagentLaunchRecord(reservedRun()).entry;
        if (!reserved.launch) {
          throw new Error("expected reserved launch");
        }
        const task: TaskRecord = {
          taskId: "task_swarm_stable",
          runtime: "subagent",
          sourceId: reserved.runId,
          requesterSessionKey: reserved.requesterSessionKey,
          ownerKey: reserved.requesterSessionKey,
          scopeKind: "session",
          childSessionKey: reserved.childSessionKey,
          runId: reserved.runId,
          task: reserved.task,
          status: "queued",
          deliveryStatus: "not_applicable",
          notifyPolicy: "silent",
          createdAt: reserved.createdAt,
          lastEventAt: reserved.createdAt,
        };
        const prepared = prepareSubagentLaunchRecord({
          expected: reserved,
          prepared: {
            ...reserved,
            queuedLaunch: {
              request: { idempotencyKey: reserved.runId },
              timeoutMs: 1000,
              schedulerGroupKey: "group",
              maxConcurrent: 1,
            },
            launch: {
              ...reserved.launch,
              phase: "prepared",
              revision: 1,
              preparedAt: 200,
            },
          },
          task,
        });
        transitionPreparedSubagentLaunchToDispatching({
          runId: prepared.runId,
          executionAttemptId: "gateway-attempt",
          dispatchingAt: 300,
        });
        if (phase === "running") {
          transitionDispatchingSubagentLaunchToRunning({
            runId: prepared.runId,
            runningAt: 350,
          });
        }
        const error =
          phase === "dispatching"
            ? "execution may have reached the provider and will not be retried"
            : "provider execution was interrupted by restart";
        const committed = transitionSubagentLaunchToTerminal({
          runId: prepared.runId,
          terminalAt: 400,
          terminalReason,
          error,
        });

        expect(committed?.entry).toMatchObject({
          runId: reserved.runId,
          taskRunId: reserved.taskRunId,
          schedulerSlotId: reserved.schedulerSlotId,
          collectorCompletion: { status: "failed" },
          completion: { resultText: error, capturedAt: 400 },
          launch: { phase: "terminal", terminalReason, terminalAt: 400 },
        });
        expect(committed?.tasks).toEqual([
          expect.objectContaining({
            taskId: task.taskId,
            runId: reserved.runId,
            status: taskStatus,
            endedAt: 400,
            lastEventAt: 400,
            error,
          }),
        ]);
        expect(loadSubagentRegistryFromSqlite().get(reserved.runId)).toEqual(committed?.entry);
        expect(loadTaskRegistryStateFromSqlite().tasks.get(task.taskId)).toEqual(
          committed?.tasks[0],
        );
      });
    },
  );
});
