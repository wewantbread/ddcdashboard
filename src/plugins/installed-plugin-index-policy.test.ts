// Covers policy-hash invalidation inputs for the persisted installed-plugin index.
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveInstalledPluginIndexPolicyHash } from "./installed-plugin-index-policy.js";

const bundledDiscoveryState = vi.hoisted(() => ({
  mode: undefined as "compat" | "allowlist" | undefined,
}));
vi.mock("./bundled-discovery-state.js", () => ({
  readBundledDiscoveryMode: () => bundledDiscoveryState.mode,
  readBundledDiscoveryModeMemoized: () => bundledDiscoveryState.mode,
}));

describe("resolveInstalledPluginIndexPolicyHash", () => {
  afterEach(() => {
    bundledDiscoveryState.mode = undefined;
  });

  it("changes when the machine-state bundled discovery mode changes", () => {
    // Regression for #123297's upgrade path: doctor migrates the mode into
    // machine state without touching openclaw.json, so the mode must be a
    // policy-hash input or persisted enabled values stay stale after --fix.
    const config = { plugins: { allow: ["rollover"] } };
    const unset = resolveInstalledPluginIndexPolicyHash(config);
    bundledDiscoveryState.mode = "compat";
    const compat = resolveInstalledPluginIndexPolicyHash(config);
    bundledDiscoveryState.mode = "allowlist";
    const allowlist = resolveInstalledPluginIndexPolicyHash(config);

    expect(compat).not.toBe(unset);
    expect(allowlist).not.toBe(unset);
    expect(allowlist).not.toBe(compat);
  });

  it("stays stable for an unchanged mode and config", () => {
    bundledDiscoveryState.mode = "compat";
    const config = { plugins: { allow: ["rollover"] } };
    expect(resolveInstalledPluginIndexPolicyHash(config)).toBe(
      resolveInstalledPluginIndexPolicyHash(config),
    );
  });
});
