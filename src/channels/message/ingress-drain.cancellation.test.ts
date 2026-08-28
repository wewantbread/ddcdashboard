import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fanInChannelIngressLifecycles } from "../../plugin-sdk/channel-ingress-runtime.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { createChannelIngressDrain } from "./ingress-drain.js";
import {
  createTestIngressQueue,
  type IngressDrainTestPayload as Payload,
  withTempState,
} from "./ingress-drain.test-helpers.js";
import { DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS } from "./ingress-retry-policy.js";

type ChannelIngressDispatchLifecycle = Parameters<
  Parameters<typeof createChannelIngressDrain>[0]["dispatchClaimedEvent"]
>[1];

/** Predates onCancelled: mixed fan-in cancel falls back to onAbandoned. */
function asLegacyLifecycle(
  lifecycle: ChannelIngressDispatchLifecycle,
): Omit<ChannelIngressDispatchLifecycle, "onCancelled"> {
  return {
    abortSignal: lifecycle.abortSignal,
    onAdopted: lifecycle.onAdopted,
    onDeferred: lifecycle.onDeferred,
    onAdoptionFinalizing: lifecycle.onAdoptionFinalizing,
    onAbandoned: lifecycle.onAbandoned,
  };
}

describe("channel ingress drain cancellation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    closeOpenClawStateDatabaseForTest();
  });

  it("cancels unadopted work without changing its retry facts", async () => {
    await withTempState(async (stateDir) => {
      let clock = 100;
      const queue = createTestIngressQueue(stateDir, { now: () => clock });
      await queue.enqueue("evt-cancel", { text: "x" }, { laneKey: "l1", receivedAt: 1 });
      const failedClaim = await queue.claim("evt-cancel", { ownerId: "failed-owner" });
      expect(failedClaim).not.toBeNull();
      if (!failedClaim) {
        return;
      }
      await queue.release(failedClaim, { lastError: "previous failure", releasedAt: clock });
      const before = (await queue.listPending())[0];
      for (let cycle = 0; cycle < 3; cycle += 1) {
        const lifecycles: ChannelIngressDispatchLifecycle[] = [];
        clock += 1;
        const drain = createChannelIngressDrain<Payload>({
          queue,
          now: () => clock,
          retryPolicy: { baseMs: 0, maxMs: 0 },
          dispatchClaimedEvent: async (_event, lifecycle) => {
            lifecycles.push(lifecycle);
            return { kind: "deferred" };
          },
        });

        await drain.drainOnce();
        await vi.waitFor(() => expect(lifecycles).toHaveLength(1));
        await expectDefined(
          expectDefined(lifecycles[0], "cancelled lifecycle").onCancelled,
          "cancel callback",
        )();
        expect(await queue.listPending()).toEqual([
          expect.objectContaining({
            id: "evt-cancel",
            attempts: before?.attempts,
            lastAttemptAt: before?.lastAttemptAt,
            lastError: before?.lastError,
          }),
        ]);
        expect(await queue.listClaims()).toEqual([]);
        drain.dispose();
      }

      const terminal = createChannelIngressDrain<Payload>({
        queue,
        now: () => clock,
        retryPolicy: { maxAttempts: 2, deadLetterMinAgeMs: 0, baseMs: 0, maxMs: 0 },
        dispatchClaimedEvent: async () => {
          throw new Error("final genuine failure");
        },
      });
      await terminal.drainOnce();
      await terminal.waitForIdle();
      expect(await queue.listFailed?.()).toEqual([
        expect.objectContaining({
          id: "evt-cancel",
          attempts: 1,
          reason: "retry-limit-exceeded",
          message: "final genuine failure",
        }),
      ]);
      terminal.dispose();
    });
  });

  it("mixed capable and legacy fan-in cancel stays budget-free while genuine abandon terminalizes", async () => {
    await withTempState(async (stateDir) => {
      let clock = 1;
      const queue = createTestIngressQueue(stateDir, { now: () => clock });
      const retryPolicy = {
        maxAttempts: DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS,
        deadLetterMinAgeMs: 0,
        baseMs: 0,
        maxMs: 0,
      };
      await queue.enqueue("capable", { text: "keep" }, { laneKey: "capable", receivedAt: 1 });
      await queue.enqueue("legacy", { text: "keep" }, { laneKey: "legacy", receivedAt: 1 });

      for (let pass = 0; pass < DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS; pass += 1) {
        clock += 1;
        const captured = new Map<string, ChannelIngressDispatchLifecycle>();
        const drain = createChannelIngressDrain<Payload>({
          queue,
          now: () => clock,
          retryPolicy,
          dispatchClaimedEvent: async (event, lifecycle) => {
            captured.set(event.id, lifecycle);
            lifecycle.onDeferred();
            return { kind: "deferred" };
          },
        });
        await drain.drainOnce();
        await drain.waitForIdle();
        await fanInChannelIngressLifecycles([
          expectDefined(captured.get("capable"), "capable lifecycle"),
          asLegacyLifecycle(expectDefined(captured.get("legacy"), "legacy lifecycle")),
        ]).cancel();
        expect(await queue.listFailed?.({ limit: "all" })).toEqual([]);
        expect(await queue.listPending()).toEqual([
          expect.objectContaining({ id: "capable", attempts: 0 }),
          expect.objectContaining({ id: "legacy", attempts: 0 }),
        ]);
        drain.dispose();
      }

      clock += 1;
      const sweep = createChannelIngressDrain<Payload>({
        queue,
        now: () => clock,
        retryPolicy,
        dispatchClaimedEvent: async (event, lifecycle) => {
          await lifecycle.onAdopted();
          return { kind: "completed" };
        },
      });
      await sweep.drainOnce();
      await sweep.waitForIdle();
      sweep.dispose();

      await queue.enqueue("poison", { text: "block" }, { laneKey: "lane", receivedAt: 10 });
      await queue.enqueue("follower", { text: "next" }, { laneKey: "lane", receivedAt: 11 });
      const adopted: string[] = [];
      const abandon = createChannelIngressDrain<Payload>({
        queue,
        now: () => clock,
        retryPolicy,
        dispatchClaimedEvent: async (event, lifecycle) => {
          if (event.id === "poison") {
            lifecycle.onDeferred();
            await lifecycle.onAbandoned();
            return { kind: "deferred" };
          }
          await lifecycle.onAdopted();
          adopted.push(event.id);
          return { kind: "completed" };
        },
      });
      for (let pass = 0; pass < DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS; pass += 1) {
        clock += 1;
        await abandon.drainOnce();
        await abandon.waitForIdle();
      }
      expect(await queue.listFailed?.({ limit: "all" })).toEqual([
        expect.objectContaining({
          id: "poison",
          reason: "retry-limit-exceeded",
          message: "turn-abandoned",
        }),
      ]);
      clock += 1;
      await abandon.drainOnce();
      await abandon.waitForIdle();
      expect(adopted).toEqual(["follower"]);
      abandon.dispose();
    });
  });
});
