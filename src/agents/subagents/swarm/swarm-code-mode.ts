/** Internal host-only metadata used to make Code Mode collector spawns replay-safe. */
import type { SubagentRunRecord } from "../registry/subagent-registry.types.js";

export const SWARM_CODE_MODE_IDEMPOTENCY_KEY = Symbol.for("openclaw.swarmCodeModeIdempotencyKey");

export const SWARM_CODE_MODE_REQUEST_FINGERPRINT = Symbol.for(
  "openclaw.swarmCodeModeRequestFingerprint",
);

export const SWARM_CODE_MODE_LAUNCH_AUTHORITY = Symbol.for("openclaw.swarmCodeModeLaunchAuthority");

export type SwarmCodeModeLaunchAuthority = {
  reserved: SubagentRunRecord;
};

export function readSwarmCodeModeLaunchAuthority(
  value: object,
): SwarmCodeModeLaunchAuthority | undefined {
  const authority = Reflect.get(value, SWARM_CODE_MODE_LAUNCH_AUTHORITY);
  if (
    !authority ||
    typeof authority !== "object" ||
    !("reserved" in authority) ||
    !authority.reserved
  ) {
    return undefined;
  }
  // SAFETY: the guarded host-only symbol is written only with this authority shape.
  return authority as SwarmCodeModeLaunchAuthority;
}
