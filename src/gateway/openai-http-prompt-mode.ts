/**
 * HTTP Chat Completions promptMode from the effective tools profile.
 * Resolves after model override / stored session model, not only the agent default.
 */
import { resolveEffectiveToolPolicy } from "../agents/agent-tools.policy.js";
import { parseModelRef } from "../agents/model-selection-normalize.js";
import { resolveDefaultModelForAgent } from "../agents/model-selection.js";
import { resolveChannelModelOverride } from "../channels/model-overrides.js";
import { getRuntimeConfig } from "../config/io.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveStoredModelOverride } from "../sessions/stored-model-overrides.js";
import { loadGatewaySessionEntryReadOnly } from "./session-utils-store.js";

export function resolveHttpChatPromptModeFromInputs(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey?: string;
  modelOverride?: string;
  storedProvider?: string;
  storedModel?: string;
  messageChannel?: string;
}): "minimal" | undefined {
  const defaultModelRef = resolveDefaultModelForAgent({
    cfg: params.cfg,
    agentId: params.agentId,
  });
  const channelOverride =
    params.modelOverride || params.storedModel
      ? null
      : resolveChannelModelOverride({
          cfg: params.cfg,
          channel: params.messageChannel,
        });
  const parsed = params.modelOverride
    ? parseModelRef(params.modelOverride, defaultModelRef.provider)
    : params.storedModel
      ? {
          provider: params.storedProvider ?? defaultModelRef.provider,
          model: params.storedModel,
        }
      : channelOverride?.model
        ? parseModelRef(channelOverride.model, defaultModelRef.provider)
        : defaultModelRef;
  const policy = resolveEffectiveToolPolicy({
    config: params.cfg,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    modelProvider: parsed?.provider,
    modelId: parsed?.model,
  });
  const profile = policy.providerProfile ?? policy.profile;
  return profile === "minimal" ? "minimal" : undefined;
}

export function resolveHttpChatPromptMode(params: {
  agentId: string;
  sessionKey?: string;
  modelOverride?: string;
  messageChannel?: string;
}): "minimal" | undefined {
  const cfg = getRuntimeConfig();
  const defaultModelRef = resolveDefaultModelForAgent({ cfg, agentId: params.agentId });
  const stored =
    params.modelOverride || !params.sessionKey
      ? null
      : resolveStoredModelOverride({
          defaultProvider: defaultModelRef.provider,
          sessionKey: params.sessionKey,
          sessionEntry: loadGatewaySessionEntryReadOnly(params.sessionKey, {
            agentId: params.agentId,
          })?.entry,
          loadSessionEntry: (sessionKey) =>
            loadGatewaySessionEntryReadOnly(sessionKey, { agentId: params.agentId })?.entry,
        });
  return resolveHttpChatPromptModeFromInputs({
    cfg,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    modelOverride: params.modelOverride,
    storedProvider: stored?.provider,
    storedModel: stored?.model,
    messageChannel: params.messageChannel,
  });
}
