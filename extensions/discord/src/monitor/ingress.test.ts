// Discord tests cover durable gateway-message admission and replay recovery.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ChannelType, type APIMessage } from "discord-api-types/v10";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
} from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import type { ChannelIngressQueue } from "openclaw/plugin-sdk/channel-outbound";
import type { DiscordAccountConfig, OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
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

const DISCORD_INGRESS_WAIT_TIMEOUT_MS = 10_000;
// Pre-claim stale checks lazily import the mention runtime on first use. Warming
// it outside the dispatch waits keeps a cold module graph from being charged to
// whichever test happens to evaluate stale ambient backlog first.
const DISCORD_INGRESS_RUNTIME_WARM_TIMEOUT_MS = 120_000;

function createRawMessage(
  id: string,
  channelId = "channel-1",
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

function runtime(): Pick<RuntimeEnv, "error" | "log"> {
  return { error: vi.fn(), log: vi.fn() };
}

function payloadFor(rawMessage: APIMessage, receivedAt = Date.now()): DiscordIngressPayload {
  return { version: 1, receivedAt, rawMessage };
}

async function withQueue<T>(
  fn: (queue: ChannelIngressQueue<DiscordIngressPayload>) => Promise<T>,
  options: { now?: () => number } = {},
): Promise<T> {
  const created = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-discord-ingress-"));
  const stateDir = await fs.realpath(created);
  const queue = createChannelIngressQueueForTests<DiscordIngressPayload>({
    channelId: "discord",
    accountId: "default",
    stateDir,
    ...(options.now ? { now: options.now } : {}),
  });
  try {
    return await fn(queue);
  } finally {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

type DiscordIngressMonitor = ReturnType<typeof createDiscordIngressMonitor>;
type DiscordThreadBindings = Parameters<typeof createDiscordIngressMonitor>[0]["threadBindings"];
type DiscordGuildEntries = Record<string, DiscordGuildEntryResolved>;

async function stopAll(monitors: DiscordIngressMonitor[]): Promise<void> {
  await Promise.allSettled(monitors.map((monitor) => monitor.stop()));
}

async function expectStaleMessageDispatches(params: {
  rawMessage: APIMessage;
  botUserId?: string;
  cfg?: OpenClawConfig;
  discordConfig?: DiscordAccountConfig;
  guildEntries?: DiscordGuildEntries;
  threadBindings?: DiscordThreadBindings;
  now?: () => number;
}): Promise<void> {
  await withQueue(
    async (queue) => {
      const messageId = params.rawMessage.id;
      const sentAt = Date.parse(params.rawMessage.timestamp);
      const receivedAt = Number.isFinite(sentAt) ? sentAt : (params.now?.() ?? Date.now());
      await queue.enqueue(messageId, payloadFor(params.rawMessage, receivedAt), {
        laneKey: `channel:${params.rawMessage.channel_id}`,
        receivedAt,
      });

      const dispatched: string[] = [];
      const monitor = createDiscordIngressMonitor({
        accountId: "default",
        client: {} as never,
        runtime: runtime(),
        botUserId: params.botUserId ?? "bot-1",
        ...(params.cfg ? { cfg: params.cfg } : {}),
        ...(params.discordConfig ? { discordConfig: params.discordConfig } : {}),
        ...(params.guildEntries ? { guildEntries: params.guildEntries } : {}),
        ...(params.threadBindings ? { threadBindings: params.threadBindings } : {}),
        ...(params.now ? { now: params.now } : {}),
        queue,
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
        await vi.waitFor(() => expect(dispatched).toEqual([messageId]), {
          timeout: DISCORD_INGRESS_WAIT_TIMEOUT_MS,
        });
        expect(await queue.listFailed?.({ limit: "all" })).toEqual([]);
      } finally {
        await monitor.stop();
      }
    },
    params.now ? { now: params.now } : {},
  );
}

async function expectStaleMessageFailsAsAmbient(params: {
  rawMessage: APIMessage;
  botUserId?: string;
  cfg?: OpenClawConfig;
  discordConfig?: DiscordAccountConfig;
  guildEntries?: DiscordGuildEntries;
  threadBindings?: DiscordThreadBindings;
  now?: () => number;
}): Promise<void> {
  await withQueue(
    async (queue) => {
      const messageId = params.rawMessage.id;
      const sentAt = Date.parse(params.rawMessage.timestamp);
      const receivedAt = Number.isFinite(sentAt) ? sentAt : (params.now?.() ?? Date.now());
      await queue.enqueue(messageId, payloadFor(params.rawMessage, receivedAt), {
        laneKey: `channel:${params.rawMessage.channel_id}`,
        receivedAt,
      });

      const dispatch = vi.fn(async (_event, lifecycle: DiscordIngressLifecycle) => {
        await lifecycle.onAdopted();
      });
      const monitor = createDiscordIngressMonitor({
        accountId: "default",
        client: {} as never,
        runtime: runtime(),
        botUserId: params.botUserId ?? "bot-1",
        ...(params.cfg ? { cfg: params.cfg } : {}),
        ...(params.discordConfig ? { discordConfig: params.discordConfig } : {}),
        ...(params.guildEntries ? { guildEntries: params.guildEntries } : {}),
        ...(params.threadBindings ? { threadBindings: params.threadBindings } : {}),
        ...(params.now ? { now: params.now } : {}),
        queue,
        dispatch,
      });
      monitor.start();
      try {
        await vi.waitFor(
          async () => {
            expect(await queue.listFailed?.({ limit: "all" })).toMatchObject([
              { id: messageId, reason: "stale-ambient-backlog" },
            ]);
          },
          { timeout: DISCORD_INGRESS_WAIT_TIMEOUT_MS },
        );
        expect(dispatch).not.toHaveBeenCalled();
      } finally {
        await monitor.stop();
      }
    },
    params.now ? { now: params.now } : {},
  );
}

describe("Discord durable ingress", () => {
  beforeAll(async () => {
    await import("openclaw/plugin-sdk/channel-inbound");
  }, DISCORD_INGRESS_RUNTIME_WARM_TIMEOUT_MS);

  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
  });

  it("does not normalize or dispatch before the durable append completes", async () => {
    await withQueue(async (queue) => {
      const appendGate = createDeferred<void>();
      const enqueue = vi.fn(async (...args: Parameters<typeof queue.enqueue>) => {
        await appendGate.promise;
        return await queue.enqueue(...args);
      });
      const gatedQueue: ChannelIngressQueue<DiscordIngressPayload> = { ...queue, enqueue };
      const dispatch = vi.fn(async (_event, lifecycle: DiscordIngressLifecycle) => {
        await lifecycle.onAdopted();
      });
      const monitor = createDiscordIngressMonitor({
        accountId: "default",
        client: {} as never,
        runtime: runtime(),
        queue: gatedQueue,
        dispatch,
      });
      monitor.start();
      try {
        const accepted = monitor.accept(createRawMessage("1001"));
        await vi.waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1));

        expect(dispatch).not.toHaveBeenCalled();

        appendGate.resolve();
        await accepted;
        await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
      } finally {
        await monitor.stop();
      }
    });
  });

  it("rejects unstable message identity before durable allocation", async () => {
    await withQueue(async (queue) => {
      const dispatch = vi.fn();
      const monitor = createDiscordIngressMonitor({
        accountId: "default",
        client: {} as never,
        runtime: runtime(),
        queue,
        dispatch,
      });
      monitor.start();
      try {
        const missingMessageId = { ...createRawMessage("missing"), id: undefined };
        const missingChannelId = { ...createRawMessage("missing"), channel_id: undefined };

        await expect(monitor.accept(missingMessageId as never)).rejects.toThrow("snowflake");
        await expect(monitor.accept(missingChannelId as never)).rejects.toThrow("channel_id");
        expect(await queue.listPending({ limit: "all" })).toEqual([]);
        expect(dispatch).not.toHaveBeenCalled();
      } finally {
        await monitor.stop();
      }
    });
  });

  it("recovers a claimed row with a fresh drain and dispatches it exactly once", async () => {
    await withQueue(async (queue) => {
      const monitors: DiscordIngressMonitor[] = [];
      const firstDispatch = vi.fn(async () => ({ kind: "deferred" as const }));
      const first = createDiscordIngressMonitor({
        accountId: "default",
        client: {} as never,
        runtime: runtime(),
        queue,
        dispatch: firstDispatch,
      });
      monitors.push(first);
      first.start();
      try {
        await first.accept(createRawMessage("1002"));
        await vi.waitFor(() => expect(firstDispatch).toHaveBeenCalledTimes(1));
        await first.stop();

        const recoveredDispatch = vi.fn(async (_event, lifecycle: DiscordIngressLifecycle) => {
          await lifecycle.onAdopted();
        });
        const recovered = createDiscordIngressMonitor({
          accountId: "default",
          client: {} as never,
          runtime: runtime(),
          queue,
          dispatch: recoveredDispatch,
        });
        monitors.push(recovered);
        recovered.start();

        await vi.waitFor(() => expect(recoveredDispatch).toHaveBeenCalledTimes(1));
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 25);
        });
        expect(recoveredDispatch).toHaveBeenCalledTimes(1);
      } finally {
        await stopAll(monitors);
      }
    });
  });

  it("rejects a duplicate after completion", async () => {
    await withQueue(async (queue) => {
      const dispatch = vi.fn(async (_event, lifecycle: DiscordIngressLifecycle) => {
        await lifecycle.onAdopted();
      });
      const monitor = createDiscordIngressMonitor({
        accountId: "default",
        client: {} as never,
        runtime: runtime(),
        queue,
        dispatch,
      });
      monitor.start();
      try {
        const rawMessage = createRawMessage("1003");
        await monitor.accept(rawMessage);
        await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
        await vi.waitFor(async () => {
          const verdict = await queue.enqueue("1003", payloadFor(rawMessage));
          expect(verdict.kind).toBe("completed");
        });

        await monitor.accept(rawMessage);
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 25);
        });
        expect(dispatch).toHaveBeenCalledTimes(1);
      } finally {
        await monitor.stop();
      }
    });
  });

  it("matches the old guard for duplicate MESSAGE_CREATE delivery during RESUME", async () => {
    await withQueue(async (queue) => {
      let lifecycle: DiscordIngressLifecycle | undefined;
      const dispatch = vi.fn(async (_event, claimedLifecycle: DiscordIngressLifecycle) => {
        lifecycle = claimedLifecycle;
        return { kind: "deferred" as const };
      });
      const monitor = createDiscordIngressMonitor({
        accountId: "default",
        client: {} as never,
        runtime: runtime(),
        queue,
        dispatch,
      });
      monitor.start();
      try {
        const replayed = createRawMessage("1004");
        await Promise.all([monitor.accept(replayed), monitor.accept(replayed)]);
        await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));

        await lifecycle?.onAdopted();
        await vi.waitFor(async () => {
          const verdict = await queue.enqueue("1004", payloadFor(replayed));
          expect(verdict.kind).toBe("completed");
        });
        expect(dispatch).toHaveBeenCalledTimes(1);
      } finally {
        await monitor.stop();
      }
    });
  });

  it("dead-letters a permanent Discord authentication failure", async () => {
    await withQueue(async (queue) => {
      const monitor = createDiscordIngressMonitor({
        accountId: "default",
        client: {} as never,
        runtime: runtime(),
        queue,
        dispatch: async () => {
          throw Object.assign(new Error("unauthorized"), { status: 401 });
        },
      });
      monitor.start();
      try {
        const rawMessage = createRawMessage("1005");
        await monitor.accept(rawMessage);
        await vi.waitFor(async () => {
          const verdict = await queue.enqueue("1005", payloadFor(rawMessage));
          expect(verdict.kind).toBe("failed");
        });
      } finally {
        await monitor.stop();
      }
    });
  });

  it("suppresses stale ambient guild backlog before dispatching a fresh bot mention", async () => {
    await withQueue(async (queue) => {
      const now = Date.now();
      const stale = createRawMessage("1006", "channel-1", {
        guild_id: "guild-1",
        channel_type: ChannelType.GuildText,
        timestamp: new Date(now - 16 * 60 * 1_000).toISOString(),
      } as Partial<APIMessage>);
      const fresh = createRawMessage("1007", "channel-1", {
        guild_id: "guild-1",
        content: "hello <@bot-1>",
        mentions: [{ id: "bot-1" }] as APIMessage["mentions"],
        timestamp: new Date(now).toISOString(),
      } as Partial<APIMessage>);
      await queue.enqueue("1006", payloadFor(stale), {
        laneKey: "channel:channel-1",
        receivedAt: now - 16 * 60 * 1_000,
      });
      await queue.enqueue("1007", payloadFor(fresh), {
        laneKey: "channel:channel-1",
        receivedAt: now,
      });

      const dispatched: string[] = [];
      const monitor = createDiscordIngressMonitor({
        accountId: "default",
        client: {} as never,
        runtime: runtime(),
        botUserId: "bot-1",
        queue,
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
        await vi.waitFor(() => expect(dispatched).toEqual(["1007"]));
        expect(await queue.listFailed?.({ limit: "all" })).toMatchObject([
          { id: "1006", reason: "stale-ambient-backlog" },
        ]);
      } finally {
        await monitor.stop();
      }
    });
  });

  it("keeps stale bot mentions out of ambient backlog suppression", async () => {
    await withQueue(async (queue) => {
      const now = Date.now();
      const mentioned = createRawMessage("1008", "channel-1", {
        guild_id: "guild-1",
        content: "old but direct <@bot-1>",
        mentions: [{ id: "bot-1" }] as APIMessage["mentions"],
        timestamp: new Date(now - 16 * 60 * 1_000).toISOString(),
      } as Partial<APIMessage>);
      await queue.enqueue("1008", payloadFor(mentioned), {
        laneKey: "channel:channel-1",
        receivedAt: now - 16 * 60 * 1_000,
      });

      const dispatched: string[] = [];
      const monitor = createDiscordIngressMonitor({
        accountId: "default",
        client: {} as never,
        runtime: runtime(),
        botUserId: "bot-1",
        queue,
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
        await vi.waitFor(() => expect(dispatched).toEqual(["1008"]));
        expect(await queue.listFailed?.({ limit: "all" })).toEqual([]);
      } finally {
        await monitor.stop();
      }
    });
  });

  it("keeps stale replies to the bot out of ambient backlog suppression", async () => {
    await withQueue(async (queue) => {
      const now = Date.now();
      const referencedBotMessage = createRawMessage("bot-reply-source", "channel-1", {
        guild_id: "guild-1",
        author: {
          id: "bot-1",
          username: "openclaw",
          discriminator: "0",
          global_name: null,
          avatar: null,
          bot: true,
        },
      } as Partial<APIMessage>);
      const reply = createRawMessage("1009", "channel-1", {
        guild_id: "guild-1",
        content: "old but explicit reply",
        referenced_message: referencedBotMessage,
        timestamp: new Date(now - 16 * 60 * 1_000).toISOString(),
      } as Partial<APIMessage>);
      await queue.enqueue("1009", payloadFor(reply), {
        laneKey: "channel:channel-1",
        receivedAt: now - 16 * 60 * 1_000,
      });

      const dispatched: string[] = [];
      const monitor = createDiscordIngressMonitor({
        accountId: "default",
        client: {} as never,
        runtime: runtime(),
        botUserId: "bot-1",
        queue,
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
        await vi.waitFor(() => expect(dispatched).toEqual(["1009"]));
        expect(await queue.listFailed?.({ limit: "all" })).toEqual([]);
      } finally {
        await monitor.stop();
      }
    });
  });

  it("keeps stale direct messages out of ambient backlog suppression", async () => {
    await withQueue(async (queue) => {
      const now = Date.now();
      const direct = createRawMessage("1010", "dm-1", {
        content: "old direct message",
        timestamp: new Date(now - 16 * 60 * 1_000).toISOString(),
      } as Partial<APIMessage>);
      await queue.enqueue("1010", payloadFor(direct), {
        laneKey: "channel:dm-1",
        receivedAt: now - 16 * 60 * 1_000,
      });

      const dispatched: string[] = [];
      const monitor = createDiscordIngressMonitor({
        accountId: "default",
        client: {} as never,
        runtime: runtime(),
        botUserId: "bot-1",
        queue,
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
        await vi.waitFor(() => expect(dispatched).toEqual(["1010"]));
        expect(await queue.listFailed?.({ limit: "all" })).toEqual([]);
      } finally {
        await monitor.stop();
      }
    });
  });

  it("keeps stale bound-thread messages out of ambient backlog suppression", async () => {
    await withQueue(async (queue) => {
      const now = Date.now();
      const boundThreadMessage = createRawMessage("1011", "thread-bound-1", {
        guild_id: "guild-1",
        content: "old bound thread follow-up without mention",
        timestamp: new Date(now - 16 * 60 * 1_000).toISOString(),
      } as Partial<APIMessage>);
      await queue.enqueue("1011", payloadFor(boundThreadMessage), {
        laneKey: "channel:thread-bound-1",
        receivedAt: now - 16 * 60 * 1_000,
      });

      const dispatched: string[] = [];
      const monitor = createDiscordIngressMonitor({
        accountId: "default",
        client: {} as never,
        runtime: runtime(),
        botUserId: "bot-1",
        threadBindings: {
          getByThreadId: (threadId) =>
            threadId === "thread-bound-1" ? { threadId, targetSessionKey: "agent:main" } : null,
        },
        queue,
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
        await vi.waitFor(() => expect(dispatched).toEqual(["1011"]));
        expect(await queue.listFailed?.({ limit: "all" })).toEqual([]);
      } finally {
        await monitor.stop();
      }
    });
  });

  it("keeps stale cached thread-channel messages out of ambient backlog suppression", async () => {
    await withQueue(async (queue) => {
      const now = Date.now();
      const cachedThreadMessage = createRawMessage("1012", "thread-cached-1", {
        guild_id: "guild-1",
        channel: {
          id: "thread-cached-1",
          type: ChannelType.PublicThread,
          parent_id: "channel-1",
        },
        content: "old cached thread follow-up without mention",
        timestamp: new Date(now - 16 * 60 * 1_000).toISOString(),
      });
      await queue.enqueue("1012", payloadFor(cachedThreadMessage), {
        laneKey: "channel:thread-cached-1",
        receivedAt: now - 16 * 60 * 1_000,
      });

      const dispatched: string[] = [];
      const monitor = createDiscordIngressMonitor({
        accountId: "default",
        client: {} as never,
        runtime: runtime(),
        botUserId: "bot-1",
        queue,
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
        await vi.waitFor(() => expect(dispatched).toEqual(["1012"]));
        expect(await queue.listFailed?.({ limit: "all" })).toEqual([]);
      } finally {
        await monitor.stop();
      }
    });
  });

  it.each([
    {
      name: "configured text-mention policy",
      id: "1013",
      channelId: "channel-mentions-1",
      content: "openclaw can you check the incident",
      cfg: { messages: { groupChat: { mentionPatterns: ["openclaw"] } } } satisfies OpenClawConfig,
    },
    {
      name: "provider-level Discord mention policy",
      id: "1014",
      channelId: "channel-provider-mentions-1",
      content: "Policy Bot can you check the incident?",
      cfg: {
        agents: { list: [{ id: "main", identity: { name: "Policy Bot" } }] },
      } satisfies OpenClawConfig,
      discordConfig: {
        mentionPatterns: { mode: "deny", allowIn: ["channel-provider-mentions-1"] },
      } satisfies DiscordAccountConfig,
    },
    {
      name: "identity-derived agent-name mention",
      id: "1015",
      channelId: "channel-agent-name-1",
      content: "Molty can you check the incident?",
      cfg: {
        agents: { list: [{ id: "main", identity: { name: "Molty" } }] },
      } satisfies OpenClawConfig,
    },
    {
      name: "identity-derived emoji mention",
      id: "1016",
      channelId: "channel-agent-emoji-1",
      content: "🦀 can you check the incident?",
      cfg: {
        agents: { list: [{ id: "main", identity: { emoji: "🦀" } }] },
      } satisfies OpenClawConfig,
    },
    {
      name: "everyone mention",
      id: "1017",
      channelId: "channel-everyone-1",
      content: "@everyone can someone check the incident?",
      overrides: { mention_everyone: true } satisfies RawMessageOverrides,
    },
    {
      name: "audio-only configured mention candidate",
      id: "1018",
      channelId: "channel-audio-mention-1",
      content: "",
      overrides: {
        attachments: [
          {
            id: "att-1",
            filename: "voice.ogg",
            url: "https://cdn.discordapp.com/attachments/voice.ogg",
            proxy_url: "https://cdn.discordapp.com/attachments/voice.ogg",
            content_type: "audio/ogg",
            size: 1024,
          },
        ],
      } satisfies RawMessageOverrides,
      cfg: { messages: { groupChat: { mentionPatterns: ["openclaw"] } } } satisfies OpenClawConfig,
    },
  ])("keeps stale $name messages out of ambient backlog suppression", async (testCase) => {
    const now = Date.now();
    await expectStaleMessageDispatches({
      rawMessage: createRawMessage(testCase.id, testCase.channelId, {
        guild_id: "guild-1",
        content: testCase.content,
        timestamp: new Date(now - 16 * 60 * 1_000).toISOString(),
        ...testCase.overrides,
      } as RawMessageOverrides),
      cfg: testCase.cfg,
      discordConfig: testCase.discordConfig,
    });
  });

  it("keeps stale text control commands out of ambient backlog suppression", async () => {
    const now = Date.now();
    await expectStaleMessageDispatches({
      rawMessage: createRawMessage("1019", "channel-control-1", {
        guild_id: "guild-1",
        content: "/status",
        timestamp: new Date(now - 16 * 60 * 1_000).toISOString(),
      } as Partial<APIMessage>),
      cfg: {} satisfies OpenClawConfig,
    });
  });

  it("still suppresses stale ambient content when configured agent identity does not match", async () => {
    const now = Date.now();
    await expectStaleMessageFailsAsAmbient({
      rawMessage: createRawMessage("1020", "channel-unmatched-identity-1", {
        guild_id: "guild-1",
        channel_type: ChannelType.GuildText,
        content: "unrelated room chatter",
        timestamp: new Date(now - 16 * 60 * 1_000).toISOString(),
      } as Partial<APIMessage>),
      cfg: {
        agents: { list: [{ id: "main", identity: { name: "Molty", emoji: "🦀" } }] },
      } satisfies OpenClawConfig,
    });
  });

  it("still suppresses stale ambient content when provider policy disables identity matches", async () => {
    const now = Date.now();
    await expectStaleMessageFailsAsAmbient({
      rawMessage: createRawMessage("1021", "channel-denied-identity-1", {
        guild_id: "guild-1",
        channel_type: ChannelType.GuildText,
        content: "Molty can you check the incident?",
        timestamp: new Date(now - 16 * 60 * 1_000).toISOString(),
      } as Partial<APIMessage>),
      cfg: {
        agents: { list: [{ id: "main", identity: { name: "Molty" } }] },
      } satisfies OpenClawConfig,
      discordConfig: {
        mentionPatterns: { mode: "allow", denyIn: ["channel-denied-identity-1"] },
      } satisfies DiscordAccountConfig,
    });
  });

  it("keeps stale ordinary guild text with no direct raw channel facts fail-open", async () => {
    const now = Date.now();
    await expectStaleMessageDispatches({
      rawMessage: createRawMessage("1022", "channel-open-guild-1", {
        guild_id: "guild-1",
        content: "ordinary old room text",
        timestamp: new Date(now - 16 * 60 * 1_000).toISOString(),
      } as Partial<APIMessage>),
      guildEntries: {
        "guild-1": { requireMention: false },
      },
    });
  });

  it("still suppresses stale ambient content when channel config proves mention-required", async () => {
    const now = Date.now();
    await expectStaleMessageFailsAsAmbient({
      rawMessage: createRawMessage("1024", "channel-require-mention-1", {
        guild_id: "guild-1",
        channel_type: ChannelType.GuildText,
        content: "old unmentioned room text",
        timestamp: new Date(now - 16 * 60 * 1_000).toISOString(),
      } as Partial<APIMessage>),
      guildEntries: {
        "guild-1": {
          channels: {
            "channel-require-mention-1": { enabled: true, requireMention: true },
          },
        },
      },
    });
  });

  it("keeps stale unhydrated thread rows out of guild-default ambient suppression", async () => {
    const now = Date.now();
    await expectStaleMessageDispatches({
      rawMessage: createRawMessage("1026", "thread-unhydrated-1", {
        guild_id: "guild-1",
        content: "old unmentioned thread follow-up",
        timestamp: new Date(now - 16 * 60 * 1_000).toISOString(),
      } as Partial<APIMessage>),
      guildEntries: {
        "guild-1": { requireMention: true },
      },
    });
  });

  it("emits one payload-free structured debug receipt for stale ambient suppression", async () => {
    await withQueue(async (queue) => {
      const now = Date.now();
      const rawMessage = createRawMessage("1025", "channel-debug-1", {
        guild_id: "guild-1",
        channel_type: ChannelType.GuildText,
        content: "old room history must not be logged",
        timestamp: new Date(now - 16 * 60 * 1_000).toISOString(),
      } as Partial<APIMessage>);
      await queue.enqueue("1025", payloadFor(rawMessage), {
        laneKey: "channel:channel-debug-1",
        receivedAt: now - 16 * 60 * 1_000,
      });

      const log = vi.fn();
      const monitor = createDiscordIngressMonitor({
        accountId: "default",
        client: {} as never,
        runtime: { error: vi.fn(), log },
        botUserId: "bot-1",
        queue,
        dispatch: vi.fn(async (_event, lifecycle: DiscordIngressLifecycle) => {
          await lifecycle.onAdopted();
        }),
      });
      monitor.start();
      try {
        await vi.waitFor(async () => {
          expect(await queue.listFailed?.({ limit: "all" })).toMatchObject([
            { id: "1025", reason: "stale-ambient-backlog" },
          ]);
        });
        expect(log).toHaveBeenCalledTimes(1);
        expect(log).toHaveBeenCalledWith(
          expect.objectContaining({
            level: "debug",
            source: "discord",
            accountId: "default",
            eventId: "1025",
            sourceEventId: "1025",
            laneKey: "channel:channel-debug-1",
            channelId: "channel-debug-1",
            thresholdMs: 15 * 60 * 1_000,
            disposition: "failed",
            reason: "stale-ambient-backlog",
          }),
          "discord ingress stale ambient backlog suppressed",
        );
        const receipt = log.mock.calls[0]?.[0];
        expect(receipt).not.toHaveProperty("content");
        expect(JSON.stringify(receipt)).not.toContain("old room history");
      } finally {
        await monitor.stop();
      }
    });
  });

  it("does not emit a stale suppression receipt when the durable fail loses its race", async () => {
    await withQueue(async (queue) => {
      const now = Date.now();
      const rawMessage = createRawMessage("1027", "channel-cas-loss-1", {
        guild_id: "guild-1",
        channel_type: ChannelType.GuildText,
        content: "old room history must not be logged",
        timestamp: new Date(now - 16 * 60 * 1_000).toISOString(),
      } as Partial<APIMessage>);
      await queue.enqueue("1027", payloadFor(rawMessage), {
        laneKey: "channel:channel-cas-loss-1",
        receivedAt: now - 16 * 60 * 1_000,
      });

      const fail = vi.fn(async (...args: Parameters<typeof queue.fail>) => {
        const peerClaim = await queue.claim("1027", { ownerId: "peer-drain" });
        expect(peerClaim).not.toBeNull();
        if (peerClaim) {
          await queue.release(peerClaim, { recordAttempt: false });
        }
        expect(args[0]).toBe("1027");
        return false;
      });
      const log = vi.fn();
      const monitor = createDiscordIngressMonitor({
        accountId: "default",
        client: {} as never,
        runtime: { error: vi.fn(), log },
        botUserId: "bot-1",
        queue: { ...queue, fail },
        dispatch: vi.fn(async (_event, lifecycle: DiscordIngressLifecycle) => {
          await lifecycle.onAdopted();
        }),
      });
      monitor.start();
      try {
        await vi.waitFor(() => expect(fail).toHaveBeenCalledTimes(1));
        expect(log).not.toHaveBeenCalled();
      } finally {
        await monitor.stop();
      }
    });
  });

  it("does not emit a stale suppression receipt when the durable fail write throws", async () => {
    await withQueue(async (queue) => {
      const now = Date.now();
      const rawMessage = createRawMessage("1028", "channel-fail-throws-1", {
        guild_id: "guild-1",
        channel_type: ChannelType.GuildText,
        content: "old room history must not be logged",
        timestamp: new Date(now - 16 * 60 * 1_000).toISOString(),
      } as Partial<APIMessage>);
      await queue.enqueue("1028", payloadFor(rawMessage), {
        laneKey: "channel:channel-fail-throws-1",
        receivedAt: now - 16 * 60 * 1_000,
      });

      const fail = vi.fn(async () => {
        throw new Error("simulated durable fail write outage");
      });
      const log = vi.fn();
      const monitor = createDiscordIngressMonitor({
        accountId: "default",
        client: {} as never,
        runtime: { error: vi.fn(), log },
        botUserId: "bot-1",
        queue: { ...queue, fail },
        dispatch: vi.fn(async (_event, lifecycle: DiscordIngressLifecycle) => {
          await lifecycle.onAdopted();
        }),
      });
      monitor.start();
      try {
        await vi.waitFor(() => expect(fail).toHaveBeenCalledTimes(1));
        expect(log).not.toHaveBeenCalled();
      } finally {
        await monitor.stop();
      }
    });
  });

  it("does not emit duplicate stale suppression receipts for repeated delivery", async () => {
    await withQueue(async (queue) => {
      const now = Date.now();
      const rawMessage = createRawMessage("1029", "channel-duplicate-debug-1", {
        guild_id: "guild-1",
        channel_type: ChannelType.GuildText,
        content: "old duplicate room history must not be logged",
        timestamp: new Date(now - 16 * 60 * 1_000).toISOString(),
      } as Partial<APIMessage>);
      await queue.enqueue("1029", payloadFor(rawMessage), {
        laneKey: "channel:channel-duplicate-debug-1",
        receivedAt: now - 16 * 60 * 1_000,
      });

      const log = vi.fn();
      const monitor = createDiscordIngressMonitor({
        accountId: "default",
        client: {} as never,
        runtime: { error: vi.fn(), log },
        botUserId: "bot-1",
        queue,
        dispatch: vi.fn(async (_event, lifecycle: DiscordIngressLifecycle) => {
          await lifecycle.onAdopted();
        }),
      });
      monitor.start();
      try {
        await vi.waitFor(async () => {
          expect(await queue.listFailed?.({ limit: "all" })).toMatchObject([
            { id: "1029", reason: "stale-ambient-backlog" },
          ]);
        });
        expect(log).toHaveBeenCalledTimes(1);

        await monitor.accept(rawMessage);
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 25);
        });
        expect(log).toHaveBeenCalledTimes(1);
      } finally {
        await monitor.stop();
      }
    });
  });
});
