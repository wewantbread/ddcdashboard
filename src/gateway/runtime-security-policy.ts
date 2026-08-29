// Side-effect-free Gateway bind, authentication, and exposure validation.
import type { GatewayAuthConfig, GatewayBindMode } from "../config/types.gateway.js";
import {
  formatUnsafeGatewayTailscaleNoAuthMessage,
  isUnsafeGatewayTailscaleNoAuth,
} from "../shared/gateway-tailscale-auth-policy.js";
import { assertGatewayAuthConfigured, type ResolvedGatewayAuth } from "./auth.js";
import { isLoopbackHost, isValidIPv4 } from "./net.js";

/** Validate a resolved bind without repeating the runtime's fallback rules in diagnostics. */
export function assertGatewayResolvedBindPolicy(params: {
  bindMode: GatewayBindMode;
  bindHost: string;
  customBindHost?: string;
}): void {
  if (params.bindMode === "loopback" && !isLoopbackHost(params.bindHost)) {
    throw new Error(
      `gateway bind=loopback resolved to non-loopback host ${params.bindHost}; refusing fallback to a network bind`,
    );
  }
  if (params.bindMode === "tailnet" && params.bindHost === "0.0.0.0") {
    throw new Error(
      "gateway bind=tailnet could not resolve a Tailscale or loopback address; refusing wildcard fallback",
    );
  }
  if (params.bindMode !== "custom") {
    return;
  }
  const configuredCustomBindHost = params.customBindHost?.trim();
  if (!configuredCustomBindHost) {
    throw new Error("gateway.bind=custom requires gateway.customBindHost");
  }
  if (!isValidIPv4(configuredCustomBindHost)) {
    throw new Error(
      `gateway.bind=custom requires a valid IPv4 customBindHost (got ${configuredCustomBindHost})`,
    );
  }
  if (params.bindHost !== configuredCustomBindHost) {
    throw new Error(
      `gateway bind=custom requested ${configuredCustomBindHost} but resolved ${params.bindHost}; refusing fallback`,
    );
  }
}

/** Validate prepared Gateway auth/exposure facts without resolving config or mutating runtime state. */
export function assertGatewayRuntimeSecurityPolicy(params: {
  resolvedAuth: ResolvedGatewayAuth;
  rawAuthConfig?: GatewayAuthConfig;
  tailscaleMode: "off" | "serve" | "funnel";
  bindHost: string;
  port: number;
  controlUiEnabled: boolean;
  controlUiAllowedOrigins: readonly string[];
  dangerouslyAllowHostHeaderOriginFallback: boolean;
  trustedProxies: readonly string[];
}): void {
  const authMode = params.resolvedAuth.mode;
  const hasToken =
    typeof params.resolvedAuth.token === "string" && params.resolvedAuth.token.trim().length > 0;
  const hasPassword =
    typeof params.resolvedAuth.password === "string" &&
    params.resolvedAuth.password.trim().length > 0;
  // Non-loopback binds need a concrete shared secret unless auth is delegated to a
  // trusted proxy; mode alone is not enough because env/config resolution may be empty.
  const hasSharedSecret =
    (authMode === "token" && hasToken) || (authMode === "password" && hasPassword);

  assertGatewayAuthConfigured(params.resolvedAuth, params.rawAuthConfig);
  if (params.tailscaleMode === "funnel" && authMode !== "password") {
    throw new Error(
      "tailscale funnel requires gateway auth mode=password (set gateway.auth.password or OPENCLAW_GATEWAY_PASSWORD)",
    );
  }
  if (isUnsafeGatewayTailscaleNoAuth({ authMode, tailscaleMode: params.tailscaleMode })) {
    throw new Error(formatUnsafeGatewayTailscaleNoAuthMessage(params.tailscaleMode));
  }
  if (params.tailscaleMode !== "off" && !isLoopbackHost(params.bindHost)) {
    throw new Error("tailscale serve/funnel requires gateway bind=loopback (127.0.0.1)");
  }
  if (!isLoopbackHost(params.bindHost) && !hasSharedSecret && authMode !== "trusted-proxy") {
    throw new Error(
      `refusing to bind gateway to ${params.bindHost}:${params.port} without auth (set gateway.auth.token/password, or set OPENCLAW_GATEWAY_TOKEN/OPENCLAW_GATEWAY_PASSWORD; legacy CLAWDBOT_* and MOLTBOT_* environment variables are ignored)`,
    );
  }
  if (
    params.controlUiEnabled &&
    !isLoopbackHost(params.bindHost) &&
    params.controlUiAllowedOrigins.length === 0 &&
    !params.dangerouslyAllowHostHeaderOriginFallback
  ) {
    // Remote Control UI must use explicit origins unless the operator deliberately accepts
    // Host-header fallback; otherwise any reachable host name can become a browser origin.
    throw new Error(
      "non-loopback Control UI requires gateway.controlUi.allowedOrigins (set explicit origins), or set gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback=true to use Host-header origin fallback mode",
    );
  }
  if (authMode === "trusted-proxy" && params.trustedProxies.length === 0) {
    // Trusted-proxy auth trusts headers only after the request has matched an allowed proxy IP.
    // Starting without that list would convert the mode into unauthenticated header spoofing.
    throw new Error(
      "gateway auth mode=trusted-proxy requires gateway.trustedProxies to be configured with at least one proxy IP",
    );
  }
}
