import { asNonArrayRecord, isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { ocPathSegment } from "./policy-state-helpers.js";

export type PolicyAgentRosterEntry = {
  readonly agentId: string;
  readonly sourceBase: string;
  readonly value: unknown;
};

/** Keep Policy evidence scanners aligned with the runtime agent-container precedence. */
export function collectPolicyAgentRoster(
  cfg: Record<string, unknown>,
): readonly PolicyAgentRosterEntry[] {
  const agents = asNonArrayRecord(cfg.agents);
  const entries = isRecord(agents.entries)
    ? Object.entries(agents.entries).map(([agentId, value]) => ({
        agentId,
        sourceBase: `oc://openclaw.config/agents/entries/${ocPathSegment(agentId)}`,
        value,
      }))
    : [];
  if (entries.length > 0) {
    return entries;
  }

  return Array.isArray(agents.list)
    ? agents.list.flatMap((value, index) => {
        if (!isRecord(value)) {
          return [];
        }
        const agentId =
          typeof value.id === "string" && value.id.trim() !== ""
            ? value.id.trim()
            : `agent-${index}`;
        return [
          {
            agentId,
            sourceBase: `oc://openclaw.config/agents/list/#${index}`,
            value,
          },
        ];
      })
    : [];
}
