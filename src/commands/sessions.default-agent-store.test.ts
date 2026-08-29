// Sessions default-agent store tests cover default session-store selection and runtime config loading.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";

type AcpSessionMetaBatchParams = {
  entries: Array<{ sessionKey: string; entry: Record<string, unknown> }>;
};

const loadConfigMock = vi.hoisted(() => vi.fn());

const resolveStorePathMock = vi.hoisted(() =>
  vi.fn((_store: string | undefined, opts?: { agentId?: string }) => {
    return `/tmp/sessions-${opts?.agentId ?? "missing"}.json`;
  }),
);
const listSessionEntriesMock = vi.hoisted(() =>
  vi.fn<() => Array<{ sessionKey: string; entry: Record<string, unknown> }>>(() => []),
);
const readAcpSessionMetaBatchMock = vi.hoisted(() =>
  vi.fn((_params: AcpSessionMetaBatchParams) => new Map()),
);

vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  return {
    ...actual,
    getRuntimeConfig: loadConfigMock,
    loadConfig: loadConfigMock,
  };
});

vi.mock("../config/sessions.js", async () => {
  const actual =
    await vi.importActual<typeof import("../config/sessions.js")>("../config/sessions.js");
  return {
    ...actual,
    resolveSessionStorePathCore: resolveStorePathMock,
  };
});

vi.mock("../config/sessions/session-accessor.js", () => ({
  listSessionEntriesCore: listSessionEntriesMock,
  listSessionEntriesReadOnly: listSessionEntriesMock,
}));

vi.mock("../acp/runtime/session-meta.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../acp/runtime/session-meta.js")>()),
  readAcpSessionMetaBatch: readAcpSessionMetaBatchMock,
}));

import { sessionsCommand } from "./sessions.js";

function toSessionEntrySummaries(store: Record<string, Record<string, unknown>>) {
  return Object.entries(store).map(([sessionKey, entry]) => ({ sessionKey, entry }));
}

function createSessionsConfig(store = "/tmp/sessions-{agentId}.json") {
  return {
    agents: {
      defaults: {
        model: { primary: "test:opus" },
        models: { "test:opus": {} },
      },
      list: [
        { id: "main", default: false },
        { id: "voice", default: true },
      ],
    },
    session: { store },
  };
}

function createRuntime(): { runtime: RuntimeEnv; logs: string[] } {
  const logs: string[] = [];
  return {
    runtime: {
      log: (msg: unknown) => logs.push(String(msg)),
      error: vi.fn(),
      exit: vi.fn(),
    },
    logs,
  };
}

