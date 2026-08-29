import { describe, expect, it } from "vitest";
import {
  getOwnedSessionTranscriptWriterFence,
  withOwnedSessionTranscriptWrites,
  type OwnedSessionTranscriptWriteContext,
} from "./transcript-write-context.js";

const passthroughWrite = async <T>(run: () => Promise<T> | T) => await run();

const ownedRunContext = (sessionKey: string): OwnedSessionTranscriptWriteContext => ({
  sessionFile: `/tmp/sessions/${sessionKey}.jsonl`,
  sessionKey,
  sessionTarget: {
    agentId: "main",
    sessionId: `session-${sessionKey}`,
    sessionKey,
    storePath: "/tmp/agents/main/agent/openclaw-agent.sqlite",
    expectedLifecycleRevision: "rev-1",
    expectedWriterRunId: `run-${sessionKey}`,
  },
  withTranscriptWrite: passthroughWrite,
});

describe("owned session transcript writer fence", () => {
  it("returns the admitted run claim for the owning session key", async () => {
    await withOwnedSessionTranscriptWrites(ownedRunContext("agent:main:discord:c:1"), async () => {
      expect(
        getOwnedSessionTranscriptWriterFence({ sessionKey: "agent:main:discord:c:1" }),
      ).toEqual({
        expectedLifecycleRevision: "rev-1",
        expectedWriterRunId: "run-agent:main:discord:c:1",
      });
    });
  });

  it("returns no claim for a different destination session key", async () => {
    await withOwnedSessionTranscriptWrites(ownedRunContext("agent:main:discord:c:1"), async () => {
      expect(
        getOwnedSessionTranscriptWriterFence({ sessionKey: "agent:main:discord:c:2" }),
      ).toBeUndefined();
    });
  });

  it("keeps matching the full store identity when the caller supplies a target", async () => {
    await withOwnedSessionTranscriptWrites(ownedRunContext("agent:main:discord:c:1"), async () => {
      expect(
        getOwnedSessionTranscriptWriterFence({
          sessionKey: "agent:main:discord:c:1",
          sessionTarget: {
            agentId: "main",
            sessionId: "session-agent:main:discord:c:1",
            sessionKey: "agent:main:discord:c:1",
            storePath: "/tmp/agents/main/agent/openclaw-agent.sqlite",
          },
        }),
      ).toEqual({
        expectedLifecycleRevision: "rev-1",
        expectedWriterRunId: "run-agent:main:discord:c:1",
      });
      expect(
        getOwnedSessionTranscriptWriterFence({
          sessionKey: "agent:main:discord:c:1",
          sessionTarget: {
            sessionKey: "agent:main:discord:c:1",
            storePath: "/tmp/agents/other/agent/openclaw-agent.sqlite",
          },
        }),
      ).toBeUndefined();
    });
  });
});
