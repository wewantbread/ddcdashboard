/**
 * HTTP Chat Completions promptMode from the effective tools profile.
 * Resolves after model override / stored session model / channel mapping.
 */
import { resolveEffectiveToolPolicy } from "../agents/agent-tools.policy.js";
import { parseAgentCommandModelRef } from "../agents/command/model-ref.js";
import { resolveDefaultModelForAgent } from "../agents/model-selection.js";
import { resolveChannelModelOverride } from "../channels/model-overrides.js";
import { getRuntimeConfig } from "../config/io.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveStoredModelOverride } from "../sessions/stored-model-overrides.js";
import { sessionDeliveryChannel, sessionDeliveryOrigin } from "../utils/delivery-context.shared.js";
import { loadGatewaySessionEntryReadOnly } from "./session-utils-store.js";

export function resolveHttpChatPromptModeFromInputs(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey?: string;
  modelOverride?: string;
  storedProvider?: string;
  storedModel?: string;
  messageChannel?: string;
  groupId?: string | null;
  groupChatType?: string | null;
  groupChannel?: string | null;
  groupSubject?: string | null;
  parentSessionKey?: string | null;
  directUserIds?: (string | null | undefined)[];
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
          groupId: params.groupId,
          groupChatType: params.groupChatType,
          groupChannel: params.groupChannel,
          groupSubject: params.groupSubject,
          parentSessionKey: params.parentSessionKey,
          directUserIds: params.directUserIds,
        });
  const parsed = params.modelOverride
    ? parseAgentCommandModelRef(
        params.cfg,
        params.agentId,
        params.modelOverride,
        defaultModelRef.provider,
        {},
      )
    : params.storedModel
      ? {
          provider: params.storedProvider ?? defaultModelRef.provider,
          model: params.storedModel,
        }
      : channelOverride?.model
        ? parseAgentCommandModelRef(
            params.cfg,
            params.agentId,
            channelOverride.model,
            defaultModelRef.provider,
            {},
          )
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
  const sessionEntry = params.sessionKey
    ? loadGatewaySessionEntryReadOnly(params.sessionKey, {
        agentId: params.agentId,
      })?.entry
    : undefined;
  const origin = sessionDeliveryOrigin(sessionEntry);
  const defaultModelRef = resolveDefaultModelForAgent({ cfg, agentId: params.agentId });
  const stored =
    params.modelOverride || !params.sessionKey
      ? null
      : resolveStoredModelOverride({
          defaultProvider: defaultModelRef.provider,
          sessionKey: params.sessionKey,
          sessionEntry,
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
    messageChannel: params.messageChannel ?? sessionDeliveryChannel(sessionEntry),
    groupId: sessionEntry?.groupId,
    groupChatType: sessionEntry?.chatType ?? origin?.chatType,
    groupChannel: sessionEntry?.groupChannel,
    groupSubject: sessionEntry?.subject,
    parentSessionKey: sessionEntry?.parentSessionKey ?? params.sessionKey,
    directUserIds: [origin?.nativeDirectUserId, origin?.from, origin?.to],
  });
}
