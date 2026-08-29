// Gateway startup runtime-config resolver.
// Normalizes bind/auth/HTTP/Tailscale/hook settings before server construction.
import type {
  GatewayAuthConfig,
  GatewayBindMode,
  GatewayTailscaleConfig,
} from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { type ResolvedGatewayAuth, resolveGatewayAuth } from "./auth.js";
import { normalizeControlUiBasePath } from "./control-ui-shared.js";
import { warnLegacyOpenClawEnvVars } from "./env-deprecation.js";
import { commitHooksConfigReload, resolveHooksConfig } from "./hooks.js";
import { defaultGatewayBindMode, resolveGatewayBindHost } from "./net.js";
import {
  assertGatewayResolvedBindPolicy,
  assertGatewayRuntimeSecurityPolicy,
} from "./runtime-security-policy.js";
import { mergeGatewayTailscaleConfig } from "./startup-auth.js";

type GatewayRuntimeConfig = {
  bindHost: string;
  controlUiEnabled: boolean;
  openAiChatCompletionsEnabled: boolean;
  openAiChatCompletionsConfig?: import("../config/types.gateway.js").GatewayHttpChatCompletionsConfig;
  openResponsesEnabled: boolean;
  openResponsesConfig?: import("../config/types.gateway.js").GatewayHttpResponsesConfig;
  strictTransportSecurityHeader?: string;
  controlUiBasePath: string;
  controlUiRoot?: string;
  resolvedAuth: ResolvedGatewayAuth;
  authMode: ResolvedGatewayAuth["mode"];
  tailscaleConfig: GatewayTailscaleConfig;
  tailscaleMode: "off" | "serve" | "funnel";
  hooksConfig: ReturnType<typeof resolveHooksConfig>;
};

/** Resolves bind, auth, HTTP, Tailscale, and hook settings for one gateway start. */
export async function resolveGatewayRuntimeConfig(params: {
  cfg: OpenClawConfig;
  port: number;
  bind?: GatewayBindMode;
  host?: string;
  controlUiEnabled?: boolean;
  openAiChatCompletionsEnabled?: boolean;
  openResponsesEnabled?: boolean;
  auth?: GatewayAuthConfig;
  tailscale?: GatewayTailscaleConfig;
}): Promise<GatewayRuntimeConfig> {
  warnLegacyOpenClawEnvVars();

  // Tailscale serve/funnel hard-requires loopback.  When bind is not
  // explicitly set, we must resolve Tailscale mode *before* choosing the
  // bind default so that container auto-detection does not override the
  // Tailscale loopback constraint.
  const tailscaleModeEarly =
    (params.tailscale?.mode ?? params.cfg.gateway?.tailscale?.mode) || "off";
  const bindExplicit = params.bind ?? params.cfg.gateway?.bind;
  const bindMode =
    bindExplicit ?? (tailscaleModeEarly !== "off" ? "loopback" : defaultGatewayBindMode());
  const customBindHost = params.cfg.gateway?.customBindHost;
  const bindHost = params.host ?? (await resolveGatewayBindHost(bindMode, customBindHost));
  assertGatewayResolvedBindPolicy({ bindMode, bindHost, customBindHost });
  const controlUiEnabled =
    params.controlUiEnabled ?? params.cfg.gateway?.controlUi?.enabled ?? true;
  const openAiChatCompletionsConfig = params.cfg.gateway?.http?.endpoints?.chatCompletions;
  const openAiChatCompletionsEnabled =
    params.openAiChatCompletionsEnabled ?? openAiChatCompletionsConfig?.enabled ?? false;
  const openResponsesConfig = params.cfg.gateway?.http?.endpoints?.responses;
  const openResponsesEnabled = params.openResponsesEnabled ?? openResponsesConfig?.enabled ?? false;
  const strictTransportSecurityConfig =
    params.cfg.gateway?.http?.securityHeaders?.strictTransportSecurity;
  // HSTS is opt-in and must stay absent for blank strings; local HTTP and reverse-proxy
  // setups rely on not emitting a malformed or accidentally inherited header.
  const strictTransportSecurityHeader =
    strictTransportSecurityConfig === false
      ? undefined
      : typeof strictTransportSecurityConfig === "string" &&
          strictTransportSecurityConfig.trim().length > 0
        ? strictTransportSecurityConfig.trim()
        : undefined;
  const controlUiBasePath = normalizeControlUiBasePath(params.cfg.gateway?.controlUi?.basePath);
  const controlUiRootRaw = params.cfg.gateway?.controlUi?.root;
  const controlUiRoot =
    typeof controlUiRootRaw === "string" && controlUiRootRaw.trim().length > 0
      ? controlUiRootRaw.trim()
      : undefined;
  const tailscaleBase = params.cfg.gateway?.tailscale ?? {};
  const tailscaleOverrides = params.tailscale ?? {};
  const tailscaleConfig = mergeGatewayTailscaleConfig(tailscaleBase, tailscaleOverrides);
  const tailscaleMode = tailscaleConfig.mode ?? "off";
  const resolvedAuth = resolveGatewayAuth({
    authConfig: params.cfg.gateway?.auth,
    authOverride: params.auth,
    env: process.env,
    tailscaleMode,
  });
  const authMode: ResolvedGatewayAuth["mode"] = resolvedAuth.mode;
  const hooksConfig = resolveHooksConfig(params.cfg);
  const trustedProxies = params.cfg.gateway?.trustedProxies ?? [];
  const controlUiAllowedOrigins = (params.cfg.gateway?.controlUi?.allowedOrigins ?? [])
    .map((value) => value.trim())
    .filter(Boolean);
  const dangerouslyAllowHostHeaderOriginFallback =
    params.cfg.gateway?.controlUi?.dangerouslyAllowHostHeaderOriginFallback === true;

  assertGatewayRuntimeSecurityPolicy({
    resolvedAuth,
    rawAuthConfig: params.cfg.gateway?.auth,
    tailscaleMode,
    bindHost,
    port: params.port,
    controlUiEnabled,
    controlUiAllowedOrigins,
    dangerouslyAllowHostHeaderOriginFallback,
    trustedProxies,
  });

  if (hooksConfig) {
    commitHooksConfigReload();
  }

  return {
    bindHost,
    controlUiEnabled,
    openAiChatCompletionsEnabled,
    openAiChatCompletionsConfig: openAiChatCompletionsConfig
      ? { ...openAiChatCompletionsConfig, enabled: openAiChatCompletionsEnabled }
      : undefined,
    openResponsesEnabled,
    openResponsesConfig: openResponsesConfig
      ? { ...openResponsesConfig, enabled: openResponsesEnabled }
      : undefined,
    strictTransportSecurityHeader,
    controlUiBasePath,
    controlUiRoot,
    resolvedAuth,
    authMode,
    tailscaleConfig,
    tailscaleMode,
    hooksConfig,
  };
}
