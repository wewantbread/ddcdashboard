// Covers isolated heartbeat rollover archival of the previous wake transcript (#131770).
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveMainSessionKey } from "../config/sessions.js";
import { formatSessionArchiveTimestamp } from "../config/sessions/artifacts.js";
import { resolveSessionTranscriptsDirForAgent } from "../config/sessions/paths.js";
import { heartbeatLog } from "./heartbeat-runner-config.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import { installHeartbeatRunnerTestRuntime } from "./heartbeat-runner.test-harness.js";
import {
  readSessionStoreForTest,
  seedHeartbeatScratchForTest,
  seedSessionStore,
  withTempHeartbeatSandbox,
} from "./heartbeat-runner.test-utils.js";

const deliverOutboundPayloadsInternal = vi.hoisted(() =>
  vi.fn().mockResolvedValue([{ channel: "whatsapp", messageId: "msg-1" }]),
);

vi.mock("./outbound/deliver.js", () => ({
  deliverOutboundPayloads: deliverOutboundPayloadsInternal,
  deliverOutboundPayloadsInternal,
}));

installHeartbeatRunnerTestRuntime();

afterEach(() => {
  deliverOutboundPayloadsInternal.mockClear();
});

function makeIsolatedLastTargetConfig(tmpDir: string, storePath: string): OpenClawConfig {
  return {
    agents: {
      list: [{ id: "main", default: true }],
      defaults: {
        workspace: tmpDir,
        heartbeat: {
          every: "5m",
          target: "last",
          isolatedSession: true,
        },
      },
    },
    channels: { whatsapp: { allowFrom: ["*"] } },
    session: { store: storePath },
  };
}

