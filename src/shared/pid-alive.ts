// PID liveness helpers check whether process ids still refer to active processes.
import childProcess from "node:child_process";
import fsSync from "node:fs";
import { readWindowsProcessStartTimeSync } from "../infra/windows-port-pids.js";

const DARWIN_PS_TIMEOUT_MS = 1000;
// Matches the Windows reader's own default. A shorter budget is tempting since
// this is synchronous, but the first Get-CimInstance in a process pays
// PowerShell module load and measurably exceeds one second on a cold Windows
// runner, and Server 2025 has dropped the WMIC fallback that used to cover it.
// Timing out here yields no identity, which fails the caller closed — for cron
// that is the very "cannot acquire a durable fence" failure this helper exists
// to prevent. Callers that must bound the wait harder pass their own value.
const WINDOWS_PROBE_TIMEOUT_MS = 5000;
// Windows-only. Cron re-reads our own identity every tick and it cannot change
// while the process lives, but only the Windows probe is expensive enough to be
// worth caching: PowerShell costs hundreds of milliseconds against a procfs read
// or a `ps` call. Elsewhere a cache would trade an observably-unreadable
// identity — which gateway lock ownership depends on seeing — for nothing.
// Success only, so a cold-start timeout is not sticky; foreign PIDs are never
// cached because detecting reuse depends on observing them live.
let selfWindowsStartTime: number | null = null;

function isValidPid(pid: number): boolean {
  return Number.isInteger(pid) && pid > 0;
}

/**
 * Check if a process is a zombie on Linux by reading /proc/<pid>/status.
 * Returns false on non-Linux platforms or if the proc file can't be read.
 */
function isZombieProcess(pid: number): boolean {
  if (process.platform !== "linux") {
    return false;
  }
  try {
    const status = fsSync.readFileSync(`/proc/${pid}/status`, "utf8");
    const stateMatch = status.match(/^State:\s+(\S)/m);
    return stateMatch?.[1] === "Z";
  } catch {
    return false;
  }
}

/** Returns true only when a positive PID exists and is not a Linux zombie process. */
export function isPidAlive(pid: number): boolean {
  if (!isValidPid(pid)) {
    return false;
  }
  try {
    process.kill(pid, 0);
  } catch (err) {
    // EPERM means the PID exists but we cannot signal it. Treat that as a
    // successful existence probe, then still apply the Linux zombie check.
    // Keep parity with isPidDefinitelyDead (EPERM is not "definitely dead").
    if ((err as NodeJS.ErrnoException).code !== "EPERM") {
      return false;
    }
  }
  if (isZombieProcess(pid)) {
    return false;
  }
  return true;
}

/** Returns true only when the PID is invalid, missing, or known to be a Linux zombie. */
export function isPidDefinitelyDead(pid: number): boolean {
  if (!isValidPid(pid)) {
    return true;
  }
  try {
    process.kill(pid, 0);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ESRCH";
  }
  return isZombieProcess(pid);
}

function getDarwinProcessStartTime(pid: number): number | null {
  try {
    const startedAt = childProcess
      .execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
        encoding: "utf8",
        env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
        stdio: ["ignore", "pipe", "ignore"],
        timeout: DARWIN_PS_TIMEOUT_MS,
      })
      .trim();
    // Darwin's lstart output has no timezone. Force UTC for both ps and parsing so
    // a system timezone change cannot make a live lock owner look like PID reuse.
    const startedAtMs = Date.parse(`${startedAt} UTC`);
    return Number.isFinite(startedAtMs) ? Math.floor(startedAtMs / 1000) : null;
  } catch {
    return null;
  }
}

/** Read the Linux procfs start identity used by Linux-owned runtime state. */
export function getProcessStartTime(pid: number): number | null {
  if (!isValidPid(pid)) {
    return null;
  }
  if (process.platform !== "linux") {
    return null;
  }
  try {
    const stat = fsSync.readFileSync(`/proc/${pid}/stat`, "utf8");
    const commEndIndex = stat.lastIndexOf(")");
    if (commEndIndex < 0) {
      return null;
    }
    // The comm field (field 2) is wrapped in parens and can contain spaces,
    // so split after the last ")" to get fields 3..N reliably.
    const afterComm = stat.slice(commEndIndex + 1).trimStart();
    const fields = afterComm.split(/\s+/);
    // field 22 (starttime) = index 19 after the comm-split (field 3 is index 0).
    const starttime = Number(fields[19]);
    return Number.isInteger(starttime) && starttime >= 0 ? starttime : null;
  } catch {
    return null;
  }
}

/**
 * Read a cross-platform process identity for filesystem lock ownership.
 *
 * The value is an opaque per-platform identity token, not a comparable
 * timestamp: Linux reports scheduler ticks, Darwin epoch seconds, and Windows
 * epoch milliseconds. Callers only ever compare it against a value this helper
 * produced on the same host, so the units never need to agree across platforms.
 *
 * `windowsProbeTimeoutMs` bounds each Windows attempt (PowerShell, then the
 * WMIC fallback where it still exists). Callers that need a harder bound than
 * the default pass their own; it is ignored on the other platforms, which also
 * read identity fresh on every call. Only the Windows read of our own PID is
 * memoized, because only that probe is costly enough to be worth caching.
 */
export function getFileLockProcessStartTime(
  pid: number,
  windowsProbeTimeoutMs = WINDOWS_PROBE_TIMEOUT_MS,
): number | null {
  if (!isValidPid(pid)) {
    return null;
  }
  if (process.platform === "darwin") {
    return getDarwinProcessStartTime(pid);
  }
  if (process.platform !== "win32") {
    return getProcessStartTime(pid);
  }
  const isSelf = pid === process.pid;
  if (isSelf && selfWindowsStartTime !== null) {
    return selfWindowsStartTime;
  }
  const startTime = readWindowsProcessStartTimeSync(pid, windowsProbeTimeoutMs);
  if (isSelf && startTime !== null) {
    selfWindowsStartTime = startTime;
  }
  return startTime;
}
