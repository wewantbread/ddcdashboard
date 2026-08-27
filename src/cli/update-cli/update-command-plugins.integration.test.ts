import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigFileSnapshot, OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginInstallRecord } from "../../config/types.plugins.js";

type SyncPluginsForUpdateChannel =
  typeof import("../../plugins/update.js").syncPluginsForUpdateChannel;
type UpdateNpmInstalledPlugins = typeof import("../../plugins/update.js").updateNpmInstalledPlugins;

const PLUGIN_ID = "external-chat";
const mocks = vi.hoisted(() => ({
  commitPluginInstallRecordsWithConfig: vi.fn(async () => undefined),
  installAttempts: 0,
  listManagedPluginNpmRoots: vi.fn(),
  listPersistedBundledPluginLocationBridges: vi.fn(async () => []),
  loadManifestMetadataSnapshot: vi.fn(),
  relinkOpenClawPeerDependenciesInManagedNpmRoot: vi.fn(async () => ({
    checked: 0,
    attempted: 0,
    repaired: 0,
    skipped: 0,
  })),
  refreshPluginRegistryAfterConfigMutation: vi.fn(async () => undefined),
  syncMode: "clawhub" as "clawhub" | "npm" | "failed",
  syncPluginsForUpdateChannel: vi.fn(),
  updateNpmInstalledPlugins: vi.fn(),
  writePersistedInstalledPluginIndexInstallRecords: vi.fn(async () => undefined),
}));

vi.mock("../../plugins/install-record-commit.js", () => ({
  commitPluginInstallRecordsWithConfig: mocks.commitPluginInstallRecordsWithConfig,
}));
vi.mock("../../plugins/registry-refresh.js", () => ({
  refreshPluginRegistryAfterConfigMutation: mocks.refreshPluginRegistryAfterConfigMutation,
}));
vi.mock("../plugins-location-bridges.js", () => ({
  listPersistedBundledPluginLocationBridges: mocks.listPersistedBundledPluginLocationBridges,
}));
vi.mock("../../plugins/manifest-contract-eligibility.js", () => ({
  loadManifestMetadataSnapshot: mocks.loadManifestMetadataSnapshot,
}));
vi.mock("../../plugins/installed-plugin-index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/installed-plugin-index.js")>()),
  loadInstalledPluginIndex: () => ({ plugins: [] }),
}));
vi.mock("../../plugins/installed-plugin-index-records.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/installed-plugin-index-records.js")>()),
  writePersistedInstalledPluginIndexInstallRecords:
    mocks.writePersistedInstalledPluginIndexInstallRecords,
}));
vi.mock("../../plugins/update.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/update.js")>()),
  syncPluginsForUpdateChannel: mocks.syncPluginsForUpdateChannel,
  updateNpmInstalledPlugins: mocks.updateNpmInstalledPlugins,
}));
vi.mock("../../commands/doctor-plugin-registry.js", () => ({
  maybeRepairStaleManagedNpmBundledPlugins: vi.fn(() => false),
}));
vi.mock("../../channels/plugins/catalog.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../channels/plugins/catalog.js")>()),
  listRawChannelPluginCatalogEntries: () => [],
}));
vi.mock("../../plugins/npm-project-roots.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/npm-project-roots.js")>()),
  listManagedPluginNpmRoots: mocks.listManagedPluginNpmRoots,
}));
vi.mock("../../plugins/plugin-peer-link.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/plugin-peer-link.js")>()),
  reconcileRegisteredOpenClawHostLinks: vi.fn(async () => ({
    checked: 0,
    attempted: 0,
    repaired: 0,
    skipped: 0,
  })),
  relinkOpenClawPeerDependenciesInManagedNpmRoot:
    mocks.relinkOpenClawPeerDependenciesInManagedNpmRoot,
}));
vi.mock("../../plugins/stale-local-bundled-plugin-install-records.js", () => ({
  pruneStaleLocalBundledPluginInstallRecords: (params: {
    installRecords: Record<string, PluginInstallRecord>;
  }) => ({ records: params.installRecords, stale: [] }),
}));

import { updatePluginsAfterCoreUpdate } from "./update-command-plugins.js";

