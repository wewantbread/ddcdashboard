// Preserve module setup before modules that consume it.
// oxfmt-ignore
import {
  getPreparedModelRuntimeMocks,
  resetPreparedModelRuntimeHarness,
} from "./prepared-model-runtime.test-harness.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquireAgentRunPreparedModelRuntime,
  markPreparedModelRuntimeSnapshotsStale,
  refreshPreparedModelRuntimeSnapshots,
} from "./prepared-model-runtime.js";

const mocks = getPreparedModelRuntimeMocks();

describe("prepared model runtime catalog mode", () => {
  beforeEach(() => {
    resetPreparedModelRuntimeHarness();
  });

  it("publishes a static turn generation without live catalog discovery", async () => {
    const lease = await acquireAgentRunPreparedModelRuntime(
      {
        config: {},
        agentId: "default",
        agentDir: "/tmp/static-run-agent",
        workspaceDir: "/tmp/static-run-workspace",
      },
      { catalogMode: "static" },
    );

    expect(mocks.prepareStaticCatalog).toHaveBeenCalledOnce();
    expect(mocks.ensureOpenClawModelsJson).not.toHaveBeenCalled();
    lease.release();
  });

  it("defaults agent-run admission to static catalog mode", async () => {
    const lease = await acquireAgentRunPreparedModelRuntime({
      config: {},
      agentId: "default",
      agentDir: "/tmp/default-static-run-agent",
      workspaceDir: "/tmp/default-static-run-workspace",
    });

    expect(mocks.prepareStaticCatalog).toHaveBeenCalledOnce();
    expect(mocks.ensureOpenClawModelsJson).not.toHaveBeenCalled();
    lease.release();
  });

  it("defaults partial options to static catalog mode", async () => {
    const lease = await acquireAgentRunPreparedModelRuntime(
      {
        config: {},
        agentId: "default",
        agentDir: "/tmp/partial-options-static-run-agent",
        workspaceDir: "/tmp/partial-options-static-run-workspace",
      },
      { retainIdleRunOwner: true },
    );

    expect(mocks.prepareStaticCatalog).toHaveBeenCalledOnce();
    expect(mocks.ensureOpenClawModelsJson).not.toHaveBeenCalled();
    lease.release();
  });

  it("retains an exact dynamic workspace owner after gateway run admission", async () => {
    mocks.configuredAgentIds = ["default"];
    const config = {};
    const workspaceDir = "/tmp/spawned-workspace";
    await refreshPreparedModelRuntimeSnapshots(config, {
      gatewayLifecycle: true,
      defaultWorkspaceDir: "/tmp/gateway-launch-workspace",
    });
    const acquireDynamicLease = () =>
      acquireAgentRunPreparedModelRuntime(
        {
          agentId: "default",
          config,
          agentDir: "/tmp/unused-agent",
          inheritedAuthDir: "/tmp/unused-agent",
          workspaceDir,
        },
        { catalogMode: "live" },
      );
    const [firstLease, secondLease] = await Promise.all([
      acquireDynamicLease(),
      acquireDynamicLease(),
    ]);

    expect(firstLease.snapshot.workspaceDir).toBe(workspaceDir);
    expect(secondLease.snapshot).toBe(firstLease.snapshot);
    firstLease.release();
    secondLease.release();
    const retainedLease = await acquireAgentRunPreparedModelRuntime(
      {
        agentId: "default",
        config,
        agentDir: "/tmp/unused-agent",
        inheritedAuthDir: "/tmp/unused-agent",
        workspaceDir,
      },
      { catalogMode: "live" },
    );
    expect(retainedLease.snapshot).toBe(firstLease.snapshot);
    retainedLease.release();
    expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(2);
  });

  it("joins an in-flight dynamic owner publication", async () => {
    mocks.configuredAgentIds = ["default"];
    const config = {};
    await refreshPreparedModelRuntimeSnapshots(config, { gatewayLifecycle: true });
    let finishDynamic!: () => void;
    mocks.ensureOpenClawModelsJson.mockImplementationOnce(
      async () =>
        await new Promise<{ agentDir: string; wrote: false }>((resolve) => {
          finishDynamic = () => resolve({ agentDir: "/tmp/unused-agent", wrote: false });
        }),
    );
    const input = {
      agentId: "default",
      config,
      agentDir: "/tmp/unused-agent",
      inheritedAuthDir: "/tmp/unused-agent",
      workspaceDir: "/tmp/concurrent-dynamic-workspace",
    };

    const firstPending = acquireAgentRunPreparedModelRuntime(input, { catalogMode: "live" });
    await vi.waitFor(() => expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(2));
    const secondPending = acquireAgentRunPreparedModelRuntime(input, { catalogMode: "live" });
    await Promise.resolve();
    expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(2);
    finishDynamic();
    const [first, second] = await Promise.all([firstPending, secondPending]);

    expect(second.snapshot).toBe(first.snapshot);
    expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(2);
    first.release();
    second.release();
  });

  it("blocks new dynamic lease owners until lifecycle replacement commits", async () => {
    mocks.configuredAgentIds = ["default"];
    const initialConfig = {};
    const latestConfig = { agents: { defaults: { model: "openai/gpt-5.5" } } };
    await refreshPreparedModelRuntimeSnapshots(initialConfig, { gatewayLifecycle: true });
    let finishReplacement!: () => void;
    mocks.ensureOpenClawModelsJson.mockImplementationOnce(
      async () =>
        await new Promise<{ agentDir: string; wrote: boolean }>((resolve) => {
          finishReplacement = () => resolve({ agentDir: "/tmp/unused-agent", wrote: false });
        }),
    );

    markPreparedModelRuntimeSnapshotsStale("test lease replacement", {
      waitForReplacement: true,
    });
    const leasePending = acquireAgentRunPreparedModelRuntime(
      {
        agentId: "default",
        config: initialConfig,
        agentDir: "/tmp/unused-agent",
        inheritedAuthDir: "/tmp/unused-agent",
        workspaceDir: "/tmp/dynamic-replacement-workspace",
      },
      { catalogMode: "live" },
    );
    await Promise.resolve();
    expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(1);

    const refresh = refreshPreparedModelRuntimeSnapshots(latestConfig);
    await vi.waitFor(() => expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(2));
    finishReplacement();
    await refresh;
    const lease = await leasePending;

    expect(lease.snapshot.config).toBe(latestConfig);
    expect(lease.snapshot.workspaceDir).toBe("/tmp/dynamic-replacement-workspace");
    expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(3);
    lease.release();
  });
});