describe("sessionsCommand default store agent selection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadConfigMock.mockImplementation(() => createSessionsConfig());
    resolveStorePathMock.mockImplementation(
      (_store: string | undefined, opts?: { agentId?: string }) => {
        return `/tmp/sessions-${opts?.agentId ?? "missing"}.json`;
      },
    );
    listSessionEntriesMock.mockImplementation(() => []);
  });

  it("includes agentId on sessions rows for --all-agents JSON output", async () => {
    resolveStorePathMock.mockClear();
    listSessionEntriesMock.mockReset();
    listSessionEntriesMock
      .mockReturnValueOnce(
        toSessionEntrySummaries({
          main_row: { sessionId: "s1", updatedAt: Date.now() - 60_000, model: "test:opus" },
        }),
      )
      .mockReturnValueOnce(
        toSessionEntrySummaries({
          voice_row: { sessionId: "s2", updatedAt: Date.now() - 120_000, model: "test:opus" },
        }),
      );
    const { runtime, logs } = createRuntime();

    await sessionsCommand({ allAgents: true, json: true }, runtime);

    const payload = JSON.parse(logs[0] ?? "{}") as {
      allAgents?: boolean;
      sessions?: Array<{ key: string; agentId?: string }>;
    };
    expect(payload.allAgents).toBe(true);
    expect(payload.sessions?.map((session) => session.agentId)).toContain("main");
    expect(payload.sessions?.map((session) => session.agentId)).toContain("voice");
  });

  it("lists each SQLite owner when --all-agents resolves to a shared store path", async () => {
    loadConfigMock.mockImplementation(() => createSessionsConfig("/tmp/shared-sessions.json"));
    listSessionEntriesMock.mockReset();
    listSessionEntriesMock
      .mockReturnValueOnce(
        toSessionEntrySummaries({
          "agent:main:room": {
            sessionId: "s1",
            updatedAt: Date.now() - 60_000,
            model: "test:opus",
          },
        }),
      )
      .mockReturnValueOnce(
        toSessionEntrySummaries({
          "agent:voice:room": {
            sessionId: "s2",
            updatedAt: Date.now() - 30_000,
            model: "test:opus",
          },
        }),
      );
    const { runtime, logs } = createRuntime();

    await sessionsCommand({ allAgents: true, json: true }, runtime);

    const payload = JSON.parse(logs[0] ?? "{}") as {
      count?: number;
      stores?: Array<{ agentId: string; path: string }>;
      allAgents?: boolean;
      sessions?: Array<{ key: string; agentId?: string }>;
    };
    expect(payload.count).toBe(2);
    expect(payload.allAgents).toBe(true);
    expect(payload.stores).toEqual([
      { agentId: "main", path: "/tmp/shared-sessions.sqlite" },
      { agentId: "voice", path: "/tmp/shared-sessions.voice.sqlite" },
    ]);
    expect(payload.sessions?.map((session) => session.agentId).toSorted()).toEqual([
      "main",
      "voice",
    ]);
    expect(listSessionEntriesMock).toHaveBeenCalledTimes(2);
  });

  it("uses configured default agent id when resolving implicit session store path", async () => {
    listSessionEntriesMock.mockReset();
    listSessionEntriesMock.mockReturnValue([]);
    const { runtime, logs } = createRuntime();

    await sessionsCommand({}, runtime);

    expect(listSessionEntriesMock).toHaveBeenCalledWith({
      agentId: "voice",
      clone: false,
      projection: "list",
      storePath: "/tmp/sessions-voice.json",
    });
    expect(logs[0]).toContain("Session store: /tmp/sessions-voice.voice.sqlite");
  });

  it("selects a finite newest window before ACP enrichment", async () => {
    listSessionEntriesMock.mockReset();
    listSessionEntriesMock.mockReturnValue(
      toSessionEntrySummaries(
        Object.fromEntries(
          Array.from({ length: 1_000 }, (_, index) => [
            `agent:voice:session-${index}`,
            {
              sessionId: `session-${index}`,
              updatedAt: Date.now() - index,
              model: "test:opus",
            },
          ]),
        ),
      ),
    );
    const { runtime, logs } = createRuntime();

    await sessionsCommand({ json: true, limit: 1 }, runtime);

    const payload = JSON.parse(logs[0] ?? "{}") as {
      count?: number;
      totalCount?: number;
      hasMore?: boolean;
      sessions?: Array<{ key: string }>;
    };
    expect(payload).toMatchObject({
      count: 1,
      totalCount: 1_000,
      hasMore: true,
      sessions: [{ key: "agent:voice:session-0" }],
    });
    const batch = readAcpSessionMetaBatchMock.mock.calls.at(-1)?.[0];
    expect(batch?.entries).toEqual([
      {
        sessionKey: "agent:voice:session-0",
        entry: expect.objectContaining({ sessionId: "session-0" }),
      },
    ]);
    expect(listSessionEntriesMock).toHaveBeenCalledWith({
      agentId: "voice",
      clone: false,
      projection: "list",
      storePath: "/tmp/sessions-voice.json",
    });
  });

  it("names both supported escapes when an explicit roster has no session-list owner", async () => {
    loadConfigMock.mockReturnValue({
      agents: {
        ownership: "explicit",
        defaults: { systemAgent: { agentId: "main" } },
        entries: { main: {}, helper: {}, third: {} },
      },
    });
    const { runtime } = createRuntime();

    await sessionsCommand({}, runtime);

    expect(runtime.error).toHaveBeenCalledWith(
      "Multiple agents are configured, but session-store selection has no explicit owner. Pass --agent <id> to select one agent, or --all-agents to include every configured agent.",
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("uses all configured agent stores with --all-agents", async () => {
    listSessionEntriesMock.mockReset();
    listSessionEntriesMock
      .mockReturnValueOnce(
        toSessionEntrySummaries({
          main_row: { sessionId: "s1", updatedAt: Date.now() - 60_000, model: "test:opus" },
        }),
      )
      .mockReturnValueOnce([]);
    const { runtime, logs } = createRuntime();

    await sessionsCommand({ allAgents: true }, runtime);

    expect(listSessionEntriesMock).toHaveBeenNthCalledWith(1, {
      agentId: "main",
      clone: false,
      projection: "list",
      storePath: "/tmp/sessions-main.json",
    });
    expect(listSessionEntriesMock).toHaveBeenNthCalledWith(2, {
      agentId: "voice",
      clone: false,
      projection: "list",
      storePath: "/tmp/sessions-voice.json",
    });
    expect(logs[0]).toContain("Session stores: 2 (main, voice)");
    expect(logs[2]).toContain("Agent");
  });
});
