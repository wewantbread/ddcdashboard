// Fixed-semantics fossil for karmaterminal/openclaw#1246.
// Desired contract: stale temporal validity is independent of mention-gating.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ChannelType,
  MessageReferenceType,
  MessageType,
  type APIMessage,
} from "discord-api-types/v10";
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
const BOT_USER_ID = "9000000000000000003";
const GUILD_ID = "9000000000000000001";
const CHANNEL_ID = "9000000000000000002";
const USER_ID = "9000000000000000004";

type DiscordIngressPayload = {
  version: 1;
  receivedAt: number;
  rawMessage: APIMessage;
  channelKind?: "non-thread" | "thread";
};

type RawMessageOverrides = Partial<Omit<APIMessage, "referenced_message">> & {
  channel_type?: number;
  guild_id?: string;
  // Fixtures model gateway frames whose nested reply payload is absent, partial,
  // or answers a different message. Ingress reads only these two fields.
  referenced_message?: { id?: string; author?: { id?: string } } | null;
};

type DiscordIngressMonitor = ReturnType<typeof createDiscordIngressMonitor>;

function createRawMessage(
  id: string,
  channelId = CHANNEL_ID,
  overrides: RawMessageOverrides = {},
): APIMessage {
  return {
    id,
    channel_id: channelId,
    content: "synthetic ambient ledger ping",
    author: {
      id: USER_ID,
      username: "fossil-user",
      discriminator: "0",
      avatar: null,
    },
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

function runtime(): Pick<RuntimeEnv, "error" | "log"> {
  return { error: vi.fn(), log: vi.fn() };
}

function payloadFor(
  rawMessage: APIMessage,
  receivedAt = FROZEN_NOW,
  channelKind?: "non-thread" | "thread",
): DiscordIngressPayload {
  return {
    version: 1,
    receivedAt,
    rawMessage,
    ...(channelKind ? { channelKind } : {}),
  };
}

function directOpenGuildEntries(
  channelId = CHANNEL_ID,
): NonNullable<Parameters<typeof createDiscordIngressMonitor>[0]["guildEntries"]> {
  return {
    [GUILD_ID]: {
      requireMention: false,
      channels: {
        [channelId]: { enabled: true, requireMention: false },
      },
    },
  };
}

function mentionGatedGuildEntries(
  channelId = CHANNEL_ID,
): NonNullable<Parameters<typeof createDiscordIngressMonitor>[0]["guildEntries"]> {
  return {
    [GUILD_ID]: {
      requireMention: true,
      channels: {
        [channelId]: { enabled: true, requireMention: true },
      },
    },
  };
}

async function withQueue<T>(
  fn: (queue: ChannelIngressQueue<DiscordIngressPayload>) => Promise<T>,
): Promise<T> {
  const created = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-1246-discord-fossil-"));
  const stateDir = await fs.realpath(created);
  const queue = createChannelIngressQueueForTests<DiscordIngressPayload>({
    channelId: "discord",
    accountId: "fossil-1246",
    stateDir,
  });
  try {
    return await fn(queue);
  } finally {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

async function enqueueRow(
  queue: ChannelIngressQueue<DiscordIngressPayload>,
  rawMessage: APIMessage,
  params: {
    receivedAt: number;
    channelKind?: "non-thread" | "thread";
  },
): Promise<void> {
  await queue.enqueue(
    rawMessage.id,
    payloadFor(rawMessage, params.receivedAt, params.channelKind),
    {
      laneKey: `channel:${rawMessage.channel_id}`,
      receivedAt: params.receivedAt,
    },
  );
}

function startMonitor(params: {
  queue: ChannelIngressQueue<DiscordIngressPayload>;
  guildEntries: NonNullable<Parameters<typeof createDiscordIngressMonitor>[0]["guildEntries"]>;
  dispatch: (event: { id?: string }, lifecycle: DiscordIngressLifecycle) => Promise<void> | void;
}): DiscordIngressMonitor {
  return createDiscordIngressMonitor({
    accountId: "fossil-1246",
    client: {} as never,
    runtime: runtime(),
    botUserId: BOT_USER_ID,
    guildEntries: params.guildEntries,
    now: () => FROZEN_NOW,
    queue: params.queue,
    dispatch: async (event, lifecycle) => {
      await params.dispatch(event, lifecycle);
    },
  });
}

async function expectSettledWithoutDispatch(params: {
  queue: ChannelIngressQueue<DiscordIngressPayload>;
  dispatched: string[];
  ids: string[];
}): Promise<void> {
  await vi.waitFor(async () => {
    expect(params.dispatched, "stale direct-open rows must not dispatch").toEqual([]);
    const failed = await params.queue.listFailed?.({ limit: "all" });
    expect(failed).toMatchObject(params.ids.map((id) => ({ id, reason: "stale-ambient-backlog" })));
  });
  expect(await params.queue.listPending({ limit: "all" })).toEqual([]);
}

describe("Discord direct-open stale ingress fossil (#1246)", () => {
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
  });

  it("settles stale direct-open ambient without provider, typing, agent turn, or visible delivery", async () => {
    await withQueue(async (queue) => {
      const staleAt = FROZEN_NOW - STALE_MS;
      const stale = createRawMessage("1246-stale-ambient", CHANNEL_ID, {
        guild_id: GUILD_ID,
        channel_type: ChannelType.GuildText,
        timestamp: new Date(staleAt).toISOString(),
      });
      await enqueueRow(queue, stale, { receivedAt: staleAt, channelKind: "non-thread" });

      const dispatched: string[] = [];
      const monitor = startMonitor({
        queue,
        guildEntries: directOpenGuildEntries(),
        dispatch: async (event, lifecycle) => {
          dispatched.push(event.id ?? "missing");
          await lifecycle.onAdopted();
        },
      });
      monitor.start();
      try {
        await expectSettledWithoutDispatch({
          queue,
          dispatched,
          ids: ["1246-stale-ambient"],
        });
      } finally {
        await monitor.stop();
      }
    });
  });

  it("dispatches a fresh direct-open ambient row exactly once", async () => {
    await withQueue(async (queue) => {
      const fresh = createRawMessage("1246-fresh-ambient", CHANNEL_ID, {
        guild_id: GUILD_ID,
        channel_type: ChannelType.GuildText,
        timestamp: new Date(FROZEN_NOW).toISOString(),
      });
      await enqueueRow(queue, fresh, { receivedAt: FROZEN_NOW, channelKind: "non-thread" });

      const dispatched: string[] = [];
      const monitor = startMonitor({
        queue,
        guildEntries: directOpenGuildEntries(),
        dispatch: async (event, lifecycle) => {
          dispatched.push(event.id ?? "missing");
          await lifecycle.onAdopted();
        },
      });
      monitor.start();
      try {
        await vi.waitFor(() => expect(dispatched).toEqual(["1246-fresh-ambient"]));
        expect(await queue.listFailed?.({ limit: "all" })).toEqual([]);
        expect(dispatched).toEqual(["1246-fresh-ambient"]);
      } finally {
        await monitor.stop();
      }
    });
  });

  it("settles mention-gated stale unaddressed ambient and dispatches a fresh direct mention once", async () => {
    await withQueue(async (queue) => {
      const staleAt = FROZEN_NOW - STALE_MS;
      const stale = createRawMessage("1246-mention-stale", CHANNEL_ID, {
        guild_id: GUILD_ID,
        channel_type: ChannelType.GuildText,
        timestamp: new Date(staleAt).toISOString(),
      });
      const fresh = createRawMessage("1246-mention-fresh", CHANNEL_ID, {
        guild_id: GUILD_ID,
        channel_type: ChannelType.GuildText,
        content: "fresh <@9000000000000000003>",
        mentions: [{ id: BOT_USER_ID }] as APIMessage["mentions"],
        timestamp: new Date(FROZEN_NOW).toISOString(),
      });
      await enqueueRow(queue, stale, { receivedAt: staleAt, channelKind: "non-thread" });
      await enqueueRow(queue, fresh, { receivedAt: FROZEN_NOW, channelKind: "non-thread" });

      const dispatched: string[] = [];
      const monitor = startMonitor({
        queue,
        guildEntries: mentionGatedGuildEntries(),
        dispatch: async (event, lifecycle) => {
          dispatched.push(event.id ?? "missing");
          await lifecycle.onAdopted();
        },
      });
      monitor.start();
      try {
        await vi.waitFor(() => expect(dispatched).toEqual(["1246-mention-fresh"]));
        expect(await queue.listFailed?.({ limit: "all" })).toMatchObject([
          { id: "1246-mention-stale", reason: "stale-ambient-backlog" },
        ]);
      } finally {
        await monitor.stop();
      }
    });
  });

  it.each([
    {
      name: "direct bot mention",
      id: "1246-preserve-mention",
      overrides: {
        content: "stale <@9000000000000000003>",
        mentions: [{ id: BOT_USER_ID }] as APIMessage["mentions"],
        channel_type: ChannelType.GuildText,
        guild_id: GUILD_ID,
      },
      channelKind: "non-thread" as const,
    },
    {
      name: "reply to bot",
      id: "1246-preserve-reply-bot",
      overrides: {
        type: MessageType.Reply,
        channel_type: ChannelType.GuildText,
        guild_id: GUILD_ID,
        message_reference: {
          channel_id: CHANNEL_ID,
          message_id: "9000000000000000099",
          type: MessageReferenceType.Default,
        },
        referenced_message: {
          id: "9000000000000000099",
          author: { id: BOT_USER_ID, username: "bot", discriminator: "0", avatar: null },
        },
      },
      channelKind: "non-thread" as const,
    },
    {
      name: "missing hydratable reply payload",
      id: "1246-preserve-missing-reply",
      overrides: {
        type: MessageType.Reply,
        channel_type: ChannelType.GuildText,
        guild_id: GUILD_ID,
        message_reference: {
          channel_id: CHANNEL_ID,
          message_id: "9000000000000000098",
          type: MessageReferenceType.Default,
        },
      },
      channelKind: "non-thread" as const,
    },
    {
      name: "mismatched hydratable reply payload",
      id: "1246-preserve-mismatch-reply",
      overrides: {
        type: MessageType.Reply,
        channel_type: ChannelType.GuildText,
        guild_id: GUILD_ID,
        message_reference: {
          channel_id: CHANNEL_ID,
          message_id: "9000000000000000097",
          type: MessageReferenceType.Default,
        },
        referenced_message: {
          id: "9000000000000000000",
          author: { id: USER_ID, username: "fossil-user", discriminator: "0", avatar: null },
        },
      },
      channelKind: "non-thread" as const,
    },
    {
      name: "control command",
      id: "1246-preserve-control",
      overrides: {
        content: "/new",
        channel_type: ChannelType.GuildText,
        guild_id: GUILD_ID,
      },
      channelKind: "non-thread" as const,
    },
    {
      name: "thread channel kind",
      id: "1246-preserve-thread",
      overrides: {
        channel_type: ChannelType.PublicThread,
        guild_id: GUILD_ID,
      },
      channelKind: "thread" as const,
    },
    {
      name: "dm without guild",
      id: "1246-preserve-dm",
      overrides: {
        channel_type: ChannelType.DM,
      },
      channelKind: "non-thread" as const,
    },
    {
      name: "unknown channel kind",
      id: "1246-preserve-unknown-kind",
      overrides: {
        guild_id: GUILD_ID,
      },
    },
  ])("preserves fail-open $name instead of silent stale settlement", async (fixture) => {
    await withQueue(async (queue) => {
      const staleAt = FROZEN_NOW - STALE_MS;
      const rawMessage = createRawMessage(fixture.id, CHANNEL_ID, {
        ...fixture.overrides,
        timestamp: new Date(staleAt).toISOString(),
      });
      await enqueueRow(queue, rawMessage, {
        receivedAt: staleAt,
        channelKind: fixture.channelKind,
      });

      const dispatched: string[] = [];
      const monitor = startMonitor({
        queue,
        guildEntries: directOpenGuildEntries(),
        dispatch: async (event, lifecycle) => {
          dispatched.push(event.id ?? "missing");
          await lifecycle.onAdopted();
        },
      });
      monitor.start();
      try {
        await vi.waitFor(() => expect(dispatched).toEqual([fixture.id]));
        const failed = await queue.listFailed?.({ limit: "all" });
        expect(failed ?? []).not.toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: fixture.id, reason: "stale-ambient-backlog" }),
          ]),
        );
      } finally {
        await monitor.stop();
      }
    });
  });

  it("settles a deep same-lane stale backlog without fencing a fresh addressed tail", async () => {
    await withQueue(async (queue) => {
      const staleAt = FROZEN_NOW - STALE_MS;
      const staleIds = Array.from(
        { length: 12 },
        (_, index) => `1246-backlog-${String(index + 1).padStart(2, "0")}`,
      );
      for (const id of staleIds) {
        const stale = createRawMessage(id, CHANNEL_ID, {
          guild_id: GUILD_ID,
          channel_type: ChannelType.GuildText,
          timestamp: new Date(staleAt).toISOString(),
        });
        await enqueueRow(queue, stale, { receivedAt: staleAt, channelKind: "non-thread" });
      }
      const fresh = createRawMessage("1246-backlog-fresh", CHANNEL_ID, {
        guild_id: GUILD_ID,
        channel_type: ChannelType.GuildText,
        content: "fresh <@9000000000000000003>",
        mentions: [{ id: BOT_USER_ID }] as APIMessage["mentions"],
        timestamp: new Date(FROZEN_NOW).toISOString(),
      });
      await enqueueRow(queue, fresh, { receivedAt: FROZEN_NOW, channelKind: "non-thread" });

      const dispatched: string[] = [];
      const monitor = startMonitor({
        queue,
        guildEntries: directOpenGuildEntries(),
        dispatch: async (event, lifecycle) => {
          dispatched.push(event.id ?? "missing");
          await lifecycle.onAdopted();
        },
      });
      monitor.start();
      try {
        await vi.waitFor(() => expect(dispatched).toEqual(["1246-backlog-fresh"]));
        const failed = await queue.listFailed?.({ limit: "all" });
        expect(failed).toMatchObject(
          staleIds.map((id) => ({ id, reason: "stale-ambient-backlog" })),
        );
      } finally {
        await monitor.stop();
      }
    });
  });

  it("settles durable stale direct-open rows after restart without an agent turn", async () => {
    await withQueue(async (queue) => {
      const staleAt = FROZEN_NOW - STALE_MS;
      const stale = createRawMessage("1246-restart-stale", CHANNEL_ID, {
        guild_id: GUILD_ID,
        channel_type: ChannelType.GuildText,
        timestamp: new Date(staleAt).toISOString(),
      });
      await enqueueRow(queue, stale, { receivedAt: staleAt, channelKind: "non-thread" });
      expect(await queue.listPending({ limit: "all" })).toMatchObject([
        { id: "1246-restart-stale" },
      ]);

      const dispatched: string[] = [];
      const monitor = startMonitor({
        queue,
        guildEntries: directOpenGuildEntries(),
        dispatch: async (event, lifecycle) => {
          dispatched.push(event.id ?? "missing");
          await lifecycle.onAdopted();
        },
      });
      monitor.start();
      try {
        await expectSettledWithoutDispatch({
          queue,
          dispatched,
          ids: ["1246-restart-stale"],
        });
      } finally {
        await monitor.stop();
      }
    });
  });

  it("does not let retry or re-enqueue reanimate a stale-settled direct-open row", async () => {
    await withQueue(async (queue) => {
      const staleAt = FROZEN_NOW - STALE_MS;
      const stale = createRawMessage("1246-retry-stale", CHANNEL_ID, {
        guild_id: GUILD_ID,
        channel_type: ChannelType.GuildText,
        timestamp: new Date(staleAt).toISOString(),
      });
      await enqueueRow(queue, stale, { receivedAt: staleAt, channelKind: "non-thread" });

      const dispatched: string[] = [];
      const first = startMonitor({
        queue,
        guildEntries: directOpenGuildEntries(),
        dispatch: async (event, lifecycle) => {
          dispatched.push(event.id ?? "missing");
          await lifecycle.onAdopted();
        },
      });
      first.start();
      try {
        await expectSettledWithoutDispatch({
          queue,
          dispatched,
          ids: ["1246-retry-stale"],
        });
      } finally {
        await first.stop();
      }

      const retryVerdict = await queue.enqueue(
        "1246-retry-stale",
        payloadFor(stale, staleAt, "non-thread"),
        { laneKey: `channel:${CHANNEL_ID}`, receivedAt: FROZEN_NOW },
      );
      expect(retryVerdict.kind).toBe("failed");

      const second = startMonitor({
        queue,
        guildEntries: directOpenGuildEntries(),
        dispatch: async (event, lifecycle) => {
          dispatched.push(`retry:${event.id ?? "missing"}`);
          await lifecycle.onAdopted();
        },
      });
      second.start();
      try {
        await vi.waitFor(async () => {
          expect(await queue.listFailed?.({ limit: "all" })).toMatchObject([
            { id: "1246-retry-stale", reason: "stale-ambient-backlog" },
          ]);
        });
        expect(dispatched).toEqual([]);
      } finally {
        await second.stop();
      }
    });
  });
});
