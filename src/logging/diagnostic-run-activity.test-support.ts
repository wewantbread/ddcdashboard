import type { DiagnosticEventPayload } from "../infra/diagnostic-events.js";
import "./diagnostic-run-activity.js";

type DiagnosticModelStartedActivityEvent = Pick<
  Extract<DiagnosticEventPayload, { type: "model.call.started" }>,
  "runId" | "sessionId" | "sessionKey" | "provider" | "model" | "observationUnit"
> & { seq?: number };

type DiagnosticRunProgressActivityEvent = Pick<
  Extract<DiagnosticEventPayload, { type: "run.progress" }>,
  "runId" | "sessionId" | "sessionKey" | "reason"
> & { progressKind?: "semantic" | "liveness" };

type DiagnosticToolStartedActivityEvent = {
  sessionId?: string;
  sessionKey?: string;
  runId?: string;
  toolName: string;
  toolCallId?: string;
};

type DiagnosticRunActivityTestApi = {
  applyRunProgress(params: DiagnosticRunProgressActivityEvent, semantic?: boolean): void;
  recordModelStarted(
    params: DiagnosticModelStartedActivityEvent,
    provenance: undefined,
    coreRequestForTest: boolean,
  ): void;
  recordToolStarted(params: DiagnosticToolStartedActivityEvent): void;
};

function getTestApi(): DiagnosticRunActivityTestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.diagnosticRunActivityTestApi")
  ] as DiagnosticRunActivityTestApi;
}

export function markDiagnosticModelStartedForTest(
  params: DiagnosticModelStartedActivityEvent,
): void {
  getTestApi().recordModelStarted(params, undefined, true);
}

export function markDiagnosticRunProgressForTest(params: DiagnosticRunProgressActivityEvent): void {
  getTestApi().applyRunProgress(params, params.progressKind === "semantic");
}

export function markDiagnosticToolStartedForTest(params: DiagnosticToolStartedActivityEvent): void {
  getTestApi().recordToolStarted(params);
}
