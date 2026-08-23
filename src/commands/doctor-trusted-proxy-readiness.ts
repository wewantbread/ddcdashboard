/** Runtime-aligned trusted-proxy readiness checks used by Doctor security diagnostics. */
import { validateHeaderName, validateHeaderValue } from "node:http";
import { normalizeIpAddress, parseCanonicalIpAddress } from "@openclaw/net-policy/ip";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import type { GatewayBindMode, OpenClawConfig } from "../config/config.js";
import {
  ensureControlUiAllowedOriginsForNonLoopbackBind,
  resolveGatewayPortWithDefault,
} from "../config/gateway-control-ui-origins.js";
import { copyConfigResolutionFacts } from "../config/resolution-facts.js";
import { canMaterializeGatewayAuthSecretRefsWithoutExec } from "../gateway/auth-config-utils.js";
import {
  assertGatewayAuthConfigured,
  authorizeTrustedProxyIdentity,
  resolveGatewayAuth,
} from "../gateway/auth.js";
import { isLoopbackAddress, isLoopbackHost, isTrustedProxyAddress } from "../gateway/net.js";
import { checkBrowserOrigin } from "../gateway/origin-check.js";
import {
  assertGatewayResolvedBindPolicy,
  assertGatewayRuntimeSecurityPolicy,
} from "../gateway/runtime-security-policy.js";
import { ensureGatewayStartupAuth } from "../gateway/startup-auth.js";

type TrustedProxySource = {
  entry: string;
  address: string;
  loopback: boolean;
};

type TrustedProxyReadinessResult = {
  problems: string[];
  execSecretRefSkipped: boolean;
};

const EXEC_SECRET_REF_SKIPPED_PROBLEM =
  "Gateway startup auth readiness could not be verified because an active exec SecretRef was skipped.";

// These ipaddr.js ranges cannot originate a proxy TCP connection.
const UNUSABLE_PROXY_SOURCE_RANGES = new Set(["unspecified", "broadcast", "multicast"]);

function parseHostScopedTrustedProxySource(entry: string): TrustedProxySource | undefined {
  const parts = entry.split("/");
  if (parts.length > 2) {
    return undefined;
  }
  const rawAddress = parts[0]?.trim() ?? "";
  const parsedAddress = parseCanonicalIpAddress(rawAddress);
  if (!parsedAddress) {
    return undefined;
  }
  const hostBits = parsedAddress.kind() === "ipv6" ? 128 : 32;
  const prefix = parts.length === 1 ? hostBits : Number(parts[1]?.trim());
  // Each trusted address can assert identity headers, so Doctor only treats
  // exact proxy hosts as ready even though runtime supports broader CIDRs.
  if (!Number.isInteger(prefix) || prefix !== hostBits) {
    return undefined;
  }
  const address = normalizeIpAddress(rawAddress);
  const normalizedAddress = parseCanonicalIpAddress(address);
  if (
    !address ||
    !normalizedAddress ||
    UNUSABLE_PROXY_SOURCE_RANGES.has(normalizedAddress.range())
  ) {
    return undefined;
  }
  // Round-trip through the runtime matcher so permissive numeric parsing here
  // cannot approve a CIDR spelling the Gateway would reject.
  return isTrustedProxyAddress(address, [entry])
    ? { entry, address, loopback: isLoopbackAddress(address) }
    : undefined;
}

function collectControlUiOriginProblems(cfg: OpenClawConfig): string[] {
  const allowedOrigins = (cfg.gateway?.controlUi?.allowedOrigins ?? [])
    .map((origin) => normalizeOptionalString(origin))
    .filter((origin): origin is string => origin !== undefined);
  const problems: string[] = [];
  if (allowedOrigins.includes("*")) {
    problems.push(
      'gateway.controlUi.allowedOrigins contains "*", which lets any browser origin present trusted-proxy credentials.',
    );
  }
  if (cfg.gateway?.controlUi?.dangerouslyAllowHostHeaderOriginFallback === true) {
    problems.push(
      "gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback is enabled, so Host headers can widen the browser origin boundary.",
    );
  }
  if (cfg.gateway?.controlUi?.enabled === false) {
    return problems;
  }
  const hasRuntimeMatchableProxyOrigin = allowedOrigins.some((origin) => {
    if (origin === "*") {
      return false;
    }
    const result = checkBrowserOrigin({ origin, allowedOrigins: [origin] });
    if (!result.ok || result.matchedBy !== "allowlist") {
      return false;
    }
    try {
      return !isLoopbackHost(new URL(origin).hostname);
    } catch {
      return false;
    }
  });
  if (!hasRuntimeMatchableProxyOrigin) {
    problems.push(
      "gateway.controlUi.allowedOrigins has no canonical non-loopback browser origin that the Gateway runtime can match.",
    );
  }
  return problems;
}

