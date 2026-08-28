// Covers update-channel bundled-plugin enablement under bundledDiscovery machine state.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeConfigMachineState } from "../state/config-machine-state.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { clearBundledDiscoveryModeMemo } from "./bundled-discovery-state.js";
import { isExternalizedBundledPluginEnabled } from "./update-config.js";

describe("isExternalizedBundledPluginEnabled under bundledDiscovery compat", () => {
  afterEach(() => {
    clearBundledDiscoveryModeMemo();
  });

  it("honors compat from the caller env's state root and registers the seam reader", async () => {
    // Two-root regression (#123416): the update-channel path must not skip
    // compatible allowlisted bundled installs during update. Importing
    // update-config must be enough to register the SQLite reader into the
    // kysely-free seam (no other module preloads it in an update run).
    const compatRoot = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-update-compat-")),
    );
    const plainRoot = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-update-plain-")),
    );
    const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
    try {
      setTestEnvValue("OPENCLAW_STATE_DIR", compatRoot);
      writeConfigMachineState("plugins.bundledDiscovery", "compat");
      setTestEnvValue("OPENCLAW_STATE_DIR", plainRoot);
      clearBundledDiscoveryModeMemo();

      const params = {
        config: { plugins: { allow: ["some-other-plugin"] } },
        bridge: { bundledPluginId: "canvas", enabledByDefault: true },
      };
      const callerEnv = { ...process.env, OPENCLAW_STATE_DIR: compatRoot };

      expect(isExternalizedBundledPluginEnabled({ ...params, env: callerEnv })).toBe(true);
      // Process root has no recorded mode: strict allowlist gate stands.
      expect(isExternalizedBundledPluginEnabled(params)).toBe(false);

      // Same seam serves the process root once compat is recorded there.
      setTestEnvValue("OPENCLAW_STATE_DIR", compatRoot);
      clearBundledDiscoveryModeMemo();
      expect(isExternalizedBundledPluginEnabled(params)).toBe(true);
    } finally {
      envSnapshot.restore();
      clearBundledDiscoveryModeMemo();
      await fs.rm(compatRoot, { recursive: true, force: true });
      await fs.rm(plainRoot, { recursive: true, force: true });
    }
  });
});
