import { normalizeMediaProviderId } from "../../packages/media-understanding-common/src/provider-id.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ImageCompressionModelPolicy } from "../media/web-media.js";
import { getCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import { isManifestPluginAvailableForControlPlane } from "../plugins/manifest-contract-eligibility.js";
import type { ProviderRuntimeModel } from "../plugins/provider-runtime-model.types.js";
import { bundledStaticCatalogProviderUsesRuntimeAugment } from "./embedded-agent-runner/model.static-catalog.js";
import type { PreparedModelRuntimeSnapshot } from "./prepared-model-runtime.js";

type ResolveModelAsync = (typeof import("./embedded-agent-runner/model.js"))["resolveModelAsync"];

const resolveModelAsyncDefault: ResolveModelAsync = async (...args) => {
  const { resolveModelAsync } = await import("./embedded-agent-runner/model.js");
  return await resolveModelAsync(...args);
};

type ImageCompressionPolicyDeps = {
  resolveModelAsync: ResolveModelAsync;
};

function hasDimensionLimit(policy: ImageCompressionModelPolicy): boolean {
  return typeof policy.maxSidePx === "number" || typeof policy.maxPixels === "number";
}

function providerUsesRuntimeModelAugment(params: {
  cfg?: OpenClawConfig;
  provider: string;
  workspaceDir?: string;
  preparedModelRuntime?: PreparedModelRuntimeSnapshot;
}): boolean {
  const provider = normalizeMediaProviderId(params.provider);
  if (!provider) {
    return false;
  }
  const config = params.cfg ?? {};
  const snapshot =
    params.preparedModelRuntime?.metadataSnapshot ??
    getCurrentPluginMetadataSnapshot({
      config,
      env: process.env,
      ...(params.workspaceDir !== undefined ? { workspaceDir: params.workspaceDir } : {}),
    });
  if (
    bundledStaticCatalogProviderUsesRuntimeAugment({
      provider,
      cfg: params.cfg,
      ...(snapshot ? { metadataSnapshot: snapshot } : {}),
      workspaceDir: params.workspaceDir,
    })
  ) {
    return true;
  }
  if (!snapshot) {
    return false;
  }
  return snapshot.plugins.some((plugin) => {
    const ownsProvider =
      plugin.providers.some((candidate) => normalizeMediaProviderId(candidate) === provider) ||
      Boolean(plugin.modelCatalog?.providers?.[provider]);
    if (!ownsProvider) {
      return false;
    }
    const runtimeAugment =
      plugin.modelCatalog?.runtimeAugment === true ||
      (plugin.origin !== "bundled" &&
        plugin.providers.some((candidate) => normalizeMediaProviderId(candidate) === provider));
    if (!runtimeAugment) {
      return false;
    }
    return isManifestPluginAvailableForControlPlane({ snapshot, plugin, config });
  });
}

async function resolvePolicyWithHooks(params: {
  cfg?: OpenClawConfig;
  deps: ImageCompressionPolicyDeps;
  provider: string;
  model: string;
  agentDir?: string;
  workspaceDir?: string;
  preparedModelRuntime?: PreparedModelRuntimeSnapshot;
  skipProviderRuntimeHooks: boolean;
}): Promise<ImageCompressionModelPolicy> {
  try {
    const resolved = await params.deps.resolveModelAsync(
      params.provider,
      params.model,
      params.agentDir,
      params.cfg,
      {
        allowBundledStaticCatalogFallback: true,
        skipProviderRuntimeHooks: params.skipProviderRuntimeHooks,
        skipAgentDiscovery: true,
        workspaceDir: params.workspaceDir,
        ...(params.preparedModelRuntime
          ? { preparedModelRuntime: params.preparedModelRuntime }
          : {}),
      },
    );
    return (resolved.model as ProviderRuntimeModel | undefined)?.mediaInput?.image ?? {};
  } catch {
    return {};
  }
}

/** Resolves the authoritative image limits for one selected provider/model. */
export async function resolveImageCompressionModelPolicy(params: {
  cfg?: OpenClawConfig;
  provider: string;
  model: string;
  agentDir?: string;
  workspaceDir?: string;
  preparedModelRuntime?: PreparedModelRuntimeSnapshot;
  deps?: Partial<ImageCompressionPolicyDeps>;
}): Promise<ImageCompressionModelPolicy> {
  const deps: ImageCompressionPolicyDeps = {
    resolveModelAsync: params.deps?.resolveModelAsync ?? resolveModelAsyncDefault,
  };
  const staticPolicy = await resolvePolicyWithHooks({
    ...params,
    deps,
    skipProviderRuntimeHooks: true,
  });
  if (
    hasDimensionLimit(staticPolicy) ||
    !providerUsesRuntimeModelAugment({
      cfg: params.cfg,
      provider: params.provider,
      workspaceDir: params.workspaceDir,
      preparedModelRuntime: params.preparedModelRuntime,
    })
  ) {
    return staticPolicy;
  }
  return {
    ...(await resolvePolicyWithHooks({
      ...params,
      deps,
      skipProviderRuntimeHooks: false,
    })),
    ...staticPolicy,
  };
}
