# Program Manager handoff and telemetry contract

## Handoff packets only

Program Manager requests help with a structured handoff packet, never by
indirect execution or an unbounded session message. A packet contains:

- target agent
- trigger condition
- input sent
- output expected
- owner
- approval requirement
- failure mode
- fix for failure mode

Supported targets are Control Director, Strategic Director, Judge, Automation &
Playbook Architect, Memory & Knowledge Curator, Browser / Session / Credential
Steward, and Telemetry & Evaluation Analyst.

## Runtime emission status

The runtime helper `emitProgramManagerTelemetryEvent` emits the
`program_manager_telemetry` stream through the shared agent event bus. Events
are non-secret and contain no credentials, no cookies, no tokens, and no raw
private notes. Secret-like keys are rejected instead of redacted silently.

Supported event names are:

- `program_manager.plan.created`
- `program_manager.status.reported`
- `program_manager.milestone.updated`
- `program_manager.task.updated`
- `program_manager.blocker.raised`
- `program_manager.dependency.added`
- `program_manager.handoff.requested`
- `program_manager.approval_gate.added`
- `program_manager.verification.required`
- `program_manager.completion_claim.review_required`
- `program_manager.unknown.recorded`

Telemetry is operational metadata only. It must not contain credentials, cookies,
tokens, raw private notes, or browser/session data.
