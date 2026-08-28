// Durable admission must persist a real gateway channel-kind fact for stale expiry.
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

const STALE_MS = 16 * 60 * 1_000;
const FROZEN_NOW = Date.parse("2026-08-20T03:00:00.000Z");
const BOT_USER_ID = "8200000000000000003";
const GUILD_ID = "8200000000000000001";
const CHANNEL_ID = "8200000000000000002";
const LANE_KEY = `channel:${CHANNEL_ID}`;

type DiscordIngressChannelKind = "non-thread" | "thread";

type DiscordIngressPayload = {
  version: 1;
  receivedAt: number;
  rawMessage: APIMessage;
  channelKind?: DiscordIngressChannelKind;
};

/** Raw MESSAGE_CREATE frame shape: gateway envelope extras, no attached channel object. */
function createGatewayFrame(
  id: string,
  overrides: Partial<APIMessage> & { channel_type?: number; guild_id?: string } = {},
): APIMessage {
  return {
    id,
    channel_id: CHANNEL_ID,
    content: "ordinary room chatter",
    author: { id: "8200000000000000004", username: "op", discriminator: "0", avatar: null },
    attachments: [],
    embeds: [],
    mentions: [],
    mention_roles: [],
    mention_everyone: false,
    timestamp: new Date(FROZEN_NOW).toISOString(),
    edited_timestamp: null,
    components: [],
    pinned: false,
    type: 0,
    tts: false,
    ...overrides,
  } as unknown as APIMessage;
}

