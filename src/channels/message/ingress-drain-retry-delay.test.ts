// Retry-delay lane ordering regressions for the durable ingress drain.
import { afterEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { createChannelIngressDrain } from "./ingress-drain.js";
import {
  createTestIngressQueue,
  type IngressDrainTestPayload as Payload,
  withTempState,
} from "./ingress-drain.test-helpers.js";

type TestIngressQueue = ReturnType<typeof createTestIngressQueue>;

async function releasePendingForRetry(
  queue: TestIngressQueue,
  id: string,
  releasedAt: number,
): Promise<void> {
  const claim = await queue.claim(id, { ownerId: "retry-delay-test-setup" });
  if (!claim) {
    throw new Error(`expected claim for ${id}`);
  }
  await queue.release(claim, { lastError: "retry backoff", releasedAt });
}

describe("channel ingress drain retry-delay lane ordering", () => {
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
  });

  it("runs an eligible same-lane head when only the tail is retry-delayed", async () => {
    await withTempState(async (stateDir) => {
      let clock = 1_000;
      const laneKey = "channel:discord-room";
      const queue = createTestIngressQueue(stateDir, { now: () => clock });
      await queue.enqueue(
        "eligible-head",
        { text: "@openclaw current diagnostic ask" },
        { laneKey, receivedAt: clock },
      );
      await queue.enqueue(
        "retrying-tail",
        { text: "failed tail" },
        { laneKey, receivedAt: clock + 1 },
      );
      await releasePendingForRetry(queue, "retrying-tail", clock);

      clock += 1_000;
      const adopted: string[] = [];
      const drain = createChannelIngressDrain<Payload>({
        queue,
        now: () => clock,
        retryPolicy: { baseMs: 60_000, maxMs: 60_000 },
        dispatchClaimedEvent: async (event, lifecycle) => {
          adopted.push(event.id);
          await lifecycle.onAdopted();
        },
      });

      expect(await drain.drainOnce()).toEqual({ started: 1 });
      await drain.waitForIdle();
      expect(adopted).toEqual(["eligible-head"]);
      expect((await queue.listPending({ limit: "all" })).map((event) => event.id)).toEqual([
        "retrying-tail",
      ]);
      drain.dispose();
    });
  });

  it("blocks an eligible same-lane tail when the oldest row is retry-delayed", async () => {
    await withTempState(async (stateDir) => {
      let clock = 1_000;
      const laneKey = "channel:discord-room";
      const queue = createTestIngressQueue(stateDir, { now: () => clock });
      await queue.enqueue(
        "retrying-head",
        { text: "ambient backlog head" },
        { laneKey, receivedAt: clock },
      );
      await queue.enqueue(
        "fresh-addressed",
        { text: "@openclaw current diagnostic ask" },
        { laneKey, receivedAt: clock + 1 },
      );
      await queue.enqueue(
        "other-lane",
        { text: "unrelated channel work" },
        { laneKey: "channel:other-room", receivedAt: clock + 2 },
      );
      await releasePendingForRetry(queue, "retrying-head", clock);

      clock += 1_000;
      const adopted: string[] = [];
      const drain = createChannelIngressDrain<Payload>({
        queue,
        now: () => clock,
        retryPolicy: { baseMs: 60_000, maxMs: 60_000 },
        dispatchClaimedEvent: async (event, lifecycle) => {
          adopted.push(event.id);
          await lifecycle.onAdopted();
        },
      });

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
  });

  it("lets terminal disposition of a delayed stale head free the same-lane tail", async () => {
    await withTempState(async (stateDir) => {
      let clock = 1_000;
      const laneKey = "channel:discord-room";
      const queue = createTestIngressQueue(stateDir, { now: () => clock });
      await queue.enqueue(
        "retrying-stale-head",
        { text: "old room history" },
        { laneKey, receivedAt: clock },
      );
      await queue.enqueue(
        "fresh-after-dead-letter",
        { text: "@openclaw current diagnostic ask" },
        { laneKey, receivedAt: clock + 1 },
      );
      await releasePendingForRetry(queue, "retrying-stale-head", clock);

      clock += 1_000;
      const adopted: string[] = [];
      const drain = createChannelIngressDrain<Payload>({
        queue,
        now: () => clock,
        retryPolicy: { baseMs: 60_000, maxMs: 60_000 },
        resolvePendingDisposition: (event, context) =>
          event.id === "retrying-stale-head"
            ? {
                kind: "fail",
                reason: "stale-ambient-backlog",
                message: `stale ambient backlog ${event.id} on ${context.laneKey}`,
              }
            : null,
        dispatchClaimedEvent: async (event, lifecycle) => {
          adopted.push(event.id);
          await lifecycle.onAdopted();
        },
      });

      expect(await drain.drainOnce()).toEqual({ started: 1 });
      await drain.waitForIdle();
      expect(adopted).toEqual(["fresh-after-dead-letter"]);
      expect(await queue.listFailed?.({ limit: "all" })).toMatchObject([
        { id: "retrying-stale-head", reason: "stale-ambient-backlog" },
      ]);
      drain.dispose();
    });
  });
});
