// Covers dreaming-sidecar authorization under bundledDiscovery machine state.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_MEMORY_DREAMING_PLUGIN_ID } from "../memory-host-sdk/dreaming.js";
import { writeConfigMachineState } from "../state/config-machine-state.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { clearBundledDiscoveryModeMemo } from "./bundled-discovery-state.js";
import { normalizePluginsConfig } from "./config-state.js";
import { resolveAuthorizedDreamingSidecar } from "./loader-shared.js";

describe("resolveAuthorizedDreamingSidecar under bundledDiscovery compat", () => {
  afterEach(() => {
    clearBundledDiscoveryModeMemo();
  });

  it("authorizes the sidecar from the caller env's compat root, not the process root", async () => {
    // Two-root regression (#123416): an explicit-env load with compat in its
    // state root must authorize the bundled sidecar even when the process
    // root's strict allowlist would disable the selected memory plugin.
    const compatRoot = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sidecar-compat-")),
    );
    const plainRoot = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sidecar-plain-")),
    );
    const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
    try {
      setTestEnvValue("OPENCLAW_STATE_DIR", compatRoot);
      writeConfigMachineState("plugins.bundledDiscovery", "compat");
      setTestEnvValue("OPENCLAW_STATE_DIR", plainRoot);
      clearBundledDiscoveryModeMemo();

      const normalized = normalizePluginsConfig({ allow: ["some-other-plugin"] });
      const manifestRegistry = {
        plugins: [
          {
            id: "memory-lancedb",
            origin: "bundled",
            kind: "memory",
            enabledByDefault: true,
          },
          {
            id: DEFAULT_MEMORY_DREAMING_PLUGIN_ID,
            origin: "bundled",
            kind: "memory",
            enabledByDefault: true,
          },
        ],
      } as Parameters<typeof resolveAuthorizedDreamingSidecar>[0]["manifestRegistry"];
      const params = {
        cfg: {},
        normalized,
        activationSource: { plugins: normalized },
        manifestRegistry,
        memorySlot: "memory-lancedb",
      } as const;

      const callerEnv = { ...process.env, OPENCLAW_STATE_DIR: compatRoot };
      expect(resolveAuthorizedDreamingSidecar({ ...params, env: callerEnv })).toEqual({
        engineId: DEFAULT_MEMORY_DREAMING_PLUGIN_ID,
        selectedMemoryPluginId: "memory-lancedb",
      });
      expect(resolveAuthorizedDreamingSidecar(params)).toBeNull();
    } finally {
      envSnapshot.restore();
      clearBundledDiscoveryModeMemo();
      await fs.rm(compatRoot, { recursive: true, force: true });
      await fs.rm(plainRoot, { recursive: true, force: true });
    }
  });
});
