// Logger file transport tests cover async ordering, overflow, and exit durability.
import fs from "node:fs";
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

  it("reports each append failure streak while continuing records", async () => {
    const logPath = logPathTracker.nextPath();
    let appendAttempts = 0;
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true as unknown as ReturnType<typeof process.stderr.write>);
    testApi.setFileLogAppenderForTests(async (options) => {
      appendAttempts += 1;
      if (appendAttempts !== 3) {
        throw new Error("injected append failure");
      }
      await appendRegularFile(options);
    });
    setLoggerOverride({ level: "info", file: logPath });

    getLogger().info("dropped-on-first-failure");
    getLogger().info("dropped-on-repeated-failure");
    getLogger().info("written-after-recovery");
    getLogger().info("dropped-after-recovery");
    await testApi.flushFileLogQueueForTests();

    const content = fs.readFileSync(logPath, "utf8");
    expect(appendAttempts).toBe(4);
    expect(stderrSpy).toHaveBeenCalledTimes(2);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("log file append failed; record dropped"),
    );
    expect(content).not.toContain("dropped-on-first-failure");
    expect(content).not.toContain("dropped-on-repeated-failure");
    expect(content).toContain("written-after-recovery");
    expect(content).not.toContain("dropped-after-recovery");
  });

  it("reports repeated synchronous append failures once", () => {
    const logPath = logPathTracker.nextPath();
    fs.mkdirSync(logPath);
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true as unknown as ReturnType<typeof process.stderr.write>);
    setLoggerOverride({ level: "info", file: logPath });

    getLogger().info("first-unwritable-record");
    getLogger().info("second-unwritable-record");
    testApi.drainFileLogQueueSyncForTests();

    expect(stderrSpy).toHaveBeenCalledTimes(1);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("log file append failed; record dropped"),
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
