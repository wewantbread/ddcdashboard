import { describe, expect, it, vi } from "vitest";
import { SessionsCleanupPartialError } from "../config/sessions.js";
import type { SessionCleanupSummary } from "../config/sessions.js";
import { runLocalSessionsCleanup } from "./sessions-cleanup.runtime.js";

const runSessionsCleanup = vi.hoisted(() => vi.fn());

vi.mock("../config/sessions.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/sessions.js")>()),
  runSessionsCleanup,
}));
vi.mock("../plugins/loader.js", () => ({
  loadPluginRegistryHandle: vi.fn(() => ({})),
}));
vi.mock("../plugins/plugin-metadata-snapshot.js", () => ({
  loadPluginMetadataSnapshot: vi.fn(() => ({
    plugins: [],
    manifestRegistry: {},
    discovery: {},
    index: {},
  })),
}));
vi.mock("../plugins/installed-plugin-index-install-records.js", () => ({
  extractPluginInstallRecordsFromInstalledPluginIndex: vi.fn(() => []),
}));
vi.mock("../plugins/activation-planner.js", () => ({
  resolveManifestActivationPluginIds: vi.fn(() => []),
}));
vi.mock("../plugins/activation-context.js", () => ({
  withActivatedPluginIds: vi.fn((args: { config: unknown }) => args.config),
}));
vi.mock("../plugins/runtime/gateway-request-scope.js", () => ({
  withPluginRuntimeRegistryScope: vi.fn((_registry: unknown, fn: () => unknown) => fn()),
}));
vi.mock("../agents/agent-scope-config.js", () => ({
  resolveAgentWorkspaceDir: vi.fn(() => "/tmp/openclaw-test-workspace"),
}));

function summary(storePath: string): SessionCleanupSummary {
  return {
    agentId: "work",
    storePath,
    mode: "reset",
    dryRun: false,
    beforeCount: 5,
    afterCount: 2,
    missing: 0,
    dmScopeRetired: 0,
    modelRunPruned: 0,
    pruned: 3,
    capped: 0,
    unreferencedArtifacts: { scanned: 0, pruned: 0, orphaned: 0 },
    diskBudget: null,
    wouldMutate: true,
  };
}

describe("runLocalSessionsCleanup partial-failure accumulation", () => {
  it("retains earlier successful store summaries when a later target throws partial error", async () => {
    const okSummary = summary("/tmp/openclaw-store-ok");
    const failSummary = summary("/tmp/openclaw-store-fail");
    runSessionsCleanup
      .mockResolvedValueOnce({ mode: "reset", previewResults: [], appliedSummaries: [okSummary] })
      .mockRejectedValueOnce(
        new SessionsCleanupPartialError({
          mode: "reset",
          previewResults: [],
          appliedSummaries: [failSummary],
          failingTarget: { agentId: "work", storePath: "/tmp/openclaw-store-fail" },
          lifecycleCommitted: false,
        }),
      );

    let thrown: unknown;
    try {
      await runLocalSessionsCleanup(
        {
          cfg: {} as never,
          opts: {} as never,
          targets: [
            { agentId: "work", storePath: "/tmp/openclaw-store-ok" },
            { agentId: "work", storePath: "/tmp/openclaw-store-fail" },
          ],
        },
        {} as never,
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(SessionsCleanupPartialError);
    const error = thrown as SessionsCleanupPartialError;
    expect(error.appliedSummaries).toContainEqual(okSummary);
    expect(error.appliedSummaries).toContainEqual(failSummary);
  });
});
