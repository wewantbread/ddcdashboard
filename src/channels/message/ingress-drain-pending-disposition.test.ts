import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import type { ResolveChannelIngressPendingDisposition } from "./ingress-drain-pending-disposition.js";
import { createChannelIngressDrain } from "./ingress-drain.js";
import {
  createTestIngressQueue,
  type IngressDrainTestPayload as Payload,
  withTempState,
} from "./ingress-drain.test-helpers.js";

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

describe("channel ingress pending disposition drain", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    closeOpenClawStateDatabaseForTest();
  });

  it("keeps a failed pending-disposition race lane-fenced while unrelated lanes progress", async () => {
    await withTempState(async (stateDir) => {
      const laneKey = "channel:discord-room";
      const clock = STALE_AMBIENT_PENDING_MS + 1;
      const queue = createTestIngressQueue(stateDir, { now: () => clock });
      await queue.enqueue(
        "stale-ambient",
        { text: "old room history", kind: "ambient" },
        { laneKey, receivedAt: 0 },
      );
      await queue.enqueue(
        "fresh-addressed",
        { text: "@openclaw current diagnostic ask", kind: "addressed" },
        { laneKey, receivedAt: clock },
      );
      await queue.enqueue(
        "other-lane",
        { text: "unrelated channel work", kind: "addressed" },
        { laneKey: "channel:other-room", receivedAt: clock + 1 },
      );

      const fail = queue.fail.bind(queue);
      let raceInjected = false;
      const siblingDrain = createChannelIngressDrain<Payload>({
        queue,
        ownerId: "sibling-drain",
        startLimit: 1,
        dispatchClaimedEvent: async () => ({
          kind: "failed-retryable",
          error: new Error("sibling released before disposition CAS"),
        }),
      });
      queue.fail = vi.fn(async (...args: Parameters<typeof queue.fail>) => {
        if (!raceInjected && args[0] === "stale-ambient") {
          raceInjected = true;
          expect(await siblingDrain.drainOnce()).toEqual({ started: 1 });
          await siblingDrain.waitForIdle();
          return false;
        }
        return await fail(...args);
      });

      const adopted: string[] = [];
      const committed: Array<{ id: string; reason: string; laneKey: string }> = [];
      const drain = createChannelIngressDrain<Payload>({
        queue,
        now: () => clock,
        startLimit: 2,
        resolvePendingDisposition: resolveStaleAmbientPendingDisposition,
        onPendingDispositionCommitted: (event, disposition, context) => {
          committed.push({
            id: event.id,
            reason: disposition.reason,
            laneKey: context.laneKey,
          });
        },
        dispatchClaimedEvent: async (event, lifecycle) => {
          adopted.push(event.id);
          await lifecycle.onAdopted();
        },
      });

      expect(await drain.drainOnce()).toEqual({ started: 1 });
      await drain.waitForIdle();
      expect(adopted).toEqual(["other-lane"]);
      // The lost CAS race must not report a commit that never happened.
      expect(committed).toEqual([]);
      expect((await queue.listPending({ limit: "all" })).map((event) => event.id)).toEqual([
        "stale-ambient",
        "fresh-addressed",
      ]);

      expect(await drain.drainOnce()).toEqual({ started: 1 });
      await drain.waitForIdle();
      expect(adopted).toEqual(["other-lane", "fresh-addressed"]);
      expect(committed).toEqual([
        { id: "stale-ambient", reason: "stale-ambient-backlog", laneKey },
      ]);
      expect(await queue.listFailed?.({ limit: "all" })).toMatchObject([
        { id: "stale-ambient", reason: "stale-ambient-backlog" },
      ]);
      siblingDrain.dispose();
      drain.dispose();
    });
  });

  it("offers only pending rows and leaves retained rows claimable", async () => {
    await withTempState(async (stateDir) => {
      const clock = 1_000;
      const queue = createTestIngressQueue(stateDir, { now: () => clock });
      await queue.enqueue(
        "held",
        { text: "first", kind: "addressed" },
        { laneKey: "channel:a", receivedAt: clock },
      );
      await queue.enqueue(
        "later",
        { text: "second", kind: "addressed" },
        { laneKey: "channel:b", receivedAt: clock },
      );

      const offered: string[][] = [];
      let pass: string[] = [];
      let release = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const drain = createChannelIngressDrain<Payload>({
        queue,
        now: () => clock,
        startLimit: 1,
        resolvePendingDisposition: (event) => {
          pass.push(event.id);
          return null;
        },
        dispatchClaimedEvent: async (event, lifecycle) => {
          if (event.id === "held") {
            await held;
          }
          await lifecycle.onAdopted();
        },
      });

      pass = [];
      await drain.drainOnce();
      offered.push(pass);

      // "held" is claimed and in flight, so the pre-claim seam must not see it.
      pass = [];
      await drain.drainOnce();
      offered.push(pass);

      release();
      await drain.waitForIdle();
      expect(offered).toEqual([["held", "later"], ["later"]]);
      expect(await queue.listPending({ limit: "all" })).toEqual([]);
      expect(await queue.listFailed?.({ limit: "all" })).toEqual([]);
      drain.dispose();
    });
  });

  it.each([
    {
      name: "throws",
      observe: () => {
        throw new Error("receipt observer failed");
      },
    },
    {
      name: "rejects",
      observe: async () => {
        throw new Error("receipt observer failed");
      },
    },
  ])("keeps draining fresh work when the committed observer $name", async ({ observe }) => {
    await withTempState(async (stateDir) => {
      const laneKey = "channel:discord-room";
      const clock = STALE_AMBIENT_PENDING_MS + 1;
      const queue = createTestIngressQueue(stateDir, { now: () => clock });
      await queue.enqueue(
        "stale-ambient",
        { text: "old room history", kind: "ambient" },
        { laneKey, receivedAt: 0 },
      );
      await queue.enqueue(
        "fresh-addressed",
        { text: "@openclaw current diagnostic ask", kind: "addressed" },
        { laneKey, receivedAt: clock },
      );

      const adopted: string[] = [];
      const logs: string[] = [];
      const drain = createChannelIngressDrain<Payload>({
        queue,
        now: () => clock,
        startLimit: 1,
        resolvePendingDisposition: resolveStaleAmbientPendingDisposition,
        onPendingDispositionCommitted: observe,
        onLog: (message) => logs.push(message),
        dispatchClaimedEvent: async (event, lifecycle) => {
          adopted.push(event.id);
          await lifecycle.onAdopted();
        },
      });

      await expect(drain.drainOnce()).resolves.toEqual({ started: 1 });
      await drain.waitForIdle();
      expect(adopted).toEqual(["fresh-addressed"]);
      expect(await queue.listPending({ limit: "all" })).toEqual([]);
      expect(await queue.listFailed?.({ limit: "all" })).toMatchObject([
        { id: "stale-ambient", reason: "stale-ambient-backlog" },
      ]);
      expect(logs).toEqual([
        "ingress drain: pending disposition observer failed for event stale-ambient: receipt observer failed",
      ]);
      drain.dispose();
    });
  });
});
