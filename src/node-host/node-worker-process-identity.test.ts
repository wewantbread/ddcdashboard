// Node worker identity tests pin the probe budget this consumer relies on.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  inspectNodeWorkerProcessIdentity,
  requireNodeWorkerProcessIdentity,
} from "./node-worker-process-identity.js";

const mockGetFileLockProcessStartTime = vi.hoisted(() =>
  vi.fn<(pid: number, windowsProbeTimeoutMs?: number) => number | null>(() => null),
);

vi.mock("../shared/pid-alive.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../shared/pid-alive.js")>()),
  getFileLockProcessStartTime: mockGetFileLockProcessStartTime,
}));

afterEach(() => {
  mockGetFileLockProcessStartTime.mockReset();
});

describe("node worker process identity", () => {
  it("keeps the 5s Windows probe budget instead of the shorter lock-owner default", () => {
    mockGetFileLockProcessStartTime.mockReturnValue(1_752_000_000_123);

    const identity = requireNodeWorkerProcessIdentity(4242);

    // Worker startup is not on a timer path. Dropping this argument would
    // silently shorten the probe to the lock-owner default and could fail
    // worker startup closed on a slow Windows host.
    expect(mockGetFileLockProcessStartTime).toHaveBeenCalledWith(4242, 5000);
    expect(identity).toEqual({ pid: 4242, startTime: 1_752_000_000_123 });

    inspectNodeWorkerProcessIdentity(identity);

    expect(mockGetFileLockProcessStartTime).toHaveBeenLastCalledWith(4242, 5000);
  });

  it("refuses an identity it cannot establish rather than guessing one", () => {
    mockGetFileLockProcessStartTime.mockReturnValue(null);

    expect(() => requireNodeWorkerProcessIdentity(4242)).toThrow(
      "cannot establish PID-reuse-safe identity for process 4242",
    );
  });
});