describe("runHeartbeatOnce - isolated heartbeat transcript rollover", () => {
  it("archives the previous isolated wake transcript instead of orphaning it", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = makeIsolatedLastTargetConfig(tmpDir, storePath);
      const baseSessionKey = resolveMainSessionKey(cfg);
      const isolatedSessionKey = `${baseSessionKey}:heartbeat`;
      const nowMs = Date.now();
      await seedHeartbeatScratchForTest({
        content: "Check whether the user needs a status update.",
      });
      await seedSessionStore(storePath, baseSessionKey, {
        sessionId: "base-session",
        updatedAt: nowMs - 2_000,
        lastChannel: "whatsapp",
        lastProvider: "whatsapp",
        lastTo: "+15551234567",
      });
      await seedSessionStore(storePath, isolatedSessionKey, {
        sessionId: "previous-wake",
        updatedAt: nowMs - 1_000,
        heartbeatIsolatedBaseSessionKey: baseSessionKey,
      });
      const sessionsDir = resolveSessionTranscriptsDirForAgent("main", process.env);
      await fs.mkdir(sessionsDir, { recursive: true });
      const transcriptPath = path.join(sessionsDir, "previous-wake.jsonl");
      await fs.writeFile(
        transcriptPath,
        `{"type":"message","sessionKey":"${isolatedSessionKey}"}\n`,
      );
      replySpy.mockResolvedValueOnce({ text: "All good." });

      const result = await runHeartbeatOnce({
        cfg,
        deps: {
          getReplyFromConfig: replySpy,
          getQueueSize: () => 0,
          nowMs: () => nowMs,
        },
      });

      expect(result.status).toBe("ran");
      const store = readSessionStoreForTest<{ sessionId?: string }>(storePath);
      expect(store[isolatedSessionKey]?.sessionId).toBeTruthy();
      expect(store[isolatedSessionKey]?.sessionId).not.toBe("previous-wake");
      // The replaced transcript must not stay behind as an unreferenced primary
      // file; it is archived alongside other lifecycle artifacts.
      const remaining = await fs.readdir(sessionsDir);
      expect(remaining).not.toContain("previous-wake.jsonl");
      expect(remaining.some((name) => name.startsWith("previous-wake.jsonl."))).toBe(true);
    });
  });

  it("warns per failed transcript rename and still completes the rollover", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = makeIsolatedLastTargetConfig(tmpDir, storePath);
      const baseSessionKey = resolveMainSessionKey(cfg);
      const isolatedSessionKey = `${baseSessionKey}:heartbeat`;
      const nowMs = Date.now();
      await seedHeartbeatScratchForTest({
        content: "Check whether the user needs a status update.",
      });
      await seedSessionStore(storePath, baseSessionKey, {
        sessionId: "base-session",
        updatedAt: nowMs - 2_000,
        lastChannel: "whatsapp",
        lastProvider: "whatsapp",
        lastTo: "+15551234567",
      });
      await seedSessionStore(storePath, isolatedSessionKey, {
        sessionId: "previous-wake",
        updatedAt: nowMs - 1_000,
        heartbeatIsolatedBaseSessionKey: baseSessionKey,
      });
      const sessionsDir = resolveSessionTranscriptsDirForAgent("main", process.env);
      await fs.mkdir(sessionsDir, { recursive: true });
      const transcriptPath = path.join(sessionsDir, "previous-wake.jsonl");
      await fs.writeFile(
        transcriptPath,
        `{"type":"message","sessionKey":"${isolatedSessionKey}"}\n`,
      );
      replySpy.mockResolvedValueOnce({ text: "All good." });
      // Force a deterministic rename failure independent of user privileges:
      // pin the archive timestamp and pre-create the archive target as a
      // directory, so renameSync(file -> directory) fails with EISDIR. The
      // per-file error callback must surface that failure instead of
      // swallowing it.
      const fixedNow = nowMs;
      const nowSpy = vi.spyOn(Date, "now").mockReturnValue(fixedNow);
      const archiveStamp = formatSessionArchiveTimestamp(fixedNow);
      await fs.mkdir(path.join(sessionsDir, `previous-wake.jsonl.deleted.${archiveStamp}`), {
        recursive: true,
      });
      const warnSpy = vi.spyOn(heartbeatLog, "warn");
      try {
        const result = await runHeartbeatOnce({
          cfg,
          deps: {
            getReplyFromConfig: replySpy,
            getQueueSize: () => 0,
            nowMs: () => nowMs,
          },
        });

        expect(result.status).toBe("ran");
        const store = readSessionStoreForTest<{ sessionId?: string }>(storePath);
        expect(store[isolatedSessionKey]?.sessionId).toBeTruthy();
        expect(store[isolatedSessionKey]?.sessionId).not.toBe("previous-wake");
        // The rename failed, so the transcript stays in place; it must not be
        // silently dropped from observability.
        const remaining = await fs.readdir(sessionsDir);
        expect(remaining).toContain("previous-wake.jsonl");
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining("previous-wake.jsonl"),
          expect.objectContaining({ sessionKey: isolatedSessionKey }),
        );
      } finally {
        warnSpy.mockRestore();
        nowSpy.mockRestore();
      }
    });
  });

  it("keeps a sandbox-required creation stamp across rollover archival", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = makeIsolatedLastTargetConfig(tmpDir, storePath);
      const baseSessionKey = resolveMainSessionKey(cfg);
      const isolatedSessionKey = `${baseSessionKey}:heartbeat`;
      const nowMs = Date.now();
      const createdAt = nowMs - 7 * 24 * 3_600_000;
      await seedHeartbeatScratchForTest({
        content: "Check whether the user needs a status update.",
      });
      await seedSessionStore(storePath, baseSessionKey, {
        sessionId: "base-session",
        updatedAt: nowMs - 2_000,
        lastChannel: "whatsapp",
        lastProvider: "whatsapp",
        lastTo: "+15551234567",
      });
      await seedSessionStore(storePath, isolatedSessionKey, {
        sessionId: "previous-wake",
        updatedAt: nowMs - 1_000,
        heartbeatIsolatedBaseSessionKey: baseSessionKey,
        createdVia: "cron",
        createdActor: { type: "system" },
        createdAt,
        sandbox: "required",
      });
      replySpy.mockResolvedValueOnce({ text: "All good." });

      const result = await runHeartbeatOnce({
        cfg,
        deps: {
          getReplyFromConfig: replySpy,
          getQueueSize: () => 0,
          nowMs: () => nowMs,
        },
      });

      expect(result.status).toBe("ran");
      const store = readSessionStoreForTest<{
        createdAt?: number;
        createdVia?: string;
        sandbox?: string;
        sessionId?: string;
      }>(storePath);
      expect(store[isolatedSessionKey]?.sessionId).toBeTruthy();
      expect(store[isolatedSessionKey]?.sessionId).not.toBe("previous-wake");
      expect(store[isolatedSessionKey]?.createdAt).toBe(createdAt);
      expect(store[isolatedSessionKey]?.createdVia).toBe("cron");
      expect(store[isolatedSessionKey]?.sandbox).toBe("required");
    });
  });
});
