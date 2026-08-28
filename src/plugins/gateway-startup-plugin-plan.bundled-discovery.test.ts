// Covers gateway-startup plan activation under bundledDiscovery machine state.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeConfigMachineState } from "../state/config-machine-state.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { clearBundledDiscoveryModeMemo } from "./bundled-discovery-state.js";
import { resolveGatewayStartupPluginPlanFromRegistry } from "./channel-plugin-ids.js";
import type { InstalledPluginIndexRecord } from "./installed-plugin-index.js";
import type { PluginManifestRegistry } from "./manifest-registry.js";
import type { PluginRegistrySnapshot } from "./plugin-registry-snapshot.js";

function buildStartupFixture() {
  const record = {
    pluginId: "browser",
    origin: "bundled",
    enabled: true,
    enabledByDefault: true,
    startup: {
      sidecar: true,
      agentHarnesses: [],
      configPaths: [],
    },
    activation: { onStartup: true },
  } as unknown as InstalledPluginIndexRecord;
  const index = { plugins: [record] } as unknown as PluginRegistrySnapshot;
  const manifestRegistry = {
    plugins: [
      {
        id: "browser",
        origin: "bundled",
        enabledByDefault: true,
        activation: { onStartup: true },
        channels: [],
        rootDir: "/tmp/plugins/browser",
        source: "/tmp/plugins/browser/index.ts",
        manifestPath: "/tmp/plugins/browser/openclaw.plugin.json",
        skills: [],
        hooks: [],
      },
    ],
    diagnostics: [],
  } as unknown as PluginManifestRegistry;
  return { index, manifestRegistry };
}

describe("gateway startup plan under bundledDiscovery compat", () => {
  afterEach(() => {
    clearBundledDiscoveryModeMemo();
  });

  it("keeps a default-enabled bundled startup plugin when compat lives in the plan env's root", async () => {
    // Two-root regression (#123416): the plan's default-startup fallback must
    // read compat from the plan env, not the process root.
    const compatRoot = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-plan-compat-")),
    );
    const plainRoot = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-plan-plain-")),
    );
    const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
    try {
      setTestEnvValue("OPENCLAW_STATE_DIR", compatRoot);
      writeConfigMachineState("plugins.bundledDiscovery", "compat");
      setTestEnvValue("OPENCLAW_STATE_DIR", plainRoot);
      clearBundledDiscoveryModeMemo();

      const { index, manifestRegistry } = buildStartupFixture();
      // Sanity: with no allowlist the fixture plugin must appear at all.
      expect(
        resolveGatewayStartupPluginPlanFromRegistry({
          config: {},
          env: { ...process.env },
          index,
          manifestRegistry,
        }).pluginIds,
      ).toContain("browser");
      const config = { plugins: { allow: ["some-other-plugin"] } };
      const planEnv = { ...process.env, OPENCLAW_STATE_DIR: compatRoot };

      expect(
        resolveGatewayStartupPluginPlanFromRegistry({
          config,
          env: planEnv,
          index,
          manifestRegistry,
        }).pluginIds,
      ).toContain("browser");
      // Process root has no recorded mode: strict allowlist gate stands.
      expect(
        resolveGatewayStartupPluginPlanFromRegistry({
          config,
          env: { ...process.env },
          index,
          manifestRegistry,
        }).pluginIds,
      ).not.toContain("browser");
    } finally {
      envSnapshot.restore();
      clearBundledDiscoveryModeMemo();
      await fs.rm(compatRoot, { recursive: true, force: true });
      await fs.rm(plainRoot, { recursive: true, force: true });
    }
  });
});
