// Covers memoized bundled-discovery mode reads across machine-state writes.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeConfigMachineState } from "../state/config-machine-state.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import {
  clearBundledDiscoveryModeMemo,
  readBundledDiscoveryModeMemoized,
} from "./bundled-discovery-state.js";

describe("readBundledDiscoveryModeMemoized", () => {
  afterEach(() => {
    clearBundledDiscoveryModeMemo();
  });

  it("observes a machine-state write after the memo is cleared", async () => {
    const stateDir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-bundled-discovery-")),
    );
    const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    try {
      clearBundledDiscoveryModeMemo();
      // Pre-migration read caches the absent mode.
      expect(readBundledDiscoveryModeMemoized()).toBeUndefined();
      writeConfigMachineState("plugins.bundledDiscovery", "compat");
      // Regression for the doctor same-process staleness: the memo must not
      // outlive the write, or index rebuilds keep strict-gate decisions.
      expect(readBundledDiscoveryModeMemoized()).toBeUndefined();
      clearBundledDiscoveryModeMemo();
      expect(readBundledDiscoveryModeMemoized()).toBe("compat");
    } finally {
      envSnapshot.restore();
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });
});