type ProxySourceProbe = { ok: true } | { ok: false; reason: string };

function probeProxySource(
  source: TrustedProxySource,
  auth: ReturnType<typeof resolveGatewayAuth>,
): ProxySourceProbe {
  const trustedProxy = auth.trustedProxy;
  if (!trustedProxy) {
    return { ok: false, reason: "trusted_proxy_config_missing" };
  }
  const allowUsers = trustedProxy.allowUsers ?? [];
  const userHeader = normalizeLowercaseStringOrEmpty(trustedProxy.userHeader);
  const user =
    allowUsers.length === 0
      ? "doctor-probe"
      : allowUsers.find((entry) => {
          // Runtime trims the presented identity, then compares it with the
          // configured entry exactly. Whitespace-wrapped entries cannot match.
          if (normalizeOptionalString(entry) !== entry) {
            return false;
          }
          try {
            validateHeaderValue(userHeader, entry);
            return true;
          } catch {
            return false;
          }
        });
  if (!user) {
    return { ok: false, reason: "trusted_proxy_no_deliverable_allow_user" };
  }

  // SAFETY: this null-prototype object is populated only with validated string header values.
  const headers = Object.create(null) as Record<string, string>;
  for (const header of trustedProxy.requiredHeaders ?? []) {
    headers[normalizeLowercaseStringOrEmpty(header)] = "present";
  }
  headers[userHeader] = user;

  const result = authorizeTrustedProxyIdentity({
    remoteAddress: source.address,
    headers,
    trustedProxies: [source.entry],
    trustedProxyConfig: trustedProxy,
  });
  return "user" in result ? { ok: true } : { ok: false, reason: result.reason };
}

/** Validate static proxy policy against the canonical trusted-proxy identity checks. */
function collectTrustedProxyPolicyProblems(params: {
  cfg: OpenClawConfig;
  auth: ReturnType<typeof resolveGatewayAuth>;
}): string[] {
  const originProblems = collectControlUiOriginProblems(params.cfg);
  const staticProblems: string[] = [];
  try {
    assertGatewayAuthConfigured(params.auth, params.cfg.gateway?.auth);
  } catch (error) {
    staticProblems.push(
      error instanceof Error ? error.message : "Gateway rejected the trusted-proxy config.",
    );
  }

  const trustedProxy = params.auth.trustedProxy;
  if (!trustedProxy) {
    if (staticProblems.length === 0) {
      staticProblems.push("Gateway rejected the trusted-proxy config.");
    }
  } else {
    for (const [path, header] of [
      ["gateway.auth.trustedProxy.userHeader", trustedProxy.userHeader],
      ...(trustedProxy.requiredHeaders ?? []).map(
        (entry, index) => [`gateway.auth.trustedProxy.requiredHeaders[${index}]`, entry] as const,
      ),
    ] as const) {
      const normalizedHeader = normalizeLowercaseStringOrEmpty(header);
      // The runtime assertion above owns the empty userHeader diagnostic.
      if (path === "gateway.auth.trustedProxy.userHeader" && normalizedHeader === "") {
        continue;
      }
      if (normalizedHeader === "__proto__") {
        staticProblems.push(
          `${path} is not a deliverable HTTP header name, so a proxy cannot supply it.`,
        );
        continue;
      }
      try {
        validateHeaderName(normalizedHeader);
      } catch {
        staticProblems.push(
          `${path} is not a valid HTTP header name, so a proxy cannot supply it.`,
        );
      }
    }
  }

  const trustedProxies = (params.cfg.gateway?.trustedProxies ?? [])
    .map((entry) => normalizeOptionalString(entry))
    .filter((entry): entry is string => entry !== undefined);
  if (trustedProxies.length === 0) {
    staticProblems.push(
      "gateway auth mode=trusted-proxy requires gateway.trustedProxies to be configured with at least one proxy IP",
    );
  }
  const sources = trustedProxies.map(parseHostScopedTrustedProxySource);
  if (sources.some((source) => source === undefined)) {
    staticProblems.push(
      "gateway.trustedProxies includes an invalid or unusable source, or a non-host-scoped CIDR; use canonical usable unicast proxy IPs (exact, /32, or /128).",
    );
  }
  if (trustedProxy?.allowLoopback !== true && sources.some((source) => source?.loopback === true)) {
    staticProblems.push(
      "gateway.trustedProxies includes a loopback source, but gateway.auth.trustedProxy.allowLoopback is not enabled.",
    );
  }
  if (staticProblems.length > 0) {
    return [...originProblems, ...staticProblems];
  }

  const failureReasons = new Set<string>();
  for (const source of sources) {
    if (!source) {
      continue;
    }
    const probe = probeProxySource(source, params.auth);
    if (probe.ok) {
      return originProblems;
    }
    failureReasons.add(probe.reason);
  }
  return [
    ...originProblems,
    `No configured proxy source can pass the Gateway's source and identity checks in this runtime environment (runtime reasons: ${[...failureReasons].join(", ")}).`,
  ];
}

