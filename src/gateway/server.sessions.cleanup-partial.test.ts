import { expect, test, vi } from "vitest";
import { ErrorCodes } from "../../packages/gateway-protocol/src/index.js";
import { SessionsCleanupPartialError } from "../config/sessions/cleanup-service.js";
import { getSessionsHandlers } from "./test/server-sessions.test-helpers.js";

vi.mock("../config/sessions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/sessions.js")>();
  return {
    ...actual,
    runSessionsCleanup: vi.fn(async () => {
      throw new SessionsCleanupPartialError({
        mode: "enforce",
        previewResults: [],
        appliedSummaries: [
          {
            agentId: "work",
            storePath: "/tmp/fake/work/sessions.sqlite",
            mode: "enforce",
            dryRun: false,
            beforeCount: 10,
            afterCount: 5,
            missing: 0,
            dmScopeRetired: 0,
            modelRunPruned: 0,
            archived: 0,
            pruned: 5,
            capped: 0,
            unreferencedArtifacts: {
              scannedFiles: 0,
              removedFiles: 0,
              freedBytes: 0,
              olderThanMs: 0,
            },
            diskBudget: null,
            wouldMutate: true,
            applied: true,
            appliedCount: 5,
          },
        ],
        failingTarget: {
          agentId: "main",
          storePath: "/tmp/fake/main/sessions.sqlite",
        },
        cause: new Error("Injected post-commit failure"),
        lifecycleCommitted: true,
      });
    }),
  };
});

test("sessions.cleanup handler emits sessions.changed on lifecycle-committed partial failures", async () => {
  const broadcastToConnIds = vi.fn();
  const respond = vi.fn();
  const logDebug = vi.fn();

  const sessionsHandlers = await getSessionsHandlers();
  const handler = sessionsHandlers["sessions.cleanup"];
  if (!handler) {
    throw new Error("sessions.cleanup handler not found");
  }

  await handler({
    req: {} as never,
    params: { allAgents: true, enforce: true },
    respond,
    client: null,
    isWebchatConnect: () => false,
    context: {
      broadcastToConnIds,
      getSessionEventSubscriberConnIds: () => new Set(["conn-1"]),
      getRuntimeConfig: () => ({}),
      logGateway: { debug: logDebug, info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as never,
  });

  expect(respond).toHaveBeenCalledTimes(1);
  expect(respond.mock.calls[0]?.[0]).toBe(false);
  const errorEnvelope = respond.mock.calls[0]?.[2];
  expect(errorEnvelope).toMatchObject({
    code: ErrorCodes.INVALID_REQUEST,
    details: {
      partialError: {
        failingAgentId: "main",
        lifecycleCommitted: true,
        message: expect.stringContaining("Injected post-commit failure"),
      },
    },
  });

  expect(broadcastToConnIds).toHaveBeenCalledWith(
    "sessions.changed",
    expect.objectContaining({ reason: "cleanup" }),
    new Set(["conn-1"]),
    expect.objectContaining({ dropIfSlow: true }),
  );

  expect(logDebug).toHaveBeenCalledWith(
    expect.stringContaining(
      "sessions.cleanup applied /tmp/fake/main/sessions.sqlite (failing publication)",
    ),
  );
});
