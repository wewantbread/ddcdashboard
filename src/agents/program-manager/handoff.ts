export const PROGRAM_MANAGER_HANDOFF_TARGETS = [
  "Control Director",
  "Strategic Director",
  "Judge",
  "Automation & Playbook Architect",
  "Memory & Knowledge Curator",
  "Browser / Session / Credential Steward",
  "Telemetry & Evaluation Analyst",
] as const;

export type ProgramManagerHandoffTarget = (typeof PROGRAM_MANAGER_HANDOFF_TARGETS)[number];

export type ProgramManagerHandoffPacket = {
  targetAgent: ProgramManagerHandoffTarget;
  triggerCondition: string;
  inputSent: string;
  outputExpected: string;
  owner: string;
  approvalRequirement: string;
  failureMode: string;
  fixForFailureMode: string;
};

const HANDOFF_FIELDS = [
  "targetAgent",
  "triggerCondition",
  "inputSent",
  "outputExpected",
  "owner",
  "approvalRequirement",
  "failureMode",
  "fixForFailureMode",
] as const;

export function validateProgramManagerHandoffPacket(
  packet: unknown,
): { ok: true } | { ok: false; issues: string[] } {
  const issues: string[] = [];
  if (!packet || typeof packet !== "object" || Array.isArray(packet)) {
    return { ok: false, issues: ["handoff packet must be an object"] };
  }
  const candidate = packet as Record<string, unknown>;
  if (
    typeof candidate.targetAgent !== "string" ||
    !PROGRAM_MANAGER_HANDOFF_TARGETS.includes(candidate.targetAgent as ProgramManagerHandoffTarget)
  ) {
    issues.push("targetAgent is not an approved handoff target");
  }
  for (const field of HANDOFF_FIELDS.slice(1)) {
    if (typeof candidate[field] !== "string" || candidate[field].trim() === "") {
      issues.push(`${field} must be a non-empty string`);
    }
  }
  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}

export function createProgramManagerHandoffPacket(
  packet: ProgramManagerHandoffPacket,
): ProgramManagerHandoffPacket {
  const validation = validateProgramManagerHandoffPacket(packet);
  if (!validation.ok) {
    throw new Error(`Invalid Program Manager handoff packet: ${validation.issues.join("; ")}`);
  }
  return { ...packet };
}
