import { emitAgentEvent, type AgentEventPayload } from "../../infra/agent-events.js";

export const PROGRAM_MANAGER_TELEMETRY_STREAM = "program_manager_telemetry" as const;

export const PROGRAM_MANAGER_TELEMETRY_EVENT_NAMES = [
  "program_manager.plan.created",
  "program_manager.status.reported",
  "program_manager.milestone.updated",
  "program_manager.task.updated",
  "program_manager.blocker.raised",
  "program_manager.dependency.added",
  "program_manager.handoff.requested",
  "program_manager.approval_gate.added",
  "program_manager.verification.required",
  "program_manager.completion_claim.review_required",
  "program_manager.unknown.recorded",
] as const;

export type ProgramManagerTelemetryEventName =
  (typeof PROGRAM_MANAGER_TELEMETRY_EVENT_NAMES)[number];

type TelemetryValue =
  | string
  | number
  | boolean
  | null
  | TelemetryValue[]
  | {
      [key: string]: TelemetryValue;
    };

export type ProgramManagerTelemetryEvent = {
  agentId: "program-manager";
  runId: string;
  eventName: ProgramManagerTelemetryEventName;
  timestamp: string;
  data?: Record<string, TelemetryValue>;
};

const FORBIDDEN_KEY_PARTS = [
  "password",
  "token",
  "cookie",
  "secret",
  "privatekey",
  "apikey",
  "credential",
  "rawprivatenote",
  "browsersession",
  "sessioncookie",
  "sessionkey",
  "browser",
] as const;

function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function containsForbiddenKey(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(containsForbiddenKey);
  }
  if (!value || typeof value !== "object") {
    return false;
  }
  return Object.entries(value).some(
    ([key, nested]) =>
      FORBIDDEN_KEY_PARTS.some((part) => normalizeKey(key).includes(part)) ||
      containsForbiddenKey(nested),
  );
}

function isTelemetryValue(value: unknown): value is TelemetryValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every(isTelemetryValue);
  }
  return typeof value === "object" && Object.values(value).every(isTelemetryValue);
}

export function validateProgramManagerTelemetryEvent(
  event: unknown,
): { ok: true } | { ok: false; issues: string[] } {
  const issues: string[] = [];
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return { ok: false, issues: ["event must be an object"] };
  }
  const candidate = event as Record<string, unknown>;
  if (candidate.agentId !== "program-manager") {
    issues.push("agentId must be program-manager");
  }
  if (typeof candidate.runId !== "string" || candidate.runId.trim() === "") {
    issues.push("runId must be a non-empty string");
  }
  if (
    typeof candidate.eventName !== "string" ||
    !PROGRAM_MANAGER_TELEMETRY_EVENT_NAMES.includes(
      candidate.eventName as ProgramManagerTelemetryEventName,
    )
  ) {
    issues.push("eventName is not supported");
  }
  if (
    typeof candidate.timestamp !== "string" ||
    candidate.timestamp.trim() === "" ||
    Number.isNaN(Date.parse(candidate.timestamp))
  ) {
    issues.push("timestamp must be an ISO date string");
  }
  if (candidate.data !== undefined && !isTelemetryValue(candidate.data)) {
    issues.push("data must contain only JSON telemetry values");
  }
  if (containsForbiddenKey(candidate)) {
    issues.push("secret-like telemetry keys are not allowed");
  }
  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}

export function createProgramManagerTelemetryEvent(input: {
  runId: string;
  eventName: ProgramManagerTelemetryEventName;
  data?: Record<string, TelemetryValue>;
  timestamp?: string;
}): ProgramManagerTelemetryEvent {
  const event: ProgramManagerTelemetryEvent = {
    agentId: "program-manager",
    runId: input.runId,
    eventName: input.eventName,
    timestamp: input.timestamp ?? new Date().toISOString(),
    ...(input.data ? { data: input.data } : {}),
  };
  const validation = validateProgramManagerTelemetryEvent(event);
  if (!validation.ok) {
    throw new Error(`Invalid Program Manager telemetry event: ${validation.issues.join("; ")}`);
  }
  return event;
}

export function emitProgramManagerTelemetryEvent(input: {
  runId: string;
  eventName: ProgramManagerTelemetryEventName;
  data?: Record<string, TelemetryValue>;
  timestamp?: string;
}): ProgramManagerTelemetryEvent {
  const event = createProgramManagerTelemetryEvent(input);
  const { runId, ...data } = event;
  emitAgentEvent({ runId, stream: PROGRAM_MANAGER_TELEMETRY_STREAM, data });
  return event;
}

export type ProgramManagerTelemetryAgentEvent = Omit<AgentEventPayload, "seq" | "ts"> & {
  stream: typeof PROGRAM_MANAGER_TELEMETRY_STREAM;
};