async function withQueue<T>(
  fn: (queue: ChannelIngressQueue<DiscordIngressPayload>) => Promise<T>,
): Promise<T> {
  const created = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-discord-channel-kind-"));
  const stateDir = await fs.realpath(created);
  const queue = createChannelIngressQueueForTests<DiscordIngressPayload>({
    channelId: "discord",
    accountId: "channel-kind",
    stateDir,
  });
  try {
    return await fn(queue);
  } finally {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

function startMonitor(params: {
  queue: ChannelIngressQueue<DiscordIngressPayload>;
  dispatched: string[];
}) {
  const runtime: Pick<RuntimeEnv, "error" | "log"> = { error: vi.fn(), log: vi.fn() };
  return createDiscordIngressMonitor({
    accountId: "channel-kind",
    client: {} as never,
    runtime,
    botUserId: BOT_USER_ID,
    guildEntries: { [GUILD_ID]: { requireMention: false } },
    now: () => FROZEN_NOW,
    queue: params.queue,
    dispatch: async (event: { id?: string }, lifecycle: DiscordIngressLifecycle) => {
      params.dispatched.push(event.id ?? "missing");
      await lifecycle.onAdopted();
    },
  });
}

describe("Discord durable ingress channel kind", () => {
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
  });

  it.each([
    { name: "guild text", channelType: ChannelType.GuildText, expected: "non-thread" },
    {
      name: "guild announcement",
      channelType: ChannelType.GuildAnnouncement,
      expected: "non-thread",
    },
    { name: "guild voice", channelType: ChannelType.GuildVoice, expected: "non-thread" },
    { name: "direct message", channelType: ChannelType.DM, expected: "non-thread" },
    { name: "public thread", channelType: ChannelType.PublicThread, expected: "thread" },
    { name: "private thread", channelType: ChannelType.PrivateThread, expected: "thread" },
    {
      name: "announcement thread",
      channelType: ChannelType.AnnouncementThread,
      expected: "thread",
    },
  ])("persists $name admissions as $expected", async ({ channelType, expected }) => {
    await withQueue(async (queue) => {
      const dispatched: string[] = [];
      const monitor = startMonitor({ queue, dispatched });
      await monitor.accept(
        createGatewayFrame("kind-row", {
          guild_id: GUILD_ID,
          channel_type: channelType,
        }) as never,
      );
      expect(await queue.listPending({ limit: "all" })).toMatchObject([
        { id: "kind-row", payload: { channelKind: expected } },
      ]);
    });
  });

  it("persists no kind when the gateway omits channel_type", async () => {
    await withQueue(async (queue) => {
      const dispatched: string[] = [];
      const monitor = startMonitor({ queue, dispatched });
      await monitor.accept(createGatewayFrame("kindless-row", { guild_id: GUILD_ID }) as never);
      const pending = await queue.listPending({ limit: "all" });
      expect(pending).toHaveLength(1);
      expect(pending[0]?.payload).not.toHaveProperty("channelKind");
    });
  });

  it("expires a stale row admitted from a raw MESSAGE_CREATE frame", async () => {
    await withQueue(async (queue) => {
      const staleAt = FROZEN_NOW - STALE_MS;
      const dispatched: string[] = [];
      const monitor = startMonitor({ queue, dispatched });
      const frame = createGatewayFrame("raw-stale", {
        guild_id: GUILD_ID,
        channel_type: ChannelType.GuildText,
        timestamp: new Date(staleAt).toISOString(),
      });
      await queue.enqueue(
        "raw-stale",
        { version: 1, receivedAt: staleAt, rawMessage: frame, channelKind: "non-thread" },
        { laneKey: LANE_KEY, receivedAt: staleAt },
      );
      monitor.start();
      try {
        await vi.waitFor(async () => {
          expect(await queue.listFailed?.({ limit: "all" })).toMatchObject([
            { id: "raw-stale", reason: "stale-ambient-backlog" },
          ]);
        });
        expect(dispatched).toEqual([]);
      } finally {
        await monitor.stop();
      }
    });
  });

  it("expires a stale row admitted before the fact was persisted", async () => {
    await withQueue(async (queue) => {
      const staleAt = FROZEN_NOW - STALE_MS;
      const dispatched: string[] = [];
      const monitor = startMonitor({ queue, dispatched });
      // Legacy shape: no persisted channelKind, only the stored gateway frame.
      const frame = createGatewayFrame("legacy-stale", {
        guild_id: GUILD_ID,
        channel_type: ChannelType.GuildText,
        timestamp: new Date(staleAt).toISOString(),
      });
      await queue.enqueue(
        "legacy-stale",
        { version: 1, receivedAt: staleAt, rawMessage: frame },
        { laneKey: LANE_KEY, receivedAt: staleAt },
      );
      monitor.start();
      try {
        await vi.waitFor(async () => {
          expect(await queue.listFailed?.({ limit: "all" })).toMatchObject([
            { id: "legacy-stale", reason: "stale-ambient-backlog" },
          ]);
        });
        expect(dispatched).toEqual([]);
      } finally {
        await monitor.stop();
      }
    });
  });

  it("expires a stale row from the persisted fact when the stored frame lost channel_type", async () => {
    await withQueue(async (queue) => {
      const staleAt = FROZEN_NOW - STALE_MS;
      const dispatched: string[] = [];
      const monitor = startMonitor({ queue, dispatched });
      const frame = createGatewayFrame("persisted-stale", {
        guild_id: GUILD_ID,
        timestamp: new Date(staleAt).toISOString(),
      });
      await queue.enqueue(
        "persisted-stale",
        { version: 1, receivedAt: staleAt, rawMessage: frame, channelKind: "non-thread" },
        { laneKey: LANE_KEY, receivedAt: staleAt },
      );
      monitor.start();
      try {
        await vi.waitFor(async () => {
          expect(await queue.listFailed?.({ limit: "all" })).toMatchObject([
            { id: "persisted-stale", reason: "stale-ambient-backlog" },
          ]);
        });
        expect(dispatched).toEqual([]);
      } finally {
        await monitor.stop();
      }
    });
  });

  it("keeps a stale row claimable when no channel kind fact exists", async () => {
    await withQueue(async (queue) => {
      const staleAt = FROZEN_NOW - STALE_MS;
      const dispatched: string[] = [];
      const monitor = startMonitor({ queue, dispatched });
      const frame = createGatewayFrame("unknown-stale", {
        guild_id: GUILD_ID,
        timestamp: new Date(staleAt).toISOString(),
      });
      await queue.enqueue(
        "unknown-stale",
        { version: 1, receivedAt: staleAt, rawMessage: frame },
        { laneKey: LANE_KEY, receivedAt: staleAt },
      );
      monitor.start();
      try {
        await vi.waitFor(() => expect(dispatched).toEqual(["unknown-stale"]));
        expect(await queue.listFailed?.({ limit: "all" })).toEqual([]);
      } finally {
        await monitor.stop();
      }
    });
  });
});
