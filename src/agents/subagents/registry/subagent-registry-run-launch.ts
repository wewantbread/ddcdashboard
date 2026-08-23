import { isDeepStrictEqual } from "node:util";
import type { GatewayContextResolver } from "../../../gateway/server-methods/types.js";
/** Owns subagent registration and queued collector launch transitions. */
import { getAgentEventLifecycleGeneration } from "../../../infra/agent-events.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { bindGatewayContextResolver } from "../../../plugins/runtime/gateway-request-scope.js";
import {
  createQueuedTaskRun,
  createRunningTaskRun,
  finalizeTaskRunByRunId,
  startTaskRunByRunId,
} from "../../../tasks/detached-task-runtime.js";
import { publishTaskRecordAfterAtomicStore } from "../../../tasks/task-registry.js";
import { normalizeDeliveryContext } from "../../../utils/delivery-context.shared.js";
import type { DeliveryContext } from "../../../utils/delivery-context.types.js";
import { resolveSubagentRequesterAgentId } from "../../subagent-requester-owner.js";
import { updateSwarmCollectorCompletion } from "../swarm/swarm-collector.js";
import { normalizeSubagentRunState } from "./subagent-delivery-state.js";
import { SUBAGENT_ENDED_REASON_ERROR } from "./subagent-lifecycle-events.js";
import { SubagentRecoveryManager } from "./subagent-registry-run-recovery.js";
import { publishPersistedSubagentRunsSnapshot } from "./subagent-registry-state.js";
import {
  transitionDispatchingSubagentLaunchToRunning,
  transitionPreparedSubagentLaunchToDispatching,
  transitionSubagentLaunchToTerminal,
} from "./subagent-registry.store.sqlite.js";
import type {
  SubagentProgressOrigin,
  SubagentLaunchState,
  SubagentRunRecord,
  SwarmQueuedLaunch,
} from "./subagent-registry.types.js";
import {
  compareSubagentRunGeneration,
  nextSubagentRunGeneration,
} from "./subagent-run-generation.js";

const log = createSubsystemLogger("agents/subagent-registry");

function resolveSwarmWaitOwnerSessionKeys(
  getRunsForChildSession: (childSessionKey: string) => Iterable<SubagentRunRecord>,
  requesterSessionKey: string,
): string[] {
  const ownerSessionKeys: string[] = [];
  const visited = new Set<string>();
  let currentSessionKey = requesterSessionKey.trim();
  while (currentSessionKey && !visited.has(currentSessionKey)) {
    visited.add(currentSessionKey);
    ownerSessionKeys.push(currentSessionKey);
    let latestOwner: SubagentRunRecord | undefined;
    for (const candidate of getRunsForChildSession(currentSessionKey)) {
      if (!latestOwner || compareSubagentRunGeneration(candidate, latestOwner) > 0) {
        latestOwner = candidate;
      }
    }
    currentSessionKey =
      latestOwner?.controllerSessionKey?.trim() || latestOwner?.requesterSessionKey.trim() || "";
  }
  return ownerSessionKeys;
}

export type RegisterSubagentRunParams = {
  runId: string;
  requesterTurnRunId?: string;
  childSessionKey: string;
  controllerSessionKey?: string;
  requesterSessionKey: string;
  requesterOrigin?: DeliveryContext;
  progressOrigin?: SubagentProgressOrigin;
  requesterDisplayKey: string;
  task: string;
  taskName?: string;
  agentId?: string;
  requesterAgentId?: string;
  cleanup: "delete" | "keep";
  label?: string;
  model?: string;
  agentDir?: string;
  workspaceDir?: string;
  runTimeoutSeconds?: number;
  expectsCompletionMessage?: boolean;
  spawnMode?: "run" | "session";
  attachmentsDir?: string;
  attachmentsRootDir?: string;
  retainAttachmentsOnKeep?: boolean;
  collect?: boolean;
  swarmRequesterSessionKey?: string;
  groupId?: string;
  outputSchema?: Record<string, unknown>;
  queuedLaunch?: SwarmQueuedLaunch;
  launch?: SubagentLaunchState;
  queued?: boolean;
  /** Required when direct dispatch suppresses Gateway tracking. Out-of-process launches keep
      Gateway's existing best-effort CLI policy; other callers create a best-effort row here. */
  taskRowOwnership?: "required" | "gateway_best_effort";
  gatewayContextResolver?: GatewayContextResolver;
};

export class SubagentLaunchManager extends SubagentRecoveryManager {
  private findRunByIdentity(runId: string): SubagentRunRecord | undefined {
    return (
      this.options.runs.get(runId) ??
      [...this.options.runs.values()].find((candidate) => candidate.swarmRunId === runId)
    );
  }

