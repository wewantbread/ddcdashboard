// Matrix tests cover isSelf marking on the message read path.
import { describe, expect, it, vi } from "vitest";
import type { MatrixClient } from "../sdk.js";
import { readMatrixMessages } from "./messages.js";

function createHistoryMessage(params: {
  eventId: string;
  body: string;
  timestamp: number;
  sender: string;
}): Record<string, unknown> {
  return {
    event_id: params.eventId,
    sender: params.sender,
    type: "m.room.message",
    origin_server_ts: params.timestamp,
    content: { msgtype: "m.text", body: params.body },
  };
}

function createMessagesClient(params: {
  chunk: Array<Record<string, unknown>>;
  pollRoot?: Record<string, unknown>;
  threadRelations?: Array<Record<string, unknown>>;
  selfUserId?: string;
  omitGetUserId?: boolean;
}) {
  const doRequest = vi.fn(async () => ({ chunk: params.chunk, start: "s", end: "e" }));
  const hydrateEvents = vi.fn(
    async (_roomId: string, events: Array<Record<string, unknown>>) => events,
  );
  const getEvent = vi.fn(async (_roomId: string, eventId: string) =>
    params.pollRoot?.event_id === eventId ? params.pollRoot : null,
  );
  const getRelations = vi.fn(async () => ({
    events: params.threadRelations ?? [],
    nextBatch: null,
    prevBatch: null,
  }));
  const client: Record<string, unknown> = {
    doRequest,
    hydrateEvents,
    getEvent,
    getRelations,
    stop: vi.fn(),
  };
  if (!params.omitGetUserId) {
    client.getUserId = vi.fn(async () => params.selfUserId);
  }
  return client as unknown as MatrixClient;
}

describe("readMatrixMessages isSelf marking", () => {
  it.each([
    { sender: "@bot:example.org", expectedIsSelf: true, label: "the reading agent's own session" },
    { sender: "@glenn:example.org", expectedIsSelf: false, label: "a different sender" },
  ])("marks isSelf $expectedIsSelf for a message from $label, sender unchanged", async (tc) => {
    const client = createMessagesClient({
      chunk: [
        createHistoryMessage({ eventId: "$msg", body: "hi", timestamp: 10, sender: tc.sender }),
      ],
      selfUserId: "@bot:example.org",
    });

    const result = await readMatrixMessages("room:!room:example.org", { client });

    expect(result.messages[0]).toMatchObject({
      eventId: "$msg",
      sender: tc.sender,
      isSelf: tc.expectedIsSelf,
    });
  });

  it("omits isSelf (not false) when the client has no getUserId", async () => {
    const client = createMessagesClient({
      chunk: [
        createHistoryMessage({ eventId: "$msg", body: "hi", timestamp: 10, sender: "@a:x.org" }),
      ],
      omitGetUserId: true,
    });

    const result = await readMatrixMessages("room:!room:example.org", { client });

    expect(result.messages[0]?.isSelf).toBeUndefined();
    expect(result.messages[0]?.sender).toBe("@a:x.org");
  });

  it("omits isSelf without failing the read when getUserId() rejects", async () => {
    const client = createMessagesClient({
      chunk: [
        createHistoryMessage({ eventId: "$msg", body: "hi", timestamp: 10, sender: "@a:x.org" }),
      ],
    });
    (client as unknown as { getUserId: () => Promise<string> }).getUserId = vi
      .fn()
      .mockRejectedValue(new Error("no session"));

    const result = await readMatrixMessages("room:!room:example.org", { client });

    expect(result.messages[0]?.isSelf).toBeUndefined();
    expect(result.messages[0]?.sender).toBe("@a:x.org");
  });

  it("marks a thread root summary's isSelf from the resolved self user id", async () => {
    const client = createMessagesClient({
      chunk: [],
      pollRoot: {
        event_id: "$thread-root",
        sender: "@bot:example.org",
        type: "m.room.message",
        origin_server_ts: 10,
        content: { msgtype: "m.text", body: "thread root" },
      },
      threadRelations: [],
      selfUserId: "@bot:example.org",
    });

    const result = await readMatrixMessages("room:!room:example.org", {
      client,
      threadId: "$thread-root",
      limit: 5,
    });

    expect(result.messages[0]).toMatchObject({ eventId: "$thread-root", isSelf: true });
  });
});
