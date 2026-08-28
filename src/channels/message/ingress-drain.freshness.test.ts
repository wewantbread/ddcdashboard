// Freshness and stale-ambient backlog contract tests for durable ingress
// drain. Split from `ingress-drain.test.ts` to keep both files within the
// repo max-lines budget; lifecycle/adoption invariants stay in the original.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import type { ResolveChannelIngressPendingDisposition } from "./ingress-drain-pending-disposition.js";
import { createChannelIngressDrain } from "./ingress-drain.js";
import {
  createTestIngressQueue,
  type IngressDrainTestPayload as Payload,
  withTempState,
} from "./ingress-drain.test-helpers.js";
import {
  DEFAULT_INGRESS_RETRY_DEAD_LETTER_MIN_AGE_MS,
  DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS,
} from "./ingress-retry-policy.js";

const STALE_AMBIENT_PENDING_MS = 15 * 60 * 1_000;

const resolveStaleAmbientPendingDisposition: ResolveChannelIngressPendingDisposition<
  Payload,
  unknown
> = (event, context) => {
  if (event.payload.kind !== "ambient") {
    return null;
  }
  if (context.now - event.receivedAt <= STALE_AMBIENT_PENDING_MS) {
    return null;
  }
  return {
    kind: "fail",
    reason: "stale-ambient-backlog",
    message: `stale ambient backlog ${event.id} on ${context.laneKey}`,
  };
};

