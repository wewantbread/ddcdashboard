import { vi } from "vitest";
import type { SubagentRunRecord } from "../registry/subagent-registry.types.js";
import type { SubagentAnnounceDeliveryResult } from "./subagent-announce-dispatch.js";
import type { RequesterSettleWakeBatchState } from "./subagent-announce.requester-settle-wake.js";

export const REQUESTER = "agent:main:main";

export const requesterSettleKey = (suffix: string) =>
  `announce:requester-settle:main:${REQUESTER}:${suffix}`;

type SettledChildOverrides = Omit<Partial<SubagentRunRecord>, "execution"> & {
  startedAt?: number;
  endedAt?: number;
  outcome?: SubagentRunRecord["execution"]["outcome"];
  execution?: SubagentRunRecord["execution"];
};

export function makeSettledChild(overrides: SettledChildOverrides): SubagentRunRecord {
  const runId = overrides.runId ?? "run-child";
  const { startedAt = 2_000, endedAt = 3_000, outcome, execution, ...recordOverrides } = overrides;
  return {
    runId,
    childSessionKey: overrides.childSessionKey ?? `agent:main:subagent:${runId}`,
    requesterSessionKey: REQUESTER,
    requesterDisplayKey: "main",
    task: "investigate",
    cleanup: "keep",
    createdAt: 1_000,
    execution: execution ?? { status: "terminal", startedAt, endedAt, outcome },
    expectsCompletionMessage: true,
    delivery: { status: "delivered" },
    requesterSettleWake: { status: "pending", attemptCount: 0 },
    ...recordOverrides,
  };
}

export function createRequesterSettleWakeBatchHarness(listRuns: () => SubagentRunRecord[]): {
  transitionBatchSpy: ReturnType<typeof vi.fn>;
  completeBatchSpy: ReturnType<typeof vi.fn>;
  transitionBatch: (runIds: readonly string[], state: RequesterSettleWakeBatchState) => void;
  completeBatch: (
    runIds: readonly string[],
    rearmGeneration?: number,
    outcome?: SubagentAnnounceDeliveryResult,
  ) => void;
} {
  const transitionBatchSpy = vi.fn();
  const completeBatchSpy = vi.fn();

  const transitionBatch = (
    runIds: readonly string[],
    state: RequesterSettleWakeBatchState,
  ): void => {
    transitionBatchSpy(runIds, state);
    const selected = new Set(runIds);
    for (const entry of listRuns()) {
      if (selected.has(entry.runId) && entry.requesterSettleWake) {
        entry.requesterSettleWake = {
          ...state,
          ...(entry.requesterSettleWake.retireAfterSettle ? { retireAfterSettle: true } : {}),
        };
      }
    }
  };

  const completeBatch = (
    runIds: readonly string[],
    rearmGeneration?: number,
    outcome?: SubagentAnnounceDeliveryResult,
  ): void => {
    if (outcome) {
      completeBatchSpy(runIds, rearmGeneration, outcome);
    } else if (rearmGeneration === undefined) {
      completeBatchSpy(runIds);
    } else {
      completeBatchSpy(runIds, rearmGeneration);
    }
    const selected = new Set(runIds);
    for (const entry of listRuns()) {
      if (
        selected.has(entry.runId) &&
        entry.requesterSettleWake?.rearmGeneration === rearmGeneration
      ) {
        entry.requesterSettleWake = undefined;
      }
    }
  };

  return { transitionBatchSpy, completeBatchSpy, transitionBatch, completeBatch };
}
