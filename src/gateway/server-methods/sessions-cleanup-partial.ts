// Partial-failure response handling for the sessions.cleanup Gateway handler.
// Split from sessions-read.ts to keep that module under the oxlint max-lines budget.

import {
  buildSessionsCleanupPartialResult,
  SessionsCleanupPartialError,
} from "../../config/sessions.js";
import { ErrorCodes, errorShape } from "../../packages/gateway-protocol/src/index.js";
import { emitSessionsChanged } from "./session-change-event.js";
import type { GatewayRequestHandlers } from "./types.js";

type SessionsCleanupHandlerRespond = Parameters<
  GatewayRequestHandlers["sessions.cleanup"]
>[0]["respond"];

/** Responds ok:false with the typed partial result and emits sessions.changed for committed stores. */
export function respondSessionsCleanupPartialFailure(opts: {
  error: SessionsCleanupPartialError;
  context: Parameters<typeof emitSessionsChanged>[0];
  respond: SessionsCleanupHandlerRespond;
}): void {
  opts.respond(
    false,
    undefined,
    errorShape(ErrorCodes.INVALID_REQUEST, opts.error.message, {
      details: buildSessionsCleanupPartialResult(opts.error),
    }),
  );
  for (const _ of opts.error.appliedSummaries) {
    emitSessionsChanged(opts.context, { reason: "cleanup", sessionKey: undefined });
  }
  if (opts.error.lifecycleCommitted) {
    emitSessionsChanged(opts.context, { reason: "cleanup", sessionKey: undefined });
  }
}
