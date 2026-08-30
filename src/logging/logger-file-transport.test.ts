import fs from "node:fs";
// Logger file transport tests cover async ordering, overflow, and exit durability.
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { appendRegularFile } from "../infra/regular-file.js";
import { createSuiteLogPathTracker } from "./log-test-helpers.js";
import { getLogger, resetLogger, setLoggerOverride } from "./logger.js";
import { testApi } from "./logger.test-support.js";

const logPathTracker = createSuiteLogPathTracker("openclaw-file-transport-");

function writeStableRecords(): void {
  const logger = getLogger();
  logger.info({ sequence: 1 }, "first queued record");
  logger.info({ sequence: 2 }, "second queued record");
}

beforeAll(async () => {
  await logPathTracker.setup();
});

afterEach(async () => {
  await testApi.flushFileLogQueueForTests();
  testApi.resetFileLogTransportForTests();
  resetLogger();
  setLoggerOverride(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await logPathTracker.cleanup();
});

describe("async logger file transport", () => {
  it("installs process hooks only while file logging is active", () => {
    const beforeExitListeners = process.listenerCount("beforeExit");
    const exitListeners = process.listenerCount("exit");
    const logPath = logPathTracker.nextPath();
    setLoggerOverride({ level: "info", file: logPath });

    expect(process.listenerCount("beforeExit")).toBe(beforeExitListeners);
    expect(process.listenerCount("exit")).toBe(exitListeners);

    getLogger().info("install-file-transport-hooks");

    expect(process.listenerCount("beforeExit")).toBe(beforeExitListeners + 1);
    expect(process.listenerCount("exit")).toBe(exitListeners + 1);

    testApi.resetFileLogTransportForTests();

    expect(process.listenerCount("beforeExit")).toBe(beforeExitListeners);
    expect(process.listenerCount("exit")).toBe(exitListeners);
  });

  it("writes queued records in order and byte-identically to the synchronous drain", async () => {
    const syncPath = logPathTracker.nextPath();
    const asyncPath = logPathTracker.nextPath();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-27T12:00:00Z"));
    testApi.setHostnameResolverForTests(() => "transport-test-host");
    setLoggerOverride({ level: "info", file: syncPath });

    writeStableRecords();
    testApi.drainFileLogQueueSyncForTests();
    const syncBytes = fs.readFileSync(syncPath);

    resetLogger();
    testApi.setHostnameResolverForTests(() => "transport-test-host");
    setLoggerOverride({ level: "info", file: asyncPath });
    writeStableRecords();
    await testApi.flushFileLogQueueForTests();

    expect(fs.readFileSync(asyncPath)).toEqual(syncBytes);
    const messages = syncBytes
      .toString("utf8")
      .trim()
      .split("\n")
      .map((line) => (JSON.parse(line) as { message?: string }).message);
    expect(messages).toEqual(["first queued record", "second queued record"]);
  });

  it("drops the oldest records on overflow and writes one count marker", async () => {
    const logPath = logPathTracker.nextPath();
    testApi.setFileLogQueueMaxRecordsForTests(3);
    setLoggerOverride({ level: "info", file: logPath });

    for (let index = 1; index <= 5; index += 1) {
      getLogger().info(`queued-record-${index}`);
    }
    await testApi.flushFileLogQueueForTests();

    const records = fs
      .readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { message?: string; dropped?: number });
    const markers = records.filter((record) => record.message?.includes("queue overflow"));
    expect(markers).toEqual([
      expect.objectContaining({
        dropped: 2,
        message: "[openclaw] file log queue overflow; dropped 2 oldest records",
      }),
    ]);
    expect(records.map((record) => record.message)).toEqual([
      "[openclaw] file log queue overflow; dropped 2 oldest records",
      "queued-record-3",
      "queued-record-4",
      "queued-record-5",
    ]);
  });

  it("tracks append failure streaks independently per file", async () => {
    const firstPath = logPathTracker.nextPath();
    const secondPath = logPathTracker.nextPath();
    const attempts = new Map<string, number>();
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true as unknown as ReturnType<typeof process.stderr.write>);
    testApi.setFileLogAppenderForTests(async (options) => {
      const attempt = (attempts.get(options.filePath) ?? 0) + 1;
      attempts.set(options.filePath, attempt);
      const succeeds =
        (options.filePath === firstPath && attempt === 3) ||
        (options.filePath === secondPath && attempt === 2);
      if (!succeeds) {
        throw new Error("injected append failure");
      }
      await appendRegularFile(options);
    });
    setLoggerOverride({ level: "info", file: firstPath });
    getLogger().info("first-file-failure");
    setLoggerOverride({ level: "info", file: secondPath });
    getLogger().info("second-file-failure");
    getLogger().info("second-file-recovery");
    setLoggerOverride({ level: "info", file: firstPath });
    getLogger().info("first-file-repeated-failure");
    getLogger().info("first-file-recovery");
    getLogger().info("first-file-new-failure-streak");
    await testApi.flushFileLogQueueForTests();

    expect(attempts).toEqual(
      new Map([
        [firstPath, 4],
        [secondPath, 2],
      ]),
    );
    const warnings = stderrSpy.mock.calls.map(([line]) => String(line));
    expect(warnings.filter((line) => line.includes(`file=${firstPath}`))).toHaveLength(2);
    expect(warnings.filter((line) => line.includes(`file=${secondPath}`))).toHaveLength(1);
    expect(fs.readFileSync(firstPath, "utf8")).toContain("first-file-recovery");
    expect(fs.readFileSync(secondPath, "utf8")).toContain("second-file-recovery");
  });

  it("keeps synchronous append failure streaks isolated by file", () => {
    const firstPath = logPathTracker.nextPath();
    const secondPath = logPathTracker.nextPath();
    fs.mkdirSync(firstPath);
    fs.mkdirSync(secondPath);
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true as unknown as ReturnType<typeof process.stderr.write>);
    setLoggerOverride({ level: "info", file: firstPath });
    getLogger().info("first-file-failure");
    setLoggerOverride({ level: "info", file: secondPath });
    getLogger().info("second-file-failure");
    testApi.drainFileLogQueueSyncForTests();

    fs.rmdirSync(secondPath);
    getLogger().info("second-file-recovery");
    setLoggerOverride({ level: "info", file: firstPath });
    getLogger().info("first-file-repeated-failure");
    testApi.drainFileLogQueueSyncForTests();

    fs.rmdirSync(firstPath);
    getLogger().info("first-file-recovery");
    testApi.drainFileLogQueueSyncForTests();
    fs.rmSync(firstPath);
    fs.mkdirSync(firstPath);
    getLogger().info("first-file-new-failure-streak");
    testApi.drainFileLogQueueSyncForTests();

    const warnings = stderrSpy.mock.calls.map(([line]) => String(line));
    expect(warnings.filter((line) => line.includes(`file=${firstPath}`))).toHaveLength(2);
    expect(warnings.filter((line) => line.includes(`file=${secondPath}`))).toHaveLength(1);
    expect(fs.readFileSync(secondPath, "utf8")).toContain("second-file-recovery");
  });

  it("bounds append failure diagnostics across changing file targets", async () => {
    const paths = Array.from({ length: 65 }, () => logPathTracker.nextPath());
    const firstPath = expectDefined(paths[0], "first append failure path");
    const lastPath = expectDefined(paths.at(-1), "last append failure path");
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true as unknown as ReturnType<typeof process.stderr.write>);
    testApi.setFileLogAppenderForTests(async () => {
      throw new Error("injected append failure");
    });

    for (const [index, file] of paths.entries()) {
      setLoggerOverride({ level: "info", file });
      getLogger().info(`failure-${index}`);
    }
    await testApi.flushFileLogQueueForTests();

    const warnings = stderrSpy.mock.calls.map(([line]) => String(line));
    expect(warnings.filter((line) => line.includes("diagnostics saturated"))).toHaveLength(1);
    expect(warnings.some((line) => line.includes(`file=${lastPath}`))).toBe(false);

    testApi.setFileLogAppenderForTests(async (options) => {
      if (options.filePath !== firstPath) {
        throw new Error("injected append failure");
      }
      await appendRegularFile(options);
    });
    setLoggerOverride({ level: "info", file: firstPath });
    getLogger().info("tracked-file-recovery");
    setLoggerOverride({ level: "info", file: lastPath });
    getLogger().info("newly-tracked-failure");
    await testApi.flushFileLogQueueForTests();

    expect(stderrSpy.mock.calls.some(([line]) => String(line).includes(`file=${lastPath}`))).toBe(
      true,
    );
  });

  it("synchronously drains a crash-adjacent fatal record through the exit-hook seam", () => {
    const logPath = logPathTracker.nextPath();
    setLoggerOverride({ level: "info", file: logPath });

    getLogger().fatal("fatal-before-exit");
    expect(fs.existsSync(logPath)).toBe(false);
    testApi.drainFileLogQueueSyncForTests();

    expect(fs.readFileSync(logPath, "utf8")).toContain("fatal-before-exit");
  });
});
