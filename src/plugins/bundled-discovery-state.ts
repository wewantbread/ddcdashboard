// Bundled-discovery compatibility is machine-owned upgrade state.
import { readConfigMachineState } from "../state/config-machine-state.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import {
  hasActivePluginInstallRoots,
  resolveActivePluginInstallRoots,
} from "./install-root-context.js";
import { registerPluginMetadataProcessMemoLifecycleClear } from "./plugin-metadata-lifecycle.js";

export function readBundledDiscoveryMode(
  options: OpenClawStateDatabaseOptions = {},
): "compat" | "allowlist" | undefined {
  const resolvedOptions =
    options.path || options.database || !hasActivePluginInstallRoots()
      ? options
      : {
          ...options,
          env: {
            ...(options.env ?? process.env),
            OPENCLAW_STATE_DIR: resolveActivePluginInstallRoots(options.env).stateDir,
          },
        };
  const value = readConfigMachineState<unknown>("plugins.bundledDiscovery", resolvedOptions);
  return value === "compat" || value === "allowlist" ? value : undefined;
}

// Single-slot process memo: the mode is machine-owned upgrade state that only
// changes through doctor/restart, and per-plugin activation must not open
// SQLite once per decision.
let memoizedBundledDiscoveryMode: { value: "compat" | "allowlist" | undefined } | undefined;

registerPluginMetadataProcessMemoLifecycleClear(() => {
  memoizedBundledDiscoveryMode = undefined;
});

export function readBundledDiscoveryModeMemoized(): "compat" | "allowlist" | undefined {
  memoizedBundledDiscoveryMode ??= { value: readBundledDiscoveryMode() };
  return memoizedBundledDiscoveryMode.value;
}
