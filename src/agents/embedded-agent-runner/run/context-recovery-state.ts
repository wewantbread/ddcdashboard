import {
  restoreEmbeddedRunTimeoutAbandonment,
  type EmbeddedRunTimeoutRecoveryMarker,
} from "../runs.js";
import type { EmbeddedAgentMeta } from "../types.js";

export function createEmbeddedRunContextRecoveryState() {
  let timeoutRecoveryMarker: EmbeddedRunTimeoutRecoveryMarker | undefined;
  return {
    autoCompactionCount: 0,
    lastCompactionTokensAfter: undefined as number | undefined,
    lastContextBudgetStatus: undefined as EmbeddedAgentMeta["contextBudgetStatus"],
    overflowCompactionAttempts: 0,
    timeoutCompactionAttempts: 0,
    toolResultTruncationAttempted: false,
    transportDropContinuations: 0,
    retainTimeoutRecoveryMarker(marker: EmbeddedRunTimeoutRecoveryMarker) {
      timeoutRecoveryMarker = marker;
    },
    restoreTimeoutRecoveryAbandonment() {
      return timeoutRecoveryMarker
        ? restoreEmbeddedRunTimeoutAbandonment(timeoutRecoveryMarker)
        : false;
    },
  };
}

export type EmbeddedRunContextRecoveryState = ReturnType<
  typeof createEmbeddedRunContextRecoveryState
>;
