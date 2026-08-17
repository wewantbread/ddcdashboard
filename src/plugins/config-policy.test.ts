// Covers plugin config policy validation and ownership decisions.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  normalizePluginsConfigWithResolver,
  resolvePolicyPluginActivationState,
} from "./config-policy.js";

const bundledDiscoveryState = vi.hoisted(() => ({
  mode: undefined as "compat" | "allowlist" | undefined,
}));
vi.mock("./bundled-discovery-state.js", () => ({
  readBundledDiscoveryMode: () => bundledDiscoveryState.mode,
  readBundledDiscoveryModeMemoized: () => bundledDiscoveryState.mode,
  clearBundledDiscoveryModeMemo: () => {},
}));

describe("normalizePluginsConfigWithResolver", () => {
  it("uses the provided plugin id resolver for allow deny and entry keys", () => {
    const normalized = normalizePluginsConfigWithResolver(
      {
        allow: [" alpha "],
        deny: [" beta "],
        entries: {
          " gamma ": {
            enabled: true,
          },
        },
      },
      (id) => id.trim().toUpperCase(),
    );

    expect(normalized.allow).toEqual(["ALPHA"]);
    expect(normalized.deny).toEqual(["BETA"]);
    expect(normalized.entries).toHaveProperty("GAMMA");
  });
});

describe("resolvePolicyPluginActivationState under bundledDiscovery modes", () => {
  afterEach(() => {
    bundledDiscoveryState.mode = undefined;
  });

  const config = normalizePluginsConfigWithResolver({ allow: ["rollover"] });

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
  ])("$name", ({ mode, origin, expectedEnabled }) => {
    bundledDiscoveryState.mode = mode;
    const state = resolvePolicyPluginActivationState({
      id: "telegram",
      origin,
      config,
      enabledByDefault: true,
    });
    expect(state.enabled).toBe(expectedEnabled);
  });
});
