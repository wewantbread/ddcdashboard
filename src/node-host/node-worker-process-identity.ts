import { getFileLockProcessStartTime, isPidDefinitelyDead } from "../shared/pid-alive.js";

// Worker startup and supervision checks are not on a timer, so this keeps the
// Windows reader's full 5s-per-attempt tolerance. Stated explicitly rather than
// inherited so that tightening the shared default cannot silently shorten it and
// fail worker startup closed on a slow host.
const WORKER_IDENTITY_PROBE_TIMEOUT_MS = 5000;

export type NodeWorkerProcessIdentity = {
  pid: number;
  startTime: number;
};

type NodeWorkerProcessIdentityState = "live" | "dead" | "reused" | "unknown";

export function requireNodeWorkerProcessIdentity(pid: number): NodeWorkerProcessIdentity {
  const startTime = getFileLockProcessStartTime(pid, WORKER_IDENTITY_PROBE_TIMEOUT_MS);
  if (startTime === null) {
    throw new Error(`cannot establish PID-reuse-safe identity for process ${pid}`);
  }
  return { pid, startTime };
}

export function inspectNodeWorkerProcessIdentity(
  identity: NodeWorkerProcessIdentity,
): NodeWorkerProcessIdentityState {
  const observedStartTime = getFileLockProcessStartTime(
    identity.pid,
    WORKER_IDENTITY_PROBE_TIMEOUT_MS,
  );
  if (observedStartTime !== null) {
    if (observedStartTime !== identity.startTime) {
      return "reused";
    }
    return isPidDefinitelyDead(identity.pid) ? "dead" : "live";
  }
  return isPidDefinitelyDead(identity.pid) ? "dead" : "unknown";
}
