/** Runs plugin runtime lifecycle cleanup records through the shared timeout boundary. */
import { withPluginHostCleanupTimeout } from "./host-hook-cleanup-timeout.js";
import type { PluginHostCleanupReason } from "./host-hooks.js";
import type { PluginRegistry } from "./registry-types.js";

type RuntimeLifecycleRegistration = PluginRegistry["runtimeLifecycles"][number];
type RuntimeLifecycleCleanupFailure = {
  pluginId: string;
  hookId: string;
  error: unknown;
};

export async function cleanupPluginRuntimeLifecycles(params: {
  registrations: readonly RuntimeLifecycleRegistration[];
  pluginId?: string;
  reason: PluginHostCleanupReason;
  sessionKey?: string;
  runId?: string;
  shouldCleanup?: () => boolean;
}): Promise<{ cleanupCount: number; failures: RuntimeLifecycleCleanupFailure[] }> {
  const failures: RuntimeLifecycleCleanupFailure[] = [];
  const shouldCleanup = params.shouldCleanup ?? (() => true);
  let cleanupCount = 0;
  for (const registration of params.registrations) {
    if (!shouldCleanup()) {
      break;
    }
    if (params.pluginId && registration.pluginId !== params.pluginId) {
      continue;
    }
    const cleanup = registration.lifecycle.cleanup;
    if (!cleanup) {
      continue;
    }
    const hookId = `runtime:${registration.lifecycle.id}`;
    try {
      await withPluginHostCleanupTimeout(hookId, () =>
        cleanup({ reason: params.reason, sessionKey: params.sessionKey, runId: params.runId }),
      );
      cleanupCount += 1;
    } catch (error) {
      failures.push({ pluginId: registration.pluginId, hookId, error });
    }
  }
  return { cleanupCount, failures };
}