  readonly prepareSubagentRunForAtomicStore = (
    registerParams: RegisterSubagentRunParams,
    createdAt = Date.now(),
  ) => {
    const runId = registerParams.runId.trim();
    const childSessionKey = registerParams.childSessionKey.trim();
    const requesterSessionKey = registerParams.requesterSessionKey.trim();
    const requesterTurnRunId = registerParams.requesterTurnRunId?.trim();
    const controllerSessionKey = registerParams.controllerSessionKey?.trim() || requesterSessionKey;
    if (!runId || !childSessionKey || !requesterSessionKey) {
      return undefined;
    }
    const generation = nextSubagentRunGeneration(
      this.options.getRunsForChildSession(childSessionKey),
      childSessionKey,
    );
    const cfg = this.options.getRuntimeConfig();
    const spawnMode = registerParams.spawnMode === "session" ? "session" : "run";
    const runTimeoutSeconds = registerParams.runTimeoutSeconds ?? 0;
    const waitTimeoutMs = this.options.resolveSubagentWaitTimeoutMs(cfg, runTimeoutSeconds);
    const requesterOrigin = normalizeDeliveryContext(registerParams.requesterOrigin);
    const queued = registerParams.queued === true;
    const entry: SubagentRunRecord = normalizeSubagentRunState({
      runId,
      taskRunId: runId,
      ...(requesterTurnRunId && registerParams.expectsCompletionMessage === true
        ? { requesterTurnRunId }
        : {}),
      childSessionKey,
      controllerSessionKey,
      requesterSessionKey,
      requesterOrigin,
      progressOrigin: registerParams.progressOrigin,
      requesterDisplayKey: registerParams.requesterDisplayKey,
      requesterAgentId: resolveSubagentRequesterAgentId(cfg, registerParams),
      task: registerParams.task,
      taskName: registerParams.taskName,
      cleanup: registerParams.cleanup,
      expectsCompletionMessage: registerParams.expectsCompletionMessage,
      spawnMode,
      label: registerParams.label,
      model: registerParams.model,
      agentDir: registerParams.agentDir,
      workspaceDir: registerParams.workspaceDir,
      runTimeoutSeconds,
      collect: registerParams.collect,
      swarmRequesterSessionKey: registerParams.swarmRequesterSessionKey,
      swarmWaitOwnerSessionKeys:
        registerParams.collect && registerParams.swarmRequesterSessionKey
          ? resolveSwarmWaitOwnerSessionKeys(
              this.options.getRunsForChildSession,
              registerParams.swarmRequesterSessionKey,
            )
          : undefined,
      swarmRunId: registerParams.collect ? runId : undefined,
      schedulerSlotId: registerParams.collect ? runId : undefined,
      groupId: registerParams.groupId,
      outputSchema: registerParams.outputSchema,
      queuedLaunch: registerParams.queuedLaunch,
      launch: registerParams.launch,
      generation,
      createdAt,
      execution: {
        status: queued ? "queued" : "running",
        startedAt: queued ? undefined : createdAt,
        lifecycleGeneration: getAgentEventLifecycleGeneration(),
      },
      completion: {
        required: registerParams.expectsCompletionMessage === true,
      },
      delivery: {
        status: registerParams.expectsCompletionMessage === false ? "not_required" : "pending",
      },
      sessionStartedAt: queued ? undefined : createdAt,
      accumulatedRuntimeMs: 0,
      cleanupHandled: false,
      wakeOnDescendantSettle: undefined,
      requesterSettleWake: undefined,
      attachmentsDir: registerParams.attachmentsDir,
      attachmentsRootDir: registerParams.attachmentsRootDir,
      retainAttachmentsOnKeep: registerParams.retainAttachmentsOnKeep,
    });
    const taskParams = {
      runtime: "subagent",
      sourceId: runId,
      ownerKey: requesterSessionKey,
      scopeKind: "session",
      requesterOrigin: requesterOrigin ? structuredClone(requesterOrigin) : undefined,
      childSessionKey,
      runId,
      label: registerParams.label,
      task: registerParams.task,
      agentId: registerParams.agentId,
      requesterAgentId: resolveSubagentRequesterAgentId(cfg, registerParams),
      deliveryStatus:
        registerParams.expectsCompletionMessage === false ? "not_applicable" : "pending",
    } as const;
    return { cfg, entry, queued, requesterOrigin, taskParams, waitTimeoutMs };
  };

  readonly publishSubagentRunAfterAtomicStore = (
    entry: SubagentRunRecord,
    gatewayContextResolver?: GatewayContextResolver,
  ): SubagentRunRecord => {
    const current = this.options.runs.get(entry.runId);
    if (current && current.launch?.phase !== "reserved" && !isDeepStrictEqual(current, entry)) {
      throw new Error(`atomic subagent publication conflicts with live run ${entry.runId}`);
    }
    this.options.runs.set(entry.runId, entry);
    bindGatewayContextResolver(entry, gatewayContextResolver);
    publishPersistedSubagentRunsSnapshot(this.options.runs, [entry.runId]);
    this.options.ensureListener();
    this.options.startSweeper();
    return entry;
  };

