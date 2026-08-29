import { afterEach, describe, expect, it } from "vitest";
import { onAgentEvent, resetAgentEventsForTest } from "../../infra/agent-events.js";
import {
  createProgramManagerHandoffPacket,
  validateProgramManagerHandoffPacket,
} from "./handoff.js";
import {
  createProgramManagerTelemetryEvent,
  emitProgramManagerTelemetryEvent,
  validateProgramManagerTelemetryEvent,
} from "./telemetry.js";

describe("Program Manager MVP contracts", () => {
  afterEach(() => resetAgentEventsForTest());

  it("creates and emits a non-secret telemetry event on the dedicated stream", () => {
    const received: unknown[] = [];
    const unsubscribe = onAgentEvent((event) => received.push(event));
    const event = emitProgramManagerTelemetryEvent({
      runId: "run-1",
      eventName: "program_manager.status.reported",
      timestamp: "2026-08-11T20:00:00.000Z",
      data: { status: "UNKNOWN", blockerCount: 1 },
    });
    unsubscribe();

    expect(event.agentId).toBe("program-manager");
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      runId: "run-1",
      stream: "program_manager_telemetry",
      data: {
        agentId: "program-manager",
        eventName: "program_manager.status.reported",
      },
    });
    expect((received[0] as { sessionKey?: string }).sessionKey).toBeUndefined();
  });

  it("fails closed when telemetry contains secret-like keys", () => {
    const event = {
      agentId: "program-manager",
      runId: "run-1",
      eventName: "program_manager.plan.created",
      timestamp: "2026-08-11T20:00:00.000Z",
      data: { details: { apiKey: "must-not-appear" } },
    };

    expect(validateProgramManagerTelemetryEvent(event)).toEqual({
      ok: false,
      issues: ["secret-like telemetry keys are not allowed"],
    });
    expect(() =>
      createProgramManagerTelemetryEvent({
        runId: "run-1",
        eventName: "program_manager.plan.created",
        data: { token: "must-not-appear" },
      }),
    ).toThrow("secret-like telemetry keys are not allowed");
  });

  it("creates only approved structured handoff packets", () => {
    const packet = createProgramManagerHandoffPacket({
      targetAgent: "Judge",
      triggerCondition: "completion evidence is missing",
      inputSent: "current status and evidence labels",
      outputExpected: "truthfulness verdict",
      owner: "Program Manager",
      approvalRequirement: "Judge review before completion claim",
      failureMode: "review unavailable",
      fixForFailureMode: "mark status Unknown and retry later",
    });

    expect(packet.targetAgent).toBe("Judge");
    expect(validateProgramManagerHandoffPacket(packet)).toEqual({ ok: true });
    expect(() =>
      createProgramManagerHandoffPacket({
        ...packet,
        targetAgent: "Builder Agent" as never,
      }),
    ).toThrow("approved handoff target");
  });
});
