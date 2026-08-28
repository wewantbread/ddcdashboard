// Discord direct-configured stale ingress regression tests.
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
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { DiscordGuildEntryResolved } from "./allow-list.js";
import { createDiscordIngressMonitor, type DiscordIngressLifecycle } from "./ingress.js";

type DiscordIngressPayload = {
  version: 1;
  receivedAt: number;
  rawMessage: APIMessage;
};

type RawMessageOverrides = Partial<APIMessage> & {
  channel?: unknown;
  channel_type?: number;
  guild_id?: string;
};

type DiscordGuildEntries = Record<string, DiscordGuildEntryResolved>;

const DIRECT_OPEN_CHANNEL_ID = "direct-configured-mention-open-channel";
const STALE_MS = 15 * 60 * 1_000;
const DISCORD_INGRESS_WAIT_TIMEOUT_MS = 10_000;
// Pre-claim stale checks lazily import the mention runtime on first use. Warming
// it outside the dispatch waits keeps a cold module graph from being charged to
// whichever test happens to evaluate stale ambient backlog first.
const DISCORD_INGRESS_RUNTIME_WARM_TIMEOUT_MS = 120_000;

function createRawMessage(
  id: string,
  channelId = DIRECT_OPEN_CHANNEL_ID,
  overrides: RawMessageOverrides = {},
): APIMessage {
  return {
    id,
    channel_id: channelId,
    content: "hello",
    author: {
      id: "user-1",
      username: "alice",
      discriminator: "0",
      avatar: null,
    },
    attachments: [],
    embeds: [],
    mentions: [],
    mention_roles: [],
    mention_everyone: false,
    timestamp: new Date().toISOString(),
    edited_timestamp: null,
    components: [],
    pinned: false,
    type: 0,
    tts: false,
    ...overrides,
  } as unknown as APIMessage;
}

function payloadFor(rawMessage: APIMessage, receivedAt: number): DiscordIngressPayload {
  return { version: 1, receivedAt, rawMessage };
}

function runtime(): Pick<RuntimeEnv, "error" | "log"> {
  return { error: vi.fn(), log: vi.fn() };
}

function directOpenGuildEntries(channelId = DIRECT_OPEN_CHANNEL_ID): DiscordGuildEntries {
  return {
    "guild-1": {
      channels: {
        [channelId]: { enabled: true, requireMention: false },
      },
    },
  };
}