  readonly transitionPreparedSubagentLaunchToDispatching = (
    runId: string,
    executionAttemptId: string,
    gatewayContextResolver?: GatewayContextResolver,
  ): boolean => {
    const prepared = this.options.runs.get(runId);
    const dispatching = transitionPreparedSubagentLaunchToDispatching({
      runId,
      executionAttemptId,
      dispatchingAt: Date.now(),
    });
    if (!dispatching) {
      return false;
    }
    this.options.runs.set(dispatching.runId, dispatching);
    bindGatewayContextResolver(dispatching, gatewayContextResolver);
    publishPersistedSubagentRunsSnapshot(this.options.runs, [dispatching.runId]);
    try {
      startTaskRunByRunId({
        runId: dispatching.taskRunId ?? dispatching.runId,
        runtime: "subagent",
        sessionKey: dispatching.childSessionKey,
        startedAt: dispatching.launch.dispatchingAt,
        lastEventAt: dispatching.launch.dispatchingAt,
      });
    } catch (error) {
      if (prepared?.launch?.phase === "prepared") {
        const message = `detached task runtime start failed: ${
          error instanceof Error ? error.message : String(error)
        }`;
        const endedAt = Date.now();
        const committed = transitionSubagentLaunchToTerminal({
          runId: prepared.runId,
          terminalAt: endedAt,
          terminalReason: "failed",
          error: message,
        });
        if (committed) {
          const terminal = committed.entry;
          this.options.runs.set(terminal.runId, terminal);
          publishPersistedSubagentRunsSnapshot(this.options.runs, [terminal.runId]);
          for (const task of committed.tasks) {
            publishTaskRecordAfterAtomicStore(task);
          }
          if (committed.tasks.length === 0) {
            finalizeTaskRunByRunId({
              runId: terminal.taskRunId ?? terminal.runId,
              runtime: "subagent",
              sessionKey: terminal.childSessionKey,
              status: "failed",
              endedAt,
              lastEventAt: endedAt,
              error: message,
              suppressDelivery: true,
            });
          }
        }
      }
      throw error;
    }
    return true;
  };

  readonly transitionDispatchingSubagentLaunchToRunning = (runId: string): boolean => {
    const running = transitionDispatchingSubagentLaunchToRunning({
      runId,
      runningAt: Date.now(),
    });
    if (!running) {
      return false;
    }
    this.options.runs.set(running.runId, running);
    publishPersistedSubagentRunsSnapshot(this.options.runs, [running.runId]);
    return true;
  };

  readonly registerSubagentRun = (registerParams: RegisterSubagentRunParams): void => {
    const prepared = this.prepareSubagentRunForAtomicStore(registerParams);
    if (!prepared) {
      return;
    }
    const { entry, queued, taskParams, waitTimeoutMs } = prepared;
    const { runId } = entry;
    this.options.runs.set(runId, entry);
    bindGatewayContextResolver(entry, registerParams.gatewayContextResolver);
    const killReconciliationSnapshots = this.markOlderKillReconciliationsSuperseded(entry);
    const registeredKillReconciliationSnapshots = new Map(
      [...killReconciliationSnapshots.keys()].map((candidate) => [
        candidate,
        structuredClone(candidate.killReconciliation),
      ]),
    );
    const registeredRunIds = [
      runId,
      ...[...killReconciliationSnapshots.keys()].map((candidate) => candidate.runId),
    ];
    const rollbackRegistration = () => {
      this.options.runs.delete(runId);
      this.restoreKillReconciliationSnapshots(killReconciliationSnapshots);
    };
    const restoreDurableRegistration = () => {
      this.options.runs.set(runId, entry);
      this.restoreKillReconciliationSnapshots(registeredKillReconciliationSnapshots);
    };
    const activateRegistrationLifecycle = () => {
      this.options.ensureListener();
      // Session-mode and persistence-recovery runs also need TTL cleanup.
      this.options.startSweeper();
      if (!queued) {
        void this.waitForSubagentCompletion(runId, waitTimeoutMs, entry);
      }
    };
    try {
      this.options.persistOrThrow(...registeredRunIds);
    } catch (error) {
      rollbackRegistration();
      throw error;
    }
    if (registerParams.taskRowOwnership !== "gateway_best_effort") {
      try {
        const task = queued
          ? createQueuedTaskRun(taskParams)
          : createRunningTaskRun({
              ...taskParams,
              startedAt: entry.createdAt,
              lastEventAt: entry.createdAt,
            });
        if (!task) {
          if (registerParams.taskRowOwnership === "required") {
            throw new Error(`detached task runtime created no task row for run ${runId}`);
          }
          log.warn("Failed to persist background task for subagent run", { runId });
        }
      } catch (error) {
        if (registerParams.taskRowOwnership !== "required") {
          log.warn("Failed to create background task for subagent run", { runId, error });
        } else {
          // Direct dispatch suppressed Gateway's CLI fallback. Persist the rollback before
          // asking the caller to abort; if that write fails, memory must match durable state.
          rollbackRegistration();
          try {
            this.options.persistOrThrow(...registeredRunIds);
          } catch (rollbackError) {
            restoreDurableRegistration();
            // Durable state still owns this registration. Keep reconciliation active so
            // caller cleanup can terminalize it instead of leaving a phantom run.
            activateRegistrationLifecycle();
            throw rollbackError;
          }
          throw error;
        }
      }
    }
    // Wait through Gateway RPC; the in-process lifecycle listener is the embedded fallback.
    activateRegistrationLifecycle();
  };

