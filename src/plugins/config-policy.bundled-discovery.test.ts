// Covers control-plane policy activation under bundledDiscovery machine state.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeConfigMachineState } from "../state/config-machine-state.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { clearBundledDiscoveryModeMemo } from "./bundled-discovery-state.js";
import {
  normalizePluginsConfigWithResolver,
  resolvePolicyPluginActivationState,
} from "./config-policy.js";

describe("resolvePolicyPluginActivationState under bundledDiscovery modes", () => {
  afterEach(() => {
    clearBundledDiscoveryModeMemo();
  });

  const config = normalizePluginsConfigWithResolver({ allow: ["rollover"] });

  // Real machine state in an isolated root: module mocks would evict this
  // file from the unit-fast lane and leak across isolate=false workers.
  const withDiscoveryMode = async (
    mode: "compat" | "allowlist" | undefined,
    run: () => void,
  ): Promise<void> => {
    const stateDir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-config-policy-")),
    );
    const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    try {
      if (mode) {
        writeConfigMachineState("plugins.bundledDiscovery", mode);
      }
      clearBundledDiscoveryModeMemo();
      run();
    } finally {
      envSnapshot.restore();
      clearBundledDiscoveryModeMemo();
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  };

  it.each([
    {
      name: "compat exempts a default-enabled bundled plugin from the allowlist",
      mode: "compat" as const,
      origin: "bundled" as const,
      expectedEnabled: true,
    },
    {
      name: "allowlist mode keeps the strict gate",
      mode: "allowlist" as const,
      origin: "bundled" as const,
      expectedEnabled: false,
    },
    {
      name: "unset mode keeps the strict gate",
      mode: undefined,
      origin: "bundled" as const,
      expectedEnabled: false,
    },
    {
      name: "compat does not leak to non-bundled origins",
      mode: "compat" as const,
      origin: "workspace" as const,
      expectedEnabled: false,
    },
  ])("$name", async ({ mode, origin, expectedEnabled }) => {
    await withDiscoveryMode(mode, () => {
      const state = resolvePolicyPluginActivationState({
        id: "telegram",
        origin,
        config,
        enabledByDefault: true,
      });
      expect(state.enabled).toBe(expectedEnabled);
    });
  });

  it("reads compat from the caller-scoped env's state root, not the process root", async () => {
    // Two-root regression (#123416): explicit-env callers must honor compat
    // recorded in the supplied root while the process root stays strict.
    const compatRoot = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-config-policy-caller-")),
    );
    const plainRoot = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-config-policy-process-")),
    );
    const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
    try {
      setTestEnvValue("OPENCLAW_STATE_DIR", compatRoot);
      writeConfigMachineState("plugins.bundledDiscovery", "compat");
      setTestEnvValue("OPENCLAW_STATE_DIR", plainRoot);
      clearBundledDiscoveryModeMemo();

      const params = {
        id: "telegram",
        origin: "bundled",
        config,
        enabledByDefault: true,
      } as const;
      const callerEnv = { ...process.env, OPENCLAW_STATE_DIR: compatRoot };
      expect(resolvePolicyPluginActivationState({ ...params, env: callerEnv }).enabled).toBe(true);
      expect(resolvePolicyPluginActivationState(params).enabled).toBe(false);
    } finally {
      envSnapshot.restore();
      clearBundledDiscoveryModeMemo();
      await fs.rm(compatRoot, { recursive: true, force: true });
      await fs.rm(plainRoot, { recursive: true, force: true });
    }
  });
});
