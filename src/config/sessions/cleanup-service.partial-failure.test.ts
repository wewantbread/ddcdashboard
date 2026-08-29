import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";

const partialTestMock = vi.hoisted(() => ({
  failPathFragment: null as string | null,
  postLifecycleFailPathFragment: null as string | null,
}));

vi.mock("./session-accessor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session-accessor.js")>();
  return {
    ...actual,
    applySessionEntryLifecycleMutation: vi.fn(async (params) => {
      if (
        partialTestMock.failPathFragment &&
        path.normalize(params.storePath).includes(path.normalize(partialTestMock.failPathFragment))
      ) {
        throw new Error(`Injected lifecycle failure for ${params.storePath}`);
      }
      return actual.applySessionEntryLifecycleMutation(params);
    }),
  };
});

vi.mock("./session-history-eviction.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session-history-eviction.js")>();
  return {
    ...actual,
    enforceSqliteSessionHistoryDiskBudget: vi.fn(async (params) => {
      if (
        partialTestMock.postLifecycleFailPathFragment &&
        path
          .normalize(params.storePath)
          .includes(path.normalize(partialTestMock.postLifecycleFailPathFragment))
      ) {
        throw new Error(`Injected post-lifecycle disk budget failure for ${params.storePath}`);
      }
      return actual.enforceSqliteSessionHistoryDiskBudget(params);
    }),
  };
});

vi.mock("./session-accessor.sqlite-archive-store.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./session-accessor.sqlite-archive-store.js")>();
  return {
    ...actual,
    publishSessionStateArchives: vi.fn(async (scope, archives) => {
      if (
        partialTestMock.postLifecycleFailPathFragment &&
        path
          .normalize(scope.path)
          .includes(path.normalize(partialTestMock.postLifecycleFailPathFragment))
      ) {
        throw new Error(`Injected archive publication failure for ${scope.path}`);
      }
      return actual.publishSessionStateArchives(scope, archives);
    }),
  };
});

import {
  runSessionsCleanup,
  serializeSessionCleanupResult,
  SessionsCleanupPartialError,
} from "./cleanup-service.js";
import { replaceSessionEntry } from "./session-accessor.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("sessions cleanup partial failure", () => {
  afterEach(() => {
    partialTestMock.failPathFragment = null;
    partialTestMock.postLifecycleFailPathFragment = null;
    closeOpenClawAgentDatabasesForTest();
  });

  it("retains completed summaries when a later store target fails during apply", async () => {
    const rootDir = tempDirs.make("openclaw-cleanup-partial-");
    const target1StorePath = path.join(rootDir, "agents", "main", "sessions", "sessions.json");
    const target2StorePath = path.join(rootDir, "agents", "work", "sessions", "sessions.json");

    await replaceSessionEntry(
      { sessionKey: "agent:main:s1", storePath: target1StorePath },
      { sessionId: "s1", updatedAt: Date.now() - 100_000_000 },
    );
    await replaceSessionEntry(
      { sessionKey: "agent:work:s2", storePath: target2StorePath },
      { sessionId: "s2", updatedAt: Date.now() - 100_000_000 },
    );

    partialTestMock.failPathFragment = "work";

    let caughtError: unknown;
    try {
      await runSessionsCleanup({
        cfg: {},
        opts: { enforce: true, fixMissing: true },
        targets: [
          { agentId: "main", storePath: target1StorePath },
          { agentId: "work", storePath: target2StorePath },
        ],
      });
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(SessionsCleanupPartialError);
    const error = caughtError as SessionsCleanupPartialError;
    expect(error.appliedSummaries).toHaveLength(1);
    expect(error.appliedSummaries[0]?.agentId).toBe("main");
    expect(error.failingTarget.agentId).toBe("work");
    expect(error.lifecycleCommitted).toBe(false);

    const serialized = serializeSessionCleanupResult({
      mode: error.mode,
      dryRun: false,
      summaries: error.appliedSummaries,
      partialError: {
        failingAgentId: error.failingTarget.agentId,
        failingStorePath: error.failingTarget.storePath,
        message: error.message,
        lifecycleCommitted: error.lifecycleCommitted,
      },
    });
    expect(serialized).toEqual(
      expect.objectContaining({
        allAgents: true,
        partialError: expect.objectContaining({
          failingAgentId: "work",
          lifecycleCommitted: false,
        }),
      }),
    );
  });

  it("retains completed summaries when a post-lifecycle fault occurs on a store target", async () => {
    const rootDir = tempDirs.make("openclaw-cleanup-post-lifecycle-");
    const target1StorePath = path.join(rootDir, "agents", "main", "sessions", "sessions.json");
    const target2StorePath = path.join(rootDir, "agents", "work", "sessions", "sessions.json");

    await replaceSessionEntry(
      { sessionKey: "agent:main:s1", storePath: target1StorePath },
      { sessionId: "s1", updatedAt: Date.now() - 100_000_000 },
    );
    await replaceSessionEntry(
      { sessionKey: "agent:work:s2", storePath: target2StorePath },
      { sessionId: "s2", updatedAt: Date.now() - 100_000_000 },
    );

    partialTestMock.postLifecycleFailPathFragment = "work";

    let caughtError: unknown;
    try {
      await runSessionsCleanup({
        cfg: {},
        opts: { enforce: true },
        targets: [
          { agentId: "main", storePath: target1StorePath },
          { agentId: "work", storePath: target2StorePath },
        ],
      });
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(SessionsCleanupPartialError);
    const error = caughtError as SessionsCleanupPartialError;
    expect(error.appliedSummaries).toHaveLength(1);
    expect(error.appliedSummaries[0]?.agentId).toBe("main");
    expect(error.failingTarget.agentId).toBe("work");
    expect(error.lifecycleCommitted).toBe(true);
    expect(error.message).toContain("Injected archive publication failure");

    const serialized = serializeSessionCleanupResult({
      mode: error.mode,
      dryRun: false,
      summaries: error.appliedSummaries,
      partialError: {
        failingAgentId: error.failingTarget.agentId,
        failingStorePath: error.failingTarget.storePath,
        message: error.message,
        lifecycleCommitted: error.lifecycleCommitted,
      },
    });
    expect(serialized).toEqual(
      expect.objectContaining({
        allAgents: true,
        partialError: expect.objectContaining({
          failingAgentId: "work",
          lifecycleCommitted: true,
        }),
      }),
    );
  });
});