  readonly failQueuedSubagentRun = (runId: string, error: string): boolean => {
    const key = runId.trim();
    const entry = this.findRunByIdentity(key);
    if (!entry || entry.execution.status !== "queued") {
      return false;
    }
    const snapshot = structuredClone(entry);
    const endedAt = Date.now();
    let taskSettledAtomically = false;
    entry.endedReason = SUBAGENT_ENDED_REASON_ERROR;
    entry.execution = {
      ...entry.execution,
      status: "terminal",
      endedAt,
      outcome: { status: "error", error, endedAt },
    };
    if (entry.launch && entry.launch.phase !== "terminal") {
      const committed = transitionSubagentLaunchToTerminal({
        runId: entry.runId,
        terminalAt: endedAt,
        terminalReason: "failed",
        error,
      });
      if (committed) {
        Object.assign(entry, committed.entry);
        taskSettledAtomically = committed.tasks.length > 0;
        for (const task of committed.tasks) {
          publishTaskRecordAfterAtomicStore(task);
        }
      }
    }
    entry.queuedLaunch = undefined;
    entry.collectorLaunchCleanupPending = true;
    entry.completion = { required: false, resultText: error, capturedAt: endedAt };
    updateSwarmCollectorCompletion(entry, this.options.getRuntimeConfig());
    try {
      this.options.persistOrThrow(entry.runId);
    } catch (persistError) {
      this.restoreRunRecord(entry, snapshot);
      throw persistError;
    }
    if (!taskSettledAtomically) {
      try {
        finalizeTaskRunByRunId({
          runId: entry.taskRunId ?? entry.runId,
          runtime: "subagent",
          sessionKey: entry.childSessionKey,
          status: "failed",
          endedAt,
          lastEventAt: endedAt,
          error,
          suppressDelivery: true,
        });
      } catch (taskError) {
        // Collector failure is already durable. Detached-task cleanup cannot
        // turn it back into queued work or the scheduler could launch it twice.
        log.warn("failed to finalize task after collector launch failure", {
          runId: entry.runId,
          error: taskError,
        });
      }
    }
    return true;
  };

  readonly settleFailedQueuedSubagentLaunch = (runId: string, error: string): boolean => {
    const entry = this.findRunByIdentity(runId);
    if (!entry?.collect) {
      return false;
    }
    if (typeof entry.execution.endedAt !== "number") {
      return this.failQueuedSubagentRun(runId, error);
    }
    if (entry.collectorCompletion) {
      return true;
    }
    const snapshot = structuredClone(entry);
    entry.collectorLaunchCleanupPending = true;
    entry.queuedLaunch = undefined;
    entry.execution = {
      ...entry.execution,
      status: "terminal",
      endedAt: entry.execution.endedAt,
    };
    if (entry.launch && entry.launch.phase !== "terminal") {
      const committed = transitionSubagentLaunchToTerminal({
        runId: entry.runId,
        terminalAt: entry.execution.endedAt,
        terminalReason: entry.launch.phase === "dispatching" ? "lost" : "failed",
        error:
          entry.launch.phase === "dispatching"
            ? `${error}; execution may have reached the provider and will not be retried`
            : error,
      });
      if (committed) {
        Object.assign(entry, committed.entry);
        for (const task of committed.tasks) {
          publishTaskRecordAfterAtomicStore(task);
        }
      }
    }
    entry.completion = {
      required: false,
      resultText:
        entry.execution.outcome?.status === "error"
          ? (entry.execution.outcome.error ?? error)
          : error,
      capturedAt: entry.execution.endedAt,
    };
    updateSwarmCollectorCompletion(entry, this.options.getRuntimeConfig());
    try {
      this.options.persistOrThrow(entry.runId);
    } catch (persistError) {
      this.restoreRunRecord(entry, snapshot);
      throw persistError;
    }
    return true;
  };
}
