import childProcess from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createProcessInstanceOwnerId,
  isCanonicalProcessInstanceOwnerId,
  isLiveLocalProcessInstanceOwner,
  processPidFromOwnerId,
  readProcessInstanceStartTime,
  registerLiveProcessInstanceOwner,
  resolveProcessInstanceOwnerStatus,
} from "./process-instance-owner.js";
import { readWindowsProcessStartTimeSync } from "./windows-process-start-time.js";

vi.mock("./windows-process-start-time.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./windows-process-start-time.js")>()),
  readWindowsProcessStartTimeSync: vi.fn(),
}));

const OWNER_TOKEN = "11111111-1111-4111-8111-111111111111";
const registrations: Array<{ release: () => void }> = [];
const ownerId = (pid = 42, start: number | "x" = 1000) => `${pid}:${start}:${OWNER_TOKEN}`;

afterEach(() => {
  for (const registration of registrations.splice(0)) {
    registration.release();
  }
  vi.restoreAllMocks();
  vi.mocked(readWindowsProcessStartTimeSync).mockReset();
});

describe("process instance owner", () => {
  it("mints and parses strict identities", () => {
    const id = createProcessInstanceOwnerId();
    expect(processPidFromOwnerId(id)).toBe(process.pid);
    expect(isCanonicalProcessInstanceOwnerId(id)).toBe(true);
    expect(processPidFromOwnerId(`042:1000:${OWNER_TOKEN}`)).toBe(-1);
    expect(isCanonicalProcessInstanceOwnerId("42:1000:custom")).toBe(false);
  });

  it("preserves the Darwin probe deadline and kill signal", () => {
    const exec = vi
      .spyOn(childProcess, "execFileSync")
      .mockReturnValue("Mon Jul  6 12:34:56 2026\n");
    expect(readProcessInstanceStartTime(42, "darwin")).toBe(
      Date.UTC(2026, 6, 6, 12, 34, 56) / 1000,
    );
    expect(exec).toHaveBeenCalledWith(
      "/bin/ps",
      ["-o", "lstart=", "-p", "42"],
      expect.objectContaining({ timeout: 2000, killSignal: "SIGKILL" }),
    );
  });

  it("uses the narrow Windows creation-time reader", () => {
    vi.mocked(readWindowsProcessStartTimeSync).mockReturnValue(123_456);
    expect(readProcessInstanceStartTime(42, "win32")).toBe(123_456);
    expect(readWindowsProcessStartTimeSync).toHaveBeenCalledWith(42, 1000);
  });

  it.each([
    ["alive", false, 1000, "alive"],
    ["reused", false, 2000, "dead"],
    ["absent", true, 1000, "dead"],
    ["unreadable", false, null, "unknown"],
  ] as const)("%s process resolves to %s", (_name, dead, actual, expected) => {
    expect(
      resolveProcessInstanceOwnerStatus(ownerId(), {
        isPidDefinitelyDead: () => dead,
        readProcessStartTime: () => actual,
      }),
    ).toBe(expected);
  });

  it("preserves legacy pid:uuid and x identities as unknown while alive", () => {
    const options = { isPidDefinitelyDead: () => false };
    expect(resolveProcessInstanceOwnerStatus(`42:${OWNER_TOKEN}`, options)).toBe("unknown");
    expect(resolveProcessInstanceOwnerStatus(ownerId(42, "x"), options)).toBe("unknown");
  });

  it("keeps duplicate local registrations independently live", () => {
    const id = ownerId();
    const first = registerLiveProcessInstanceOwner(id);
    const second = registerLiveProcessInstanceOwner(id);
    registrations.push(first, second);
    first.release();
    expect(isLiveLocalProcessInstanceOwner(id)).toBe(true);
    second.release();
    expect(isLiveLocalProcessInstanceOwner(id)).toBe(false);
  });
});
