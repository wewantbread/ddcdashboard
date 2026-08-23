import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { findTaskByRunId, reloadTaskRegistryFromStore } from "../../tasks/task-registry.js";
import type { TaskRecord } from "../../tasks/task-registry.types.js";
import { resetTaskRegistryForTests } from "../../tasks/task-runtime.test-helpers.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { buildClaudeLiveRunContext, mockClaudeLiveRun } from "../cli-runner.test-helpers.js";
import {
  restoreCliRunnerPrepareTestDeps,
  supervisorSpawnMock,
} from "../cli-runner.test-support.js";
import {
  createSubagentRegistryTestDeps,
  writeSubagentSessionEntry,
} from "../subagents/registry/subagent-registry.persistence.test-support.js";
import {
  loadSubagentRegistryFromSqlite,
  prepareSubagentLaunchRecord,
  reserveSubagentLaunchRecord,
  transitionDispatchingSubagentLaunchToRunning,
  transitionPreparedSubagentLaunchToDispatching,
} from "../subagents/registry/subagent-registry.store.sqlite.js";
import {
  activateSubagentRegistry,
  getSubagentRunByRunId,
  initSubagentRegistry,
  resetSubagentRegistryForTests,
  testing as subagentRegistryTesting,
} from "../subagents/registry/subagent-registry.test-helpers.js";
import type { SubagentRunRecord } from "../subagents/registry/subagent-registry.types.js";
import { waitForCollectorCompletion } from "../tools/agents-wait-tool.js";
import { resetClaudeLiveSessionsForTest } from "./claude-live-session.test-support.js";
import { executePreparedCliRun } from "./execute.js";

function reservedCollector(runId: string): SubagentRunRecord {
  return {
    runId,
    taskRunId: runId,
    childSessionKey: `agent:worker:subagent:${runId}`,
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    requesterAgentId: "main",
    task: "prove managed Claude acceptance",
    cleanup: "keep",
    collect: true,
    swarmRequesterSessionKey: "agent:main:main",
    swarmWaitOwnerSessionKeys: ["agent:main:main"],
    swarmRunId: runId,
    schedulerSlotId: runId,
    createdAt: 100,
    execution: { status: "queued" },
    completion: { required: false },
    delivery: { status: "not_required" },
    launch: {
      phase: "reserved",
      replayKey: `replay:${runId}`,
      requestFingerprint: `fingerprint:${runId}`,
      gatewayIdempotencyKey: runId,
      childSessionId: `session-${runId}`,
      childLifecycleRevision: `lifecycle-${runId}`,
      revision: 0,
    },
  };
}

