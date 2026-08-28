// Kysely-free seam for the machine-owned bundled-discovery mode.
// config-state must stay statically free of the state-db graph (plugin doctor
// closures reach it via openclaw/plugin-sdk/plugin-config-runtime), so the
// SQLite-backed reader in bundled-discovery-state.ts registers itself here at
// module load instead of being imported directly.
type BundledDiscoveryMode = "compat" | "allowlist" | undefined;
type BundledDiscoveryModeReader = (env?: NodeJS.ProcessEnv) => BundledDiscoveryMode;

let registeredReader: BundledDiscoveryModeReader | undefined;

/** Called once by bundled-discovery-state.ts when the SQLite reader loads. */
export function registerBundledDiscoveryModeReader(reader: BundledDiscoveryModeReader): void {
  registeredReader = reader;
}

/**
 * Reads the mode through the registered SQLite reader. Unregistered means the
 * process never loaded plugin state machinery (activation flows, doctor
 * migration hosts, and control-plane policy all import the reader statically);
 * those processes keep the strict pre-compat allowlist gate.
 */
export function readRegisteredBundledDiscoveryMode(env?: NodeJS.ProcessEnv): BundledDiscoveryMode {
  return registeredReader?.(env);
}