describe("updatePluginsAfterCoreUpdate plugin convergence", () => {
  let packageDir: string;
  let root: string;
  let stateDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.installAttempts = 0;
    mocks.syncMode = "clawhub";
    root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-update-plugin-root-"));
    stateDir = path.join(root, "state");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    packageDir = path.join(stateDir, "extensions", PLUGIN_ID);
    mocks.listManagedPluginNpmRoots.mockResolvedValue([packageDir]);
    await fs.mkdir(packageDir, { recursive: true });
    await fs.writeFile(path.join(root, "package.json"), '{"version":"2026.8.10"}\n');
    await fs.writeFile(
      path.join(packageDir, "package.json"),
      JSON.stringify({
        name: `@openclaw/${PLUGIN_ID}`,
        version: "2026.8.10",
        openclaw: { extensions: ["./index.js"] },
      }),
    );
    await fs.writeFile(path.join(packageDir, "index.js"), "export default {};\n");

    mocks.loadManifestMetadataSnapshot.mockReturnValue({
      plugins: [{ id: PLUGIN_ID, origin: "installed", channels: [] }],
      diagnostics: [
        {
          pluginId: PLUGIN_ID,
          message: `plugin "${PLUGIN_ID}" loaded without channelConfigs metadata`,
        },
      ],
      byPluginId: new Map(),
      manifestRegistry: { plugins: [] },
    });
    mocks.syncPluginsForUpdateChannel.mockImplementation(
      async (params: Parameters<SyncPluginsForUpdateChannel>[0]) => {
        if (params.config.plugins?.installs?.[PLUGIN_ID]?.source === "clawhub") {
          return {
            config: params.config,
            changed: false,
            summary: {
              switchedToBundled: [],
              switchedToClawHub: [],
              switchedToNpm: [],
              warnings: [],
              errors: [],
            },
          };
        }
        mocks.installAttempts += 1;
        if (mocks.syncMode === "failed") {
          return {
            config: params.config,
            changed: false,
            summary: {
              switchedToBundled: [],
              switchedToClawHub: [],
              switchedToNpm: [],
              warnings: [],
              errors: [`Failed to update ${PLUGIN_ID}`],
            },
          };
        }
        const record: PluginInstallRecord =
          mocks.syncMode === "clawhub"
            ? {
                source: "clawhub",
                spec: `clawhub:@openclaw/${PLUGIN_ID}@2026.8.10`,
                clawhubPackage: `@openclaw/${PLUGIN_ID}`,
                clawhubChannel: "official",
                installPath: packageDir,
              }
            : {
                source: "npm",
                spec: `@openclaw/${PLUGIN_ID}@2026.8.10`,
                installPath: packageDir,
              };
        return {
          config: withInstallRecord(params.config, record),
          changed: true,
          summary: {
            switchedToBundled: [],
            switchedToClawHub: mocks.syncMode === "clawhub" ? [PLUGIN_ID] : [],
            switchedToNpm: mocks.syncMode === "npm" ? [PLUGIN_ID] : [],
            warnings: [],
            errors: [],
          },
        };
      },
    );
    mocks.updateNpmInstalledPlugins.mockImplementation(
      async (params: Parameters<UpdateNpmInstalledPlugins>[0]) => {
        if (!params.pluginIds?.includes(PLUGIN_ID)) {
          return { config: params.config, changed: false, outcomes: [] };
        }
        mocks.installAttempts += 1;
        const record: PluginInstallRecord =
          mocks.syncMode === "npm"
            ? {
                source: "npm",
                spec: `@openclaw/${PLUGIN_ID}@2026.8.10`,
                installPath: packageDir,
              }
            : {
                source: "clawhub",
                spec: `clawhub:@openclaw/${PLUGIN_ID}@2026.8.10`,
                clawhubPackage: `@openclaw/${PLUGIN_ID}`,
                clawhubChannel: "official",
                installPath: packageDir,
              };
        const config = withInstallRecord(params.config, record);
        return {
          config,
          changed: true,
          outcomes: [
            {
              pluginId: PLUGIN_ID,
              status: "unchanged" as const,
              message: `${PLUGIN_ID} already at 2026.8.10.`,
            },
          ],
        };
      },
    );
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  });

  it.each([
    ["ClawHub", "clawhub"],
    ["ClawHub npm fallback", "npm"],
  ] as const)("installs a synchronized %s plugin only once", async (_label, syncMode) => {
    mocks.syncMode = syncMode;

    await runUpdate(root, { staleTrackedInstall: true });

    expect(mocks.installAttempts).toBe(1);
    expect(mocks.relinkOpenClawPeerDependenciesInManagedNpmRoot).toHaveBeenCalled();
  });

  it("retries a plugin whose synchronization failed", async () => {
    mocks.syncMode = "failed";

    await runUpdate(root);

    expect(mocks.installAttempts).toBe(2);
  });
});

function withInstallRecord(config: OpenClawConfig, record: PluginInstallRecord): OpenClawConfig {
  return {
    ...config,
    plugins: {
      ...config.plugins,
      installs: { ...config.plugins?.installs, [PLUGIN_ID]: record },
    },
  };
}

async function runUpdate(
  root: string,
  options: { staleTrackedInstall?: boolean } = {},
): Promise<void> {
  const oldInstallPath = path.join(root, "old-bundled-plugin");
  const sourceConfig: OpenClawConfig = {
    plugins: {
      entries: { [PLUGIN_ID]: { enabled: true } },
      installs: {
        [PLUGIN_ID]: options.staleTrackedInstall
          ? {
              source: "clawhub",
              spec: `clawhub:@openclaw/${PLUGIN_ID}@2026.7.1`,
              clawhubPackage: `@openclaw/${PLUGIN_ID}`,
              clawhubChannel: "official",
              installPath: oldInstallPath,
            }
          : {
              source: "path",
              sourcePath: oldInstallPath,
              installPath: oldInstallPath,
            },
      },
    },
  };
  const configSnapshot: ConfigFileSnapshot = {
    path: path.join(root, "openclaw.json"),
    exists: true,
    raw: "{}",
    parsed: sourceConfig,
    sourceConfig,
    resolved: sourceConfig,
    runtimeConfig: sourceConfig,
    config: sourceConfig,
    valid: true,
    hash: "test-config-hash",
    issues: [],
    warnings: [],
    legacyIssues: [],
  };
  await updatePluginsAfterCoreUpdate({
    root,
    channel: "stable",
    configSnapshot,
    opts: { json: true, yes: true },
    timeoutMs: 1_000,
    pluginInstallRecords: sourceConfig.plugins?.installs,
  });
}