function prepareCollector(runId: string): SubagentRunRecord {
  const reserved = reserveSubagentLaunchRecord(reservedCollector(runId)).entry;
  if (!reserved.launch) {
    throw new Error("expected reserved collector launch");
  }
  const task: TaskRecord = {
    taskId: `task_${runId}`,
    runtime: "subagent",
    sourceId: runId,
    requesterSessionKey: reserved.requesterSessionKey,
    ownerKey: reserved.requesterSessionKey,
    scopeKind: "session",
    childSessionKey: reserved.childSessionKey,
    runId,
    task: reserved.task,
    status: "queued",
    deliveryStatus: "not_applicable",
    notifyPolicy: "silent",
    createdAt: reserved.createdAt,
    lastEventAt: reserved.createdAt,
  };
  return prepareSubagentLaunchRecord({
    expected: reserved,
    prepared: {
      ...reserved,
      queuedLaunch: {
        request: { idempotencyKey: runId },
        timeoutMs: 1_000,
        schedulerGroupKey: "managed-claude",
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
}

function dispatchCollector(runId: string): void {
  const dispatching = transitionPreparedSubagentLaunchToDispatching({
    runId,
    executionAttemptId: `attempt-${runId}`,
    dispatchingAt: 300,
  });
  if (!dispatching) {
    throw new Error("collector launch is not prepared for provider dispatch");
  }
}

function markCollectorRunning(runId: string): void {
  if (
    !transitionDispatchingSubagentLaunchToRunning({
      runId,
      runningAt: 400,
    })
  ) {
    throw new Error("collector launch is not dispatching");
  }
}

async function withStateDirectory(run: (stateDir: string) => Promise<void>): Promise<void> {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-claude-live-launch-"));
  try {
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      await run(stateDir);
    });
  } finally {
    resetClaudeLiveSessionsForTest();
    subagentRegistryTesting.setDepsForTest();
    resetSubagentRegistryForTests({ persist: false });
    resetTaskRegistryForTests({ persist: false });
    closeOpenClawStateDatabaseForTest();
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

function managedClaudeContext(runId: string) {
  return buildClaudeLiveRunContext({
    runId,
    sessionId: `session-${runId}`,
    sessionKey: `agent:worker:subagent:${runId}`,
  });
}

beforeEach(() => {
  restoreCliRunnerPrepareTestDeps();
  supervisorSpawnMock.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("managed Claude launch recovery", () => {
  it("does not write stdin when the dispatch CAS rejects the launch", async () => {
    await withStateDirectory(async () => {
      const runId = "run-live-dispatch-rejected";
      reserveSubagentLaunchRecord(reservedCollector(runId));
      const context = managedClaudeContext(runId);
      context.params.onProviderDispatching = () => dispatchCollector(runId);
      context.params.onProviderRunning = () => markCollectorRunning(runId);

      await expect(executePreparedCliRun(context)).rejects.toThrow(
        "collector launch is not prepared",
      );

      expect(supervisorSpawnMock).not.toHaveBeenCalled();
      expect(loadSubagentRegistryFromSqlite().get(runId)?.launch?.phase).toBe("reserved");
    });
  });

  it("does not mark the launch running when the stdin write fails", async () => {
    await withStateDirectory(async () => {
      const runId = "run-live-write-rejected";
      prepareCollector(runId);
      const writeError = new Error("managed Claude stdin rejected");
      const stdin = {
        write: vi.fn((_data: string, callback?: (error?: Error | null) => void) => {
          callback?.(writeError);
        }),
        end: vi.fn(),
      };
      supervisorSpawnMock.mockImplementationOnce(async () => ({
        runId: "managed-live-write-rejected",
        pid: 4201,
        startedAtMs: Date.now(),
        stdin,
        wait: vi.fn(() => new Promise(() => {})),
        cancel: vi.fn(),
      }));
      const onProviderRunning = vi.fn(() => markCollectorRunning(runId));
      const context = managedClaudeContext(runId);
      context.params.onProviderDispatching = () => dispatchCollector(runId);
      context.params.onProviderRunning = onProviderRunning;

      await expect(executePreparedCliRun(context)).rejects.toThrow(writeError.message);

      expect(stdin.write).toHaveBeenCalledOnce();
      expect(onProviderRunning).not.toHaveBeenCalled();
      expect(loadSubagentRegistryFromSqlite().get(runId)?.launch?.phase).toBe("dispatching");
    });
  });

  it("marks accepted stdin running before result and restores it as waitable interrupted work", async () => {
    await withStateDirectory(async (stateDir) => {
      const runId = "run-live-accepted-before-crash";
      const prepared = prepareCollector(runId);
      if (!prepared.launch) {
        throw new Error("expected prepared collector launch");
      }
      await writeSubagentSessionEntry({
        stateDir,
        agentId: "worker",
        sessionKey: prepared.childSessionKey,
        sessionId: prepared.launch.childSessionId,
        defaultSessionId: prepared.launch.childSessionId,
        lifecycleRevision: prepared.launch.childLifecycleRevision,
      });
      const order: string[] = [];
      const live = mockClaudeLiveRun(supervisorSpawnMock, {
        cancelable: true,
        onWrite: () => order.push("stdin-write"),
      });
      const onProviderRunning = vi.fn(() => {
        order.push("running-cas");
        markCollectorRunning(runId);
      });
      const context = managedClaudeContext(runId);
      context.params.onProviderDispatching = () => {
        order.push("dispatching-cas");
        dispatchCollector(runId);
      };
      context.params.onProviderRunning = onProviderRunning;
      let settled = false;
      const execution = executePreparedCliRun(context);
      void execution.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );

      await vi.waitFor(() => {
        expect(loadSubagentRegistryFromSqlite().get(runId)?.launch?.phase).toBe("running");
      });
      expect(order).toEqual(["dispatching-cas", "stdin-write", "running-cas"]);
      expect(onProviderRunning).toHaveBeenCalledOnce();
      expect(settled).toBe(false);

      resetClaudeLiveSessionsForTest();
      await expect(execution).rejects.toThrow();
      closeOpenClawStateDatabaseForTest();
      resetSubagentRegistryForTests({ persist: false });
      resetTaskRegistryForTests({ persist: false });
      reloadTaskRegistryFromStore();
      const callGateway = vi.fn();
      subagentRegistryTesting.setDepsForTest({
        ...createSubagentRegistryTestDeps({
          callGateway,
          onAgentEvent: vi.fn(() => () => {}),
        }),
      });
      initSubagentRegistry();
      // SAFETY: running-launch restore terminalizes before reading Gateway runtime capabilities.
      activateSubagentRegistry(() => ({}) as never);

      await expect(
        waitForCollectorCompletion({
          runId,
          currentSessionKeys: new Set(["agent:main:main"]),
          currentAgentId: "main",
        }),
      ).resolves.toMatchObject({
        runId,
        status: "failed",
        error: "Gateway restarted while the provider execution was running",
      });
      expect(getSubagentRunByRunId(runId)).toMatchObject({
        runId,
        collectorCompletion: { status: "failed" },
        launch: {
          phase: "terminal",
          terminalReason: "interrupted",
        },
      });
      expect(findTaskByRunId(runId)).toMatchObject({
        runId,
        status: "failed",
        error: "Gateway restarted while the provider execution was running",
      });
      expect(onProviderRunning).toHaveBeenCalledOnce();
      expect(callGateway).not.toHaveBeenCalled();
      expect(live.writes).toHaveLength(1);
    });
  });
});
