// Corrupt pending rows must never abort the pump before fresh work is claimed.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ChannelType, type APIMessage } from "discord-api-types/v10";
import type { ChannelIngressQueue } from "openclaw/plugin-sdk/channel-outbound";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDiscordIngressMonitor, type DiscordIngressLifecycle } from "./ingress.js";

const FROZEN_NOW = Date.parse("2026-08-20T03:00:00.000Z");
const BOT_USER_ID = "8100000000000000003";
const GUILD_ID = "8100000000000000001";
const CHANNEL_ID = "8100000000000000002";
const LANE_KEY = `channel:${CHANNEL_ID}`;

type DiscordIngressPayload = {
  version: 1;
  receivedAt: number;
  rawMessage: APIMessage;
  channelKind?: "non-thread" | "thread";
};

function createAddressedMessage(id: string): APIMessage {
  return {
    id,
    channel_id: CHANNEL_ID,
    guild_id: GUILD_ID,
    channel_type: ChannelType.GuildText,
    content: `fresh <@${BOT_USER_ID}>`,
    author: { id: "8100000000000000004", username: "op", discriminator: "0", avatar: null },
    attachments: [],
    embeds: [],
    mentions: [{ id: BOT_USER_ID }],
    mention_roles: [],
    mention_everyone: false,
    timestamp: new Date(FROZEN_NOW).toISOString(),
    edited_timestamp: null,
    components: [],
    pinned: false,
    type: 0,
    tts: false,
  } as unknown as APIMessage;
}

async function withQueue<T>(
  fn: (queue: ChannelIngressQueue<DiscordIngressPayload>) => Promise<T>,
): Promise<T> {
  const created = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-discord-corrupt-pending-"));
  const stateDir = await fs.realpath(created);
  const queue = createChannelIngressQueueForTests<DiscordIngressPayload>({
    channelId: "discord",
    accountId: "corrupt-pending",
    stateDir,
  });
  try {
    return await fn(queue);
  } finally {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

describe("Discord durable ingress corrupt pending rows", () => {
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
  });

  it.each([
    { name: "json null payload", payload: null },
    { name: "primitive payload", payload: 42 },
    { name: "payload without a message", payload: { version: 1, receivedAt: FROZEN_NOW } },
    {
      name: "payload with a null message",
      payload: { version: 1, receivedAt: FROZEN_NOW, rawMessage: null },
    },
    {
      name: "payload with an identity-less message",
      payload: { version: 1, receivedAt: FROZEN_NOW, rawMessage: { content: "no ids" } },
    },
  ])(
    "fails a $name through invalid-event and still admits the next fresh same-lane message",
    async ({ payload }) => {
      await withQueue(async (queue) => {
        const staleReceivedAt = FROZEN_NOW - 60 * 60 * 1_000;
        await queue.enqueue("corrupt-row", payload as unknown as DiscordIngressPayload, {
          laneKey: LANE_KEY,
          receivedAt: staleReceivedAt,
        });
        const fresh = createAddressedMessage("fresh-row");
        await queue.enqueue(
          "fresh-row",
          { version: 1, receivedAt: FROZEN_NOW, rawMessage: fresh, channelKind: "non-thread" },
          { laneKey: LANE_KEY, receivedAt: FROZEN_NOW },
        );

        const dispatched: string[] = [];
        const runtime: Pick<RuntimeEnv, "error" | "log"> = { error: vi.fn(), log: vi.fn() };
        const monitor = createDiscordIngressMonitor({
          accountId: "corrupt-pending",
          client: {} as never,
          runtime,
          botUserId: BOT_USER_ID,
          guildEntries: { [GUILD_ID]: { requireMention: false } },
          now: () => FROZEN_NOW,
          queue,
          dispatch: async (event: { id?: string }, lifecycle: DiscordIngressLifecycle) => {
            dispatched.push(event.id ?? "missing");
            await lifecycle.onAdopted();
          },
        });
        monitor.start();
        try {
          await vi.waitFor(async () => {
            expect(dispatched).toEqual(["fresh-row"]);
            expect(await queue.listFailed?.({ limit: "all" })).toMatchObject([
              { id: "corrupt-row", reason: "invalid-event" },
            ]);
          });
          expect(await queue.listPending({ limit: "all" })).toEqual([]);
        } finally {
          await monitor.stop();
        }
      });
    },
  );
});