describe("channel ingress drain", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    closeOpenClawStateDatabaseForTest();
  });

  it("retry-delayed same-lane head blocks later work until eligible or dead-lettered", async () => {
    await withTempState(async (stateDir) => {
      let clock = 1_000;
      const laneKey = "channel:discord-room";
      const queue = createTestIngressQueue(stateDir, { now: () => clock });
      await queue.enqueue(
        "retrying-head",
        { text: "ambient backlog head" },
        { laneKey, receivedAt: clock },
      );

      const adopted: string[] = [];
      const drain = createChannelIngressDrain<Payload>({
        queue,
        now: () => clock,
        retryPolicy: {
          maxAttempts: DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS,
          deadLetterMinAgeMs: DEFAULT_INGRESS_RETRY_DEAD_LETTER_MIN_AGE_MS,
          baseMs: 60_000,
          maxMs: 60_000,
        },
        dispatchClaimedEvent: async (event, lifecycle) => {
          if (event.id === "retrying-head" && event.attempts === 0) {
            throw new Error("transient Discord recovery failure");
          }
          adopted.push(event.id);
          await lifecycle.onAdopted();
        },
      });

      expect(await drain.drainOnce()).toEqual({ started: 1 });
      await drain.waitForIdle();
      expect(adopted).toEqual([]);

      clock += 1_000;
      await queue.enqueue(
        "fresh-addressed",
        { text: "@openclaw current diagnostic ask" },
        { laneKey, receivedAt: clock },
      );
      await queue.enqueue(
        "other-lane",
        { text: "unrelated channel work" },
        { laneKey: "channel:other-room", receivedAt: clock + 1 },
      );

      expect(await drain.drainOnce()).toEqual({ started: 1 });
      await drain.waitForIdle();
      expect(adopted).toEqual(["other-lane"]);
      expect((await queue.listPending({ limit: "all" })).map((event) => event.id)).toEqual([
        "retrying-head",
        "fresh-addressed",
      ]);

      clock += 60_000;
      expect(await drain.drainOnce()).toEqual({ started: 1 });
      await drain.waitForIdle();
      expect(adopted).toEqual(["other-lane", "retrying-head"]);
      expect(await drain.drainOnce()).toEqual({ started: 1 });
      await drain.waitForIdle();
      expect(adopted).toEqual(["other-lane", "retrying-head", "fresh-addressed"]);
      drain.dispose();
    });

    await withTempState(async (stateDir) => {
      let clock = STALE_AMBIENT_PENDING_MS + 1;
      const laneKey = "channel:discord-room";
      const queue = createTestIngressQueue(stateDir, { now: () => clock });
      await queue.enqueue(
        "retrying-stale-head",
        { text: "old room history", kind: "ambient" },
        { laneKey, receivedAt: 0 },
      );
      const firstDrain = createChannelIngressDrain<Payload>({
        queue,
        now: () => clock,
        retryPolicy: { baseMs: 60_000, maxMs: 60_000 },
        dispatchClaimedEvent: async () => {
          throw new Error("transient Discord recovery failure");
        },
      });
      expect(await firstDrain.drainOnce()).toEqual({ started: 1 });
      await firstDrain.waitForIdle();
      firstDrain.dispose();

      clock += 1_000;
      await queue.enqueue(
        "fresh-after-dead-letter",
        { text: "@openclaw current diagnostic ask", kind: "addressed" },
        { laneKey, receivedAt: clock },
      );
      const adopted: string[] = [];
      const secondDrain = createChannelIngressDrain<Payload>({
        queue,
        now: () => clock,
        retryPolicy: { baseMs: 60_000, maxMs: 60_000 },
        resolvePendingDisposition: resolveStaleAmbientPendingDisposition,
        dispatchClaimedEvent: async (event, lifecycle) => {
          adopted.push(event.id);
          await lifecycle.onAdopted();
        },
      });

      expect(await secondDrain.drainOnce()).toEqual({ started: 1 });
      await secondDrain.waitForIdle();
      expect(adopted).toEqual(["fresh-after-dead-letter"]);
      expect(await queue.listFailed?.({ limit: "all" })).toMatchObject([
        { id: "retrying-stale-head", reason: "stale-ambient-backlog" },
      ]);
      secondDrain.dispose();
    });
  });

  it("red: stale Discord ambient backlog is not adopted before a fresh addressed event", async () => {
    await withTempState(async (stateDir) => {
      const laneKey = "channel:discord-room";
      const thirteenHoursMs = 13 * 60 * 60 * 1_000;
      const clock = thirteenHoursMs;
      const queue = createTestIngressQueue(stateDir, { now: () => clock });
      await queue.enqueue(
        "stale-ambient",
        { text: "ambient room history", kind: "ambient" },
        { laneKey, receivedAt: clock - thirteenHoursMs },
      );
      await queue.enqueue(
        "fresh-addressed",
        { text: "@openclaw current diagnostic ask", kind: "addressed" },
        { laneKey, receivedAt: clock },
      );

      const adopted: string[] = [];
      const drain = createChannelIngressDrain<Payload>({
        queue,
        now: () => clock,
        startLimit: 1,
        resolvePendingDisposition: resolveStaleAmbientPendingDisposition,
        dispatchClaimedEvent: async (event, lifecycle) => {
          adopted.push(event.id);
          await lifecycle.onAdopted();
        },
      });

      expect(await drain.drainOnce()).toEqual({ started: 1 });
      await drain.waitForIdle();
      expect(adopted).toEqual(["fresh-addressed"]);
      expect((await queue.listPending({ limit: "all" })).map((event) => event.id)).not.toContain(
        "fresh-addressed",
      );
      expect(await queue.listFailed?.({ limit: "all" })).toMatchObject([
        { id: "stale-ambient", reason: "stale-ambient-backlog" },
      ]);
      drain.dispose();
    });
  });

  it("active same-lane ownership still blocks while unrelated lanes progress", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue(stateDir);
      await queue.enqueue("active", { text: "active" }, { laneKey: "shared", receivedAt: 1 });

      let releaseActive!: () => void;
      const activeGate = new Promise<void>((resolve) => {
        releaseActive = resolve;
      });
      const adopted: string[] = [];
      const drain = createChannelIngressDrain<Payload>({
        queue,
        dispatchClaimedEvent: async (event, lifecycle) => {
          adopted.push(event.id);
          if (event.id === "active") {
            await activeGate;
          }
          await lifecycle.onAdopted();
        },
      });

      expect(await drain.drainOnce()).toEqual({ started: 1 });
      await vi.waitFor(() => expect(adopted).toEqual(["active"]));
      await queue.enqueue("same-lane", { text: "same" }, { laneKey: "shared", receivedAt: 2 });
      expect(await drain.drainOnce()).toEqual({ started: 0 });

      await queue.enqueue("other-lane", { text: "other" }, { laneKey: "other", receivedAt: 3 });
      expect(await drain.drainOnce()).toEqual({ started: 1 });
      await vi.waitFor(() => expect(adopted).toEqual(["active", "other-lane"]));

      releaseActive();
      await drain.waitForIdle();
      expect(await drain.drainOnce()).toEqual({ started: 1 });
      await drain.waitForIdle();
      expect(adopted).toEqual(["active", "other-lane", "same-lane"]);
      drain.dispose();
    });
  });

  it("stale addressed work is preserved instead of silently dispositioned", async () => {
    await withTempState(async (stateDir) => {
      const laneKey = "channel:discord-room";
      const clock = STALE_AMBIENT_PENDING_MS + 1;
      const queue = createTestIngressQueue(stateDir, { now: () => clock });
      await queue.enqueue(
        "stale-addressed",
        { text: "@openclaw old but direct", kind: "addressed" },
        { laneKey, receivedAt: 0 },
      );
      await queue.enqueue(
        "fresh-addressed",
        { text: "@openclaw current", kind: "addressed" },
        { laneKey, receivedAt: clock },
      );

      const adopted: string[] = [];
      const drain = createChannelIngressDrain<Payload>({
        queue,
        now: () => clock,
        startLimit: 1,
        resolvePendingDisposition: resolveStaleAmbientPendingDisposition,
        dispatchClaimedEvent: async (event, lifecycle) => {
          adopted.push(event.id);
          await lifecycle.onAdopted();
        },
      });

      expect(await drain.drainOnce()).toEqual({ started: 1 });
      await drain.waitForIdle();
      expect(adopted).toEqual(["stale-addressed"]);
      expect(await queue.listFailed?.({ limit: "all" })).toEqual([]);
      expect((await queue.listPending({ limit: "all" })).map((event) => event.id)).toEqual([
        "fresh-addressed",
      ]);
      drain.dispose();
    });
  });

  it("fresh ambient same-lane FIFO remains stable", async () => {
    await withTempState(async (stateDir) => {
      const laneKey = "channel:discord-room";
      const clock = STALE_AMBIENT_PENDING_MS;
      const queue = createTestIngressQueue(stateDir, { now: () => clock });
      await queue.enqueue(
        "ambient-1",
        { text: "fresh room history 1", kind: "ambient" },
        { laneKey, receivedAt: 0 },
      );
      await queue.enqueue(
        "ambient-2",
        { text: "fresh room history 2", kind: "ambient" },
        { laneKey, receivedAt: 1 },
      );

      const adopted: string[] = [];
      const drain = createChannelIngressDrain<Payload>({
        queue,
        now: () => clock,
        startLimit: 1,
        resolvePendingDisposition: resolveStaleAmbientPendingDisposition,
        dispatchClaimedEvent: async (event, lifecycle) => {
          adopted.push(event.id);
          await lifecycle.onAdopted();
        },
      });

      expect(await drain.drainOnce()).toEqual({ started: 1 });
      await drain.waitForIdle();
      expect(adopted).toEqual(["ambient-1"]);
      expect(await queue.listFailed?.({ limit: "all" })).toEqual([]);
      expect((await queue.listPending({ limit: "all" })).map((event) => event.id)).toEqual([
        "ambient-2",
      ]);
      drain.dispose();
    });
  });

  it("restart recovery dispositions stale ambient claims before fresh addressed work", async () => {
    await withTempState(async (stateDir) => {
      const laneKey = "channel:discord-room";
      const clock = STALE_AMBIENT_PENDING_MS + 1;
      const queue = createTestIngressQueue(stateDir, { now: () => clock });
      await queue.enqueue(
        "stale-ambient",
        { text: "old room history", kind: "ambient" },
        { laneKey, receivedAt: 0 },
      );
      const orphanClaim = await queue.claim("stale-ambient", { ownerId: "999:1:dead-owner" });
      expect(orphanClaim).not.toBeNull();
      await queue.enqueue(
        "fresh-addressed",
        { text: "@openclaw current", kind: "addressed" },
        { laneKey, receivedAt: clock },
      );

      const adopted: string[] = [];
      const firstDrain = createChannelIngressDrain<Payload>({
        queue,
        now: () => clock,
        resolvePendingDisposition: resolveStaleAmbientPendingDisposition,
        dispatchClaimedEvent: async (event, lifecycle) => {
          adopted.push(event.id);
          await lifecycle.onAdopted();
        },
      });
      expect(await firstDrain.drainOnce()).toEqual({ started: 1 });
      await firstDrain.waitForIdle();
      firstDrain.dispose();

      const secondDrain = createChannelIngressDrain<Payload>({
        queue,
        now: () => clock,
        resolvePendingDisposition: resolveStaleAmbientPendingDisposition,
        dispatchClaimedEvent: async (event, lifecycle) => {
          adopted.push(event.id);
          await lifecycle.onAdopted();
        },
      });
      expect(await secondDrain.drainOnce()).toEqual({ started: 0 });
      await secondDrain.waitForIdle();

      expect(adopted).toEqual(["fresh-addressed"]);
      expect(await queue.listFailed?.({ limit: "all" })).toMatchObject([
        { id: "stale-ambient", reason: "stale-ambient-backlog" },
      ]);
      await expect(
        queue.enqueue("stale-ambient", { text: "old room history", kind: "ambient" }),
      ).resolves.toMatchObject({ kind: "failed" });
      secondDrain.dispose();
    });
  });

  it("stale ambient disposition uses a strict clock boundary", async () => {
    for (const [ageMs, expected] of [
      [STALE_AMBIENT_PENDING_MS, { adopted: ["boundary-ambient"], failed: [] }],
      [
        STALE_AMBIENT_PENDING_MS + 1,
        { adopted: [], failed: [{ id: "boundary-ambient", reason: "stale-ambient-backlog" }] },
      ],
    ] as const) {
      await withTempState(async (stateDir) => {
        const queue = createTestIngressQueue(stateDir, { now: () => ageMs });
        await queue.enqueue(
          "boundary-ambient",
          { text: "boundary room history", kind: "ambient" },
          { laneKey: "channel:discord-room", receivedAt: 0 },
        );

        const adopted: string[] = [];
        const drain = createChannelIngressDrain<Payload>({
          queue,
          now: () => ageMs,
          resolvePendingDisposition: resolveStaleAmbientPendingDisposition,
          dispatchClaimedEvent: async (event, lifecycle) => {
            adopted.push(event.id);
            await lifecycle.onAdopted();
          },
        });

        expect(await drain.drainOnce()).toEqual({
          started: expected.adopted.length,
        });
        await drain.waitForIdle();
        expect(adopted).toEqual(expected.adopted);
        expect(await queue.listFailed?.({ limit: "all" })).toMatchObject(expected.failed);
        drain.dispose();
      });
    }
  });

  it("dead-letter needs both attempt floor and age (releases when age insufficient)", async () => {
    await withTempState(async (stateDir) => {
      const receivedAt = 100;
      let clock = receivedAt;
      const queue = createTestIngressQueue(stateDir, { now: () => clock });
      await queue.enqueue("poison", { text: "x" }, { laneKey: "l", receivedAt });

      // Burn attempts without aging past the gate.
      for (let i = 0; i < DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS; i += 1) {
        clock += 1;
        const drain = createChannelIngressDrain<Payload>({
          queue,
          now: () => clock,
          retryPolicy: {
            maxAttempts: DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS,
            deadLetterMinAgeMs: DEFAULT_INGRESS_RETRY_DEAD_LETTER_MIN_AGE_MS,
            baseMs: 0,
            maxMs: 0,
          },
          dispatchClaimedEvent: async () => {
            throw new Error("still broken");
          },
        });
        await drain.drainOnce();
        await drain.waitForIdle();
        drain.dispose();
      }

      const pending = await queue.listPending({ limit: "all" });
      expect(pending).toHaveLength(1);
      expect(pending[0]?.attempts).toBeGreaterThanOrEqual(DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS);

      // Age past the gate → next failure dead-letters.
      clock = receivedAt + DEFAULT_INGRESS_RETRY_DEAD_LETTER_MIN_AGE_MS;
      const finalDrain = createChannelIngressDrain<Payload>({
        queue,
        now: () => clock,
        retryPolicy: {
          maxAttempts: DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS,
          deadLetterMinAgeMs: DEFAULT_INGRESS_RETRY_DEAD_LETTER_MIN_AGE_MS,
          baseMs: 0,
          maxMs: 0,
        },
        dispatchClaimedEvent: async () => {
          throw new Error("still broken");
        },
      });
      await finalDrain.drainOnce();
      await finalDrain.waitForIdle();
      const status = await queue.enqueue("poison", { text: "x" });
      expect(status.kind).toBe("failed");
      if (status.kind === "failed") {
        expect(status.record.reason).toBe("retry-limit-exceeded");
      }
      finalDrain.dispose();
    });
  });
});
