import childProcess from "node:child_process";
import { randomUUID } from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveGlobalMap } from "../shared/global-singleton.js";
import {
  getProcessStartTime,
  isPidDefinitelyDead as defaultIsPidDefinitelyDead,
} from "../shared/pid-alive.js";
import { readWindowsProcessStartTimeSync } from "./windows-process-start-time.js";

const POSITIVE_DECIMAL_RE = /^[1-9]\d*$/;
const OWNER_RE =
  /^([1-9]\d*):(x|0|[1-9]\d*):[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;

export type ProcessInstanceOwnerStatusOptions = {
  pid?: number;
  isPidDefinitelyDead?: (pid: number) => boolean;
  readProcessStartTime?: (pid: number) => number | null;
};

function parseStrictPid(value: string | undefined): number {
  const pid = value && POSITIVE_DECIMAL_RE.test(value) ? Number(value) : -1;
  return Number.isSafeInteger(pid) ? pid : -1;
}

function parseOwnerStartTime(ownerId: string): number | "x" | null {
  const match = OWNER_RE.exec(ownerId);
  if (!match || !Number.isSafeInteger(Number(match[1]))) {
    return null;
  }
  if (match[2] === "x") {
    return "x";
  }
  const startTime = Number(match[2]);
  return Number.isSafeInteger(startTime) ? startTime : null;
}

export function isCanonicalProcessInstanceOwnerId(ownerId: string): boolean {
  return parseOwnerStartTime(ownerId) !== null;
}

export function processPidFromOwnerId(ownerId: string): number {
  return parseStrictPid(ownerId.split(":", 1)[0]);
}

function readDarwinProcessStartTime(pid: number): number | null {
  try {
    const startedAt = childProcess
      .execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
        encoding: "utf8",
        env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 2_000,
        killSignal: "SIGKILL",
      })
      .trim();
    const value = Date.parse(`${startedAt} UTC`);
    return Number.isFinite(value) ? Math.floor(value / 1000) : null;
  } catch {
    return null;
  }
}

export function readProcessInstanceStartTime(
  pid: number,
  platform: NodeJS.Platform = process.platform,
): number | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return null;
  }
  if (platform === "win32") {
    return readWindowsProcessStartTimeSync(pid, 1_000);
  }
  return platform === "darwin"
    ? readDarwinProcessStartTime(pid)
    : platform === "linux"
      ? getProcessStartTime(pid)
      : null;
}

let currentProcessStartTime: number | null | undefined;

export function createProcessInstanceOwnerId(options: { bindProcessStart?: boolean } = {}): string {
  const bindStart = options.bindProcessStart !== false;
  if (bindStart && currentProcessStartTime === undefined) {
    currentProcessStartTime = readProcessInstanceStartTime(process.pid);
  }
  return [process.pid, bindStart ? (currentProcessStartTime ?? "x") : "x", randomUUID()].join(":");
}

function resolvePidStatus(
  pid: number,
  override?: (pid: number) => boolean,
): "alive" | "dead" | "unknown" {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return "dead";
  }
  if (override) {
    try {
      return override(pid) ? "dead" : "alive";
    } catch {
      return "unknown";
    }
  }
  try {
    process.kill(pid, 0);
  } catch (error) {
    return isRecord(error) && error.code === "ESRCH" ? "dead" : "unknown";
  }
  return defaultIsPidDefinitelyDead(pid) ? "dead" : "alive";
}

export function resolveProcessInstanceOwnerStatus(
  ownerId: string,
  options: ProcessInstanceOwnerStatusOptions = {},
): "alive" | "dead" | "unknown" {
  const pid = options.pid ?? processPidFromOwnerId(ownerId);
  const pidStatus = resolvePidStatus(pid, options.isPidDefinitelyDead);
  if (pidStatus !== "alive") {
    return pidStatus;
  }
  const expected = parseOwnerStartTime(ownerId);
  if (expected === null || expected === "x") {
    return "unknown";
  }
  try {
    const actual = (options.readProcessStartTime ?? readProcessInstanceStartTime)(pid);
    return actual === null ? "unknown" : actual === expected ? "alive" : "dead";
  } catch {
    return "unknown";
  }
}

// Symbol.for shares state only in one realm. Worker-owned drains need a durable boundary.
const liveOwners = resolveGlobalMap<string, Set<symbol>>(
  Symbol.for("openclaw.processInstanceOwners.live.v1"),
);

export function registerLiveProcessInstanceOwner(ownerId: string): { release: () => void } {
  const tokens = liveOwners.get(ownerId) ?? new Set<symbol>();
  const token = Symbol(ownerId);
  tokens.add(token);
  liveOwners.set(ownerId, tokens);
  return {
    release: () => {
      if (!tokens.delete(token)) {
        return;
      }
      if (tokens.size === 0 && liveOwners.get(ownerId) === tokens) {
        liveOwners.delete(ownerId);
      }
    },
  };
}

export function isLiveLocalProcessInstanceOwner(ownerId: string): boolean {
  return (liveOwners.get(ownerId)?.size ?? 0) > 0;
}
