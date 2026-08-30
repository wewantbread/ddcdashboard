import path from "node:path";
import type { CodexPluginThreadConfig } from "./plugin-thread-config.js";
import type { CodexThread, CodexThreadStartParams, CodexThreadStartResponse } from "./protocol.js";
import {
  CODEX_FROZEN_EMPTY_PROJECT_DOCS_AUTHORITY,
  CODEX_UNAVAILABLE_PROJECT_DOCS_AUTHORITY,
  type CodexAppServerContextEngineBinding,
} from "./session-binding.js";
import { fingerprintCodexThreadConfig } from "./thread-fingerprints.js";
import type {
  CodexAppServerThreadLifecycleBinding,
  CodexStartOrResumeThreadParams,
} from "./thread-lifecycle-types.js";

type StartedThreadContext = {
  contextEngineBinding?: CodexAppServerContextEngineBinding;
  dynamicToolsContainDeferred: boolean;
  dynamicToolsFingerprint: string;
  environmentSelectionFingerprint?: string;
  nativeSkillIsolationFingerprint?: string;
  networkProxyConfigFingerprint?: string;
  preserveExistingBinding: boolean;
  ringZeroClientInstanceId?: string;
  ringZeroConfigFingerprint?: string;
  rotatedContextEngineBinding: boolean;
  userMcpServersFingerprint?: string;
};

export function resolveCodexThreadRolloutPath(thread: CodexThread): string | undefined {
  const rolloutPath = thread.path?.trim();
  if (
    !rolloutPath ||
    !path.isAbsolute(rolloutPath) ||
    path.extname(rolloutPath) !== ".jsonl" ||
    !path.basename(rolloutPath).includes(thread.id)
  ) {
    return undefined;
  }
  return rolloutPath;
}

/** Persists one snapshot for eligible turns while leaving isolated runs eligible to upgrade. */
export function captureAgentInstructions(
  params: Pick<
    CodexStartOrResumeThreadParams,
    | "params"
    | "agentWorkspaceDeveloperInstructions"
    | "agentWorkspaceDeveloperInstructionsAllowed"
    | "projectInstructionsUnavailableToGateway"
  >,
  fallbackInstructions?: string | null,
  nativeProjectInstructionSources?: readonly string[],
) {
  if (
    params.agentWorkspaceDeveloperInstructionsAllowed === false ||
    params.params.bootstrapContextMode === "lightweight"
  ) {
    return {};
  }
  if (
    fallbackInstructions === CODEX_UNAVAILABLE_PROJECT_DOCS_AUTHORITY ||
    (params.projectInstructionsUnavailableToGateway === true &&
      nativeProjectInstructionSources !== undefined &&
      nativeProjectInstructionSources.length > 0)
  ) {
    return {
      agentWorkspaceDeveloperInstructions: CODEX_UNAVAILABLE_PROJECT_DOCS_AUTHORITY,
      projectInstructionsUnavailableToGateway: true as const,
    };
  }
  return {
    agentWorkspaceDeveloperInstructions:
      params.agentWorkspaceDeveloperInstructions !== undefined
        ? params.agentWorkspaceDeveloperInstructions
        : (fallbackInstructions ?? CODEX_FROZEN_EMPTY_PROJECT_DOCS_AUTHORITY),
  };
}

/** Materializes the public lifecycle result after a fresh thread is durably committed. */
export function buildStartedCodexThreadBinding(input: {
  bindingModelProvider?: string;
  clientId?: string;
  context: StartedThreadContext;
  finalConfigPatch: { nativeHookRelayGeneration?: string };
  nextMcpServersFingerprint?: string;
  params: CodexStartOrResumeThreadParams;
  pluginThreadConfig?: CodexPluginThreadConfig;
  response: CodexThreadStartResponse;
  rolloutPath?: string;
  startModelProvider?: string;
  startParams: CodexThreadStartParams;
  modelProvider?: string;
  capturedAgentWorkspaceDeveloperInstructions?: string | null;
}): CodexAppServerThreadLifecycleBinding {
  const { context, params, response, startParams } = input;
  return {
    threadId: response.thread.id,
    ...(input.clientId ? { clientId: input.clientId } : {}),
    cwd: params.cwd,
    ...(input.rolloutPath ? { rolloutPath: input.rolloutPath } : {}),
    authProfileId: params.params.authProfileId,
    ...captureAgentInstructions(
      params,
      input.capturedAgentWorkspaceDeveloperInstructions,
      response.instructionSources,
    ),
    model: response.model ?? startParams.model ?? params.params.modelId,
    modelProvider: response.modelProvider ?? input.startModelProvider ?? input.modelProvider,
    dynamicToolsFingerprint: context.dynamicToolsFingerprint,
    dynamicToolsContainDeferred: context.dynamicToolsContainDeferred,
    nativeSkillIsolationFingerprint: context.nativeSkillIsolationFingerprint,
    userMcpServersFingerprint: context.userMcpServersFingerprint,
    mcpServersFingerprint: input.nextMcpServersFingerprint,
    configuredMcpOwnershipVersion: params.configuredMcpOwnershipVersion,
    ringZeroConfigFingerprint: context.ringZeroConfigFingerprint,
    ringZeroClientInstanceId: context.ringZeroClientInstanceId,
    networkProxyProfileName: params.appServer.networkProxy?.profileName,
    networkProxyConfigFingerprint: context.networkProxyConfigFingerprint,
    nativeHookRelayGeneration: input.finalConfigPatch.nativeHookRelayGeneration,
    appServerRuntimeFingerprint: params.appServerRuntimeFingerprint,
    pluginAppsFingerprint: input.pluginThreadConfig?.fingerprint,
    pluginAppsInputFingerprint: input.pluginThreadConfig?.inputFingerprint,
    pluginAppPolicyContext: input.pluginThreadConfig?.policyContext,
    contextEngine: context.contextEngineBinding,
    environmentSelectionFingerprint: context.environmentSelectionFingerprint,
    // Transient starts do not own the persisted binding, so their native
    // subscriptions must be released instead of entering the warm cache.
    ...(!context.preserveExistingBinding
      ? {
          liveThreadConfigFingerprint: fingerprintCodexThreadConfig(
            {
              ...startParams,
              model: response.model ?? startParams.model ?? null,
              requestedModel: startParams.model ?? null,
              modelProvider: input.bindingModelProvider ?? null,
              requestedModelProvider:
                startParams.modelProvider ?? input.bindingModelProvider ?? null,
            },
            params.params.authProfileId,
            context.dynamicToolsFingerprint,
          ),
        }
      : {}),
    lifecycle: {
      action: "started",
      ...(context.rotatedContextEngineBinding ? { rotatedContextEngineBinding: true } : {}),
    },
  };
}
