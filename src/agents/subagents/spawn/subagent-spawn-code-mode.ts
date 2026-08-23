import { getDetachedTaskLifecycleRuntimeRegistration } from "../../../tasks/detached-task-runtime-state.js";
import { createQueuedTaskRun } from "../../../tasks/detached-task-runtime.js";
import { publishTaskRecordAfterAtomicStore } from "../../../tasks/task-registry.js";
import type { TaskDeliveryState, TaskRecord } from "../../../tasks/task-registry.types.js";
import type { RegisterSubagentRunParams } from "../registry/subagent-registry-run-launch.js";
import {
  prepareSubagentRunForAtomicStore,
  publishSubagentRunAfterAtomicStore,
  settleFailedQueuedSubagentLaunch,
} from "../registry/subagent-registry.js";
import { prepareSubagentLaunchRecord } from "../registry/subagent-registry.store.sqlite.js";
import { readSwarmCodeModeLaunchAuthority } from "../swarm/swarm-code-mode.js";

export function createCodeModeSpawnControl(value: object) {
  const authority = readSwarmCodeModeLaunchAuthority(value);
  return {
    authority,
    plannedSessionIdentity: authority?.reserved.launch
      ? {
          sessionId: authority.reserved.launch.childSessionId,
          lifecycleRevision: authority.reserved.launch.childLifecycleRevision,
        }
      : undefined,
    register: authority
      ? (registration: RegisterSubagentRunParams) => {
          const prepared = prepareSubagentRunForAtomicStore(
            registration,
            authority.reserved.createdAt,
          );
          if (!prepared || !authority.reserved.launch) {
            throw new Error("Code Mode launch preparation was unavailable");
          }
          const preparedAt = Date.now();
          const entry = {
            ...prepared.entry,
            launch: {
              ...authority.reserved.launch,
              phase: "prepared" as const,
              revision: authority.reserved.launch.revision + 1,
              preparedAt,
            },
          };
          const customRuntime = getDetachedTaskLifecycleRuntimeRegistration();
          let task: TaskRecord | undefined;
          let taskDelivery: TaskDeliveryState | undefined;
          if (!customRuntime) {
            task = {
              taskId: `task_${entry.runId}`,
              runtime: "subagent",
              sourceId: entry.runId,
              requesterSessionKey: entry.requesterSessionKey,
              ownerKey: entry.requesterSessionKey,
              scopeKind: "session",
              childSessionKey: entry.childSessionKey,
              agentId: registration.agentId,
              requesterAgentId: entry.requesterAgentId,
              runId: entry.runId,
              label: entry.label,
              task: entry.task,
              status: "queued",
              deliveryStatus:
                entry.expectsCompletionMessage === false ? "not_applicable" : "pending",
              notifyPolicy: entry.expectsCompletionMessage === false ? "silent" : "done_only",
              createdAt: entry.createdAt,
              lastEventAt: entry.createdAt,
            };
            taskDelivery = entry.requesterOrigin
              ? { taskId: task.taskId, requesterOrigin: entry.requesterOrigin }
              : undefined;
          }
          const stored = prepareSubagentLaunchRecord({
            expected: authority.reserved,
            prepared: entry,
            task,
            taskDelivery,
          });
          if (task) {
            publishTaskRecordAfterAtomicStore(task, taskDelivery);
          }
          publishSubagentRunAfterAtomicStore(stored, registration.gatewayContextResolver);
          if (!task) {
            let reconciliationError: unknown;
            let created: TaskRecord | null | undefined;
            try {
              created = createQueuedTaskRun(prepared.taskParams);
            } catch (error) {
              reconciliationError = error;
            }
            if (!created && registration.taskRowOwnership === "required") {
              reconciliationError ??= new Error(
                `detached task runtime created no task row for run ${entry.runId}`,
              );
            }
            if (reconciliationError) {
              settleFailedQueuedSubagentLaunch(
                entry.runId,
                `detached task runtime reconciliation failed: ${
                  reconciliationError instanceof Error
                    ? reconciliationError.message
                    : String(reconciliationError)
                }`,
              );
              throw reconciliationError;
            }
          }
        }
      : undefined,
  };
}