async function withQueue<T>(
  now: () => number,
  fn: (queue: ChannelIngressQueue<DiscordIngressPayload>) => Promise<T>,
): Promise<T> {
  const created = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-discord-ingress-"));
  const stateDir = await fs.realpath(created);
  const queue = createChannelIngressQueueForTests<DiscordIngressPayload>({
    channelId: "discord",
    accountId: "default",
    stateDir,
    now,
  });
  try {
    return await fn(queue);
  } finally {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

function createMonitor(params: {
  queue: ChannelIngressQueue<DiscordIngressPayload>;
  now: () => number;
  guildEntries?: DiscordGuildEntries;
  runtime?: Pick<RuntimeEnv, "error" | "log">;
  cfg?: OpenClawConfig;
  dispatch: Parameters<typeof createDiscordIngressMonitor>[0]["dispatch"];
}) {
  return createDiscordIngressMonitor({
    accountId: "default",
    client: {} as never,
    runtime: params.runtime ?? runtime(),
    botUserId: "bot-1",
    guildEntries: params.guildEntries ?? directOpenGuildEntries(),
    cfg: params.cfg,
    now: params.now,
    queue: params.queue,
    dispatch: params.dispatch,
  });
}

async function expectDispatches(params: {
  rawMessage: APIMessage;
  clock: number;
  guildEntries?: DiscordGuildEntries;
  cfg?: OpenClawConfig;
}): Promise<void> {
  await withQueue(
    () => params.clock,
    async (queue) => {
      const sentAt = Date.parse(params.rawMessage.timestamp);
      await queue.enqueue(params.rawMessage.id, payloadFor(params.rawMessage, sentAt), {
        laneKey: `channel:${params.rawMessage.channel_id}`,
        receivedAt: sentAt,
      });
      const dispatched: string[] = [];
      const monitor = createMonitor({
        queue,
        now: () => params.clock,
        guildEntries: params.guildEntries,
        cfg: params.cfg,
        dispatch: async (event, lifecycle: DiscordIngressLifecycle) => {
          if (!event.id) {
            throw new Error("expected dispatched Discord event id");
          }
          dispatched.push(event.id);
          await lifecycle.onAdopted();
        },
      });
      monitor.start();
      try {
        await vi.waitFor(() => expect(dispatched).toEqual([params.rawMessage.id]), {
          timeout: DISCORD_INGRESS_WAIT_TIMEOUT_MS,
        });
        expect(await queue.listFailed?.({ limit: "all" })).toEqual([]);
      } finally {
        await monitor.stop();
      }
    },
  );
}

async function expectFailsAsAmbient(params: {
  rawMessage: APIMessage;
  clock: number;
  guildEntries?: DiscordGuildEntries;
}): Promise<void> {
  await withQueue(
    () => params.clock,
    async (queue) => {
      const sentAt = Date.parse(params.rawMessage.timestamp);
      await queue.enqueue(params.rawMessage.id, payloadFor(params.rawMessage, sentAt), {
        laneKey: `channel:${params.rawMessage.channel_id}`,
        receivedAt: sentAt,
      });
      const dispatch = vi.fn(async (_event, lifecycle: DiscordIngressLifecycle) => {
        await lifecycle.onAdopted();
      });
      const monitor = createMonitor({
        queue,
        now: () => params.clock,
        guildEntries: params.guildEntries,
        dispatch,
      });
      monitor.start();
      try {
        await vi.waitFor(
          async () => {
            expect(await queue.listFailed?.({ limit: "all" })).toMatchObject([
              { id: params.rawMessage.id, reason: "stale-ambient-backlog" },
            ]);
          },
          { timeout: DISCORD_INGRESS_WAIT_TIMEOUT_MS },
        );
        expect(dispatch).not.toHaveBeenCalled();
      } finally {
        await monitor.stop();
      }
    },
  );
}

describe("Discord direct-configured stale ingress", () => {
  beforeAll(async () => {
    await import("openclaw/plugin-sdk/channel-inbound");
  }, DISCORD_INGRESS_RUNTIME_WARM_TIMEOUT_MS);

  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
  });

  it("keeps directly configured stale rows with unknown raw channel type fail-open", async () => {
    const clock = 1_780_000_000_000;
    const staleId = `stale-${DIRECT_OPEN_CHANNEL_ID}-a`;
    const freshId = `fresh-${DIRECT_OPEN_CHANNEL_ID}-b`;
    await withQueue(
      () => clock,
      async (queue) => {
        const staleSentAt = clock - 16 * 60 * 1_000;
        const stale = createRawMessage(staleId, DIRECT_OPEN_CHANNEL_ID, {
          guild_id: "guild-1",
          content: "ordinary old room text",
          timestamp: new Date(staleSentAt).toISOString(),
        } as RawMessageOverrides);
        const fresh = createRawMessage(freshId, DIRECT_OPEN_CHANNEL_ID, {
          guild_id: "guild-1",
          content: "fresh direct ask <@bot-1>",
          mentions: [{ id: "bot-1" }] as APIMessage["mentions"],
          timestamp: new Date(clock).toISOString(),
        } as RawMessageOverrides);
        await queue.enqueue(staleId, payloadFor(stale, clock), {
          laneKey: `channel:${DIRECT_OPEN_CHANNEL_ID}`,
          receivedAt: clock,
        });
        await queue.enqueue(freshId, payloadFor(fresh, clock), {
          laneKey: `channel:${DIRECT_OPEN_CHANNEL_ID}`,
          receivedAt: clock + 1,
        });

        const dispatched: string[] = [];
        const log = vi.fn();
        const monitor = createMonitor({
          queue,
          now: () => clock,
          runtime: { error: vi.fn(), log },
          dispatch: async (event, lifecycle: DiscordIngressLifecycle) => {
            if (!event.id) {
              throw new Error("expected dispatched Discord event id");
            }
            dispatched.push(event.id);
            await lifecycle.onAdopted();
          },
        });
        monitor.start();
        try {
          await vi.waitFor(() => expect(dispatched).toEqual([staleId, freshId]));
          expect(await queue.listFailed?.({ limit: "all" })).toEqual([]);
          expect(log).not.toHaveBeenCalled();
        } finally {
          await monitor.stop();
        }
      },
    );
  });

  it("dead-letters stale authoritative raw non-thread backlog before fresh addressed work", async () => {
    const clock = 1_780_000_050_000;
    const staleId = `stale-non-thread-${DIRECT_OPEN_CHANNEL_ID}-a`;
    const freshId = `fresh-non-thread-${DIRECT_OPEN_CHANNEL_ID}-b`;
    await withQueue(
      () => clock,
      async (queue) => {
        const staleSentAt = clock - 16 * 60 * 1_000;
        const stale = createRawMessage(staleId, DIRECT_OPEN_CHANNEL_ID, {
          guild_id: "guild-1",
          channel_type: ChannelType.GuildText,
          content: "ordinary old room text",
          timestamp: new Date(staleSentAt).toISOString(),
        } as RawMessageOverrides);
        const fresh = createRawMessage(freshId, DIRECT_OPEN_CHANNEL_ID, {
          guild_id: "guild-1",
          channel_type: ChannelType.GuildText,
          content: "fresh direct ask <@bot-1>",
          mentions: [{ id: "bot-1" }] as APIMessage["mentions"],
          timestamp: new Date(clock).toISOString(),
        } as RawMessageOverrides);
        expect(Object.hasOwn(stale, "channel")).toBe(false);
        expect(Object.hasOwn(fresh, "channel")).toBe(false);
        await queue.enqueue(staleId, payloadFor(stale, clock), {
          laneKey: `channel:${DIRECT_OPEN_CHANNEL_ID}`,
          receivedAt: clock,
        });
        await queue.enqueue(freshId, payloadFor(fresh, clock), {
          laneKey: `channel:${DIRECT_OPEN_CHANNEL_ID}`,
          receivedAt: clock + 1,
        });

        const dispatched: string[] = [];
        const log = vi.fn();
        const monitor = createMonitor({
          queue,
          now: () => clock,
          runtime: { error: vi.fn(), log },
          dispatch: async (event, lifecycle: DiscordIngressLifecycle) => {
            if (!event.id) {
              throw new Error("expected dispatched Discord event id");
            }
            dispatched.push(event.id);
            await lifecycle.onAdopted();
          },
        });
        monitor.start();
        try {
          await vi.waitFor(() => expect(dispatched).toEqual([freshId]));
          expect(await queue.listFailed?.({ limit: "all" })).toMatchObject([
            { id: staleId, reason: "stale-ambient-backlog" },
          ]);
          expect(log).toHaveBeenCalledTimes(1);
          expect(log.mock.calls[0]?.[0]).toEqual(
            expect.objectContaining({
              eventId: staleId,
              sourceEventId: staleId,
              laneKey: `channel:${DIRECT_OPEN_CHANNEL_ID}`,
              channelId: DIRECT_OPEN_CHANNEL_ID,
              disposition: "failed",
              reason: "stale-ambient-backlog",
            }),
          );
          expect(JSON.stringify(log.mock.calls[0]?.[0])).not.toContain("ordinary old room text");
        } finally {
          await monitor.stop();
        }
      },
    );
  });

  it.each([
    [STALE_MS, "dispatches"],
    [STALE_MS + 1, "dead-letters"],
  ] as const)("uses a strict 15-minute stale boundary", async (ageMs, expected) => {
    const clock = 1_780_000_100_000;
    const rawMessage = createRawMessage(`boundary-${ageMs}`, `direct-boundary-${ageMs}`, {
      guild_id: "guild-1",
      channel_type: ChannelType.GuildText,
      content: "ordinary old room text",
      timestamp: new Date(clock - ageMs).toISOString(),
    } as RawMessageOverrides);
    const guildEntries = directOpenGuildEntries(rawMessage.channel_id);
    if (expected === "dispatches") {
      await expectDispatches({ rawMessage, clock, guildEntries });
    } else {
      await expectFailsAsAmbient({ rawMessage, clock, guildEntries });
    }
  });

  it("treats dead-letter resubmit as fresh operator intent", async () => {
    let clock = 1_780_000_200_000;
    const messageId = `resubmit-${DIRECT_OPEN_CHANNEL_ID}`;
    await withQueue(
      () => clock,
      async (queue) => {
        const rawMessage = createRawMessage(messageId, DIRECT_OPEN_CHANNEL_ID, {
          guild_id: "guild-1",
          channel_type: ChannelType.GuildText,
          content: "ordinary old room text",
          timestamp: new Date(clock - 16 * 60 * 1_000).toISOString(),
        } as RawMessageOverrides);
        await queue.enqueue(messageId, payloadFor(rawMessage, clock), {
          laneKey: `channel:${DIRECT_OPEN_CHANNEL_ID}`,
          receivedAt: clock,
        });
        const firstDispatch = vi.fn(async (_event, lifecycle: DiscordIngressLifecycle) => {
          await lifecycle.onAdopted();
        });
        const firstMonitor = createMonitor({
          queue,
          now: () => clock,
          dispatch: firstDispatch,
        });
        firstMonitor.start();
        try {
          await vi.waitFor(async () => {
            expect(await queue.listFailed?.({ limit: "all" })).toMatchObject([
              { id: messageId, reason: "stale-ambient-backlog" },
            ]);
          });
          expect(firstDispatch).not.toHaveBeenCalled();
        } finally {
          await firstMonitor.stop();
        }

        clock += 5 * 60 * 1_000;
        if (!queue.resubmit) {
          throw new Error("expected queue.resubmit");
        }
        await expect(queue.resubmit(messageId, { resubmittedAt: clock })).resolves.toMatchObject({
          kind: "resubmitted",
          record: { id: messageId, receivedAt: clock, attempts: 0 },
        });
        const dispatched: string[] = [];
        const replayMonitor = createMonitor({
          queue,
          now: () => clock,
          dispatch: async (event, lifecycle: DiscordIngressLifecycle) => {
            if (!event.id) {
              throw new Error("expected dispatched Discord event id");
            }
            dispatched.push(event.id);
            await lifecycle.onAdopted();
          },
        });
        replayMonitor.start();
        try {
          await vi.waitFor(() => expect(dispatched).toEqual([messageId]));
          expect(await queue.listFailed?.({ limit: "all" })).toEqual([]);
        } finally {
          await replayMonitor.stop();
        }
      },
    );
  });

  it.each([
    {
      name: "direct bot mention",
      id: "1023-direct-mention",
      overrides: {
        content: "old direct ask <@bot-1>",
        mentions: [{ id: "bot-1" }] as APIMessage["mentions"],
      },
    },
    {
      name: "reply to the bot",
      id: "1023-reply",
      overrides: {
        content: "old explicit reply",
        referenced_message: createRawMessage("reply-source-bot", DIRECT_OPEN_CHANNEL_ID, {
          guild_id: "guild-1",
          author: {
            id: "bot-1",
            username: "openclaw",
            discriminator: "0",
            global_name: null,
            avatar: null,
            bot: true,
          },
        } as RawMessageOverrides),
      },
    },
    {
      name: "everyone mention",
      id: "1023-everyone",
      overrides: { content: "@everyone old explicit ask", mention_everyone: true },
    },
    {
      name: "text control command",
      id: "1023-control",
      overrides: { content: "/status" },
      cfg: {} satisfies OpenClawConfig,
    },
  ])("keeps stale $name in a direct-configured mention-open raw channel", async (testCase) => {
    const clock = 1_780_000_300_000;
    await expectDispatches({
      rawMessage: createRawMessage(testCase.id, DIRECT_OPEN_CHANNEL_ID, {
        guild_id: "guild-1",
        channel_type: ChannelType.GuildText,
        timestamp: new Date(clock - 16 * 60 * 1_000).toISOString(),
        ...testCase.overrides,
      } as RawMessageOverrides),
      cfg: testCase.cfg,
      clock,
    });
  });

  it("keeps stale hydrateable replies with missing referenced payload fail-open", async () => {
    const clock = 1_780_000_400_000;
    await expectDispatches({
      rawMessage: createRawMessage("1023-hydrateable-reply", DIRECT_OPEN_CHANNEL_ID, {
        guild_id: "guild-1",
        content: "old reply without nested referenced payload",
        type: MessageType.Reply,
        message_reference: {
          type: MessageReferenceType.Default,
          message_id: "reply-source-missing",
          channel_id: DIRECT_OPEN_CHANNEL_ID,
          guild_id: "guild-1",
        },
        timestamp: new Date(clock - 16 * 60 * 1_000).toISOString(),
      } as RawMessageOverrides),
      clock,
    });
  });

  it("still dead-letters stale replies when the referenced author is known non-bot", async () => {
    const clock = 1_780_000_500_000;
    await expectFailsAsAmbient({
      rawMessage: createRawMessage("1023-known-nonbot-reply", DIRECT_OPEN_CHANNEL_ID, {
        guild_id: "guild-1",
        channel_type: ChannelType.GuildText,
        content: "old reply to a human",
        type: MessageType.Reply,
        message_reference: {
          type: MessageReferenceType.Default,
          message_id: "reply-source-human",
          channel_id: DIRECT_OPEN_CHANNEL_ID,
          guild_id: "guild-1",
        },
        referenced_message: createRawMessage("reply-source-human", DIRECT_OPEN_CHANNEL_ID, {
          guild_id: "guild-1",
          author: {
            id: "user-2",
            username: "bob",
            discriminator: "0",
            global_name: null,
            avatar: null,
          },
        } as RawMessageOverrides),
        timestamp: new Date(clock - 16 * 60 * 1_000).toISOString(),
      } as RawMessageOverrides),
      clock,
    });
  });
});