/**
 * Inspect the complete Doctor readiness boundary without executing an exec-backed
 * SecretRef unless the operator opted in. The caller supplies its resolved bind
 * facts so exposure classification and startup-policy validation cannot diverge.
 */
export async function inspectTrustedProxyReadiness(params: {
  cfg: OpenClawConfig;
  auth: ReturnType<typeof resolveGatewayAuth>;
  bindMode?: GatewayBindMode;
  bindHost: string;
  configuredBind: string;
  allowExecSecretRefs?: boolean;
  env?: NodeJS.ProcessEnv;
}): Promise<TrustedProxyReadinessResult> {
  const seeded = ensureControlUiAllowedOriginsForNonLoopbackBind(params.cfg, {
    runtimeBind: params.bindMode,
  });
  if (seeded.config !== params.cfg) {
    copyConfigResolutionFacts(params.cfg, seeded.config);
  }
  const env = params.env ?? process.env;
  const canPreflightAuthSecretRefs =
    params.allowExecSecretRefs === true ||
    canMaterializeGatewayAuthSecretRefsWithoutExec({
      cfg: seeded.config,
      env,
      mode: seeded.config.gateway?.auth?.mode,
      hasPasswordOverride: false,
      hasTokenOverride: false,
      hasPasswordFallback: Boolean(normalizeOptionalString(env.OPENCLAW_GATEWAY_PASSWORD)),
      hasTokenFallback: Boolean(normalizeOptionalString(env.OPENCLAW_GATEWAY_TOKEN)),
    });

  let startupProblem: string | undefined;
  let startupAuth = params.auth;
  if (canPreflightAuthSecretRefs) {
    try {
      startupAuth = (
        await ensureGatewayStartupAuth({
          cfg: seeded.config,
          env,
          warn: () => {},
        })
      ).auth;
    } catch (error) {
      startupProblem = error instanceof Error ? error.message : String(error);
    }
  }

  if (!startupProblem) {
    try {
      if (!params.bindMode) {
        throw new Error(`gateway.bind=${JSON.stringify(params.configuredBind)} is not supported`);
      }
      assertGatewayResolvedBindPolicy({
        bindMode: params.bindMode,
        bindHost: params.bindHost,
        customBindHost: seeded.config.gateway?.customBindHost,
      });
      const tailscaleMode = seeded.config.gateway?.tailscale?.mode ?? "off";
      assertGatewayRuntimeSecurityPolicy({
        resolvedAuth: startupAuth,
        rawAuthConfig: seeded.config.gateway?.auth,
        tailscaleMode,
        bindHost: params.bindHost,
        port: resolveGatewayPortWithDefault(params.cfg.gateway?.port),
        controlUiEnabled: seeded.config.gateway?.controlUi?.enabled ?? true,
        controlUiAllowedOrigins: (seeded.config.gateway?.controlUi?.allowedOrigins ?? [])
          .map((origin) => origin.trim())
          .filter(Boolean),
        dangerouslyAllowHostHeaderOriginFallback:
          seeded.config.gateway?.controlUi?.dangerouslyAllowHostHeaderOriginFallback === true,
        trustedProxies: seeded.config.gateway?.trustedProxies ?? [],
      });
    } catch (error) {
      startupProblem = error instanceof Error ? error.message : String(error);
    }
  }

  const execSecretRefSkipped = !startupProblem && !canPreflightAuthSecretRefs;
  const problems = collectTrustedProxyPolicyProblems({ cfg: params.cfg, auth: params.auth });
  if (startupProblem) {
    problems.push(startupProblem);
  } else if (execSecretRefSkipped) {
    problems.push(EXEC_SECRET_REF_SKIPPED_PROBLEM);
  }
  return { problems: [...new Set(problems)], execSecretRefSkipped };
}
