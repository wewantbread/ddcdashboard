import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  createConfigResolutionFacts,
  setConfigResolutionFacts,
} from "../config/resolution-facts.js";
import type {
  GatewayAuthConfig,
  GatewayBindMode,
  GatewayControlUiConfig,
  GatewayTrustedProxyConfig,
} from "../config/types.gateway.js";
import { makeNetworkInterfacesSnapshot } from "../test-helpers/network-interfaces.js";

vi.mock("../../packages/terminal-core/src/note.js", () => ({ note: vi.fn() }));
vi.mock("../channels/plugins/read-only.js", () => ({
  listReadOnlyChannelPluginsForConfig: vi.fn(() => []),
}));
vi.mock("../channels/read-only-account-inspect.js", () => ({
  inspectReadOnlyChannelAccount: vi.fn(async () => null),
}));
vi.mock("../secrets/target-registry-data.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../secrets/target-registry-data.js")>();
  return {
    ...actual,
    getSecretTargetRegistry: actual.getCoreSecretTargetRegistry,
  };
});

import { collectSecurityWarnings } from "./doctor-security.js";

type BoundaryOptions = {
  trustedProxies?: string[];
  token?: GatewayAuthConfig["token"];
  password?: GatewayAuthConfig["password"];
  trustedProxy?: GatewayTrustedProxyConfig;
  controlUi?: GatewayControlUiConfig;
  localInterfaces?: string[];
  interfaceLookupFails?: boolean;
  bind?: GatewayBindMode;
  customBindHost?: string;
  tailscaleMode?: "serve" | "funnel";
  secrets?: OpenClawConfig["secrets"];
  allowExecSecretRefs?: boolean;
  env?: NodeJS.ProcessEnv;
  authoritativeResolutionFacts?: boolean;
};

type BoundaryCase = {
  name: string;
  options?: BoundaryOptions;
  criticalIds?: string[];
  includes?: string[];
};

const readinessCritical = "gateway.trusted_proxy_not_ready";

const cases: BoundaryCase[] = [
  { name: "accepts one exact remote proxy" },
  { name: "accepts an exact IPv4 host CIDR", options: { trustedProxies: ["192.0.2.10/32"] } },
  {
    name: "accepts an exact IPv6 host CIDR",
    options: { trustedProxies: ["2001:db8::10/128"] },
  },
  {
    name: "proves required headers and an exact allowed user",
    options: {
      trustedProxy: {
        userHeader: "x-forwarded-user",
        requiredHeaders: ["x-forwarded-proto"],
        allowUsers: ["alice"],
      },
    },
  },
  {
    name: "accepts a separate remote proxy when another entry is local",
    options: {
      trustedProxies: ["192.0.2.10", "192.0.2.11"],
      localInterfaces: ["192.0.2.10"],
    },
  },
  {
    name: "accepts a loopback proxy only with explicit opt-in",
    options: {
      trustedProxies: ["127.0.0.1"],
      trustedProxy: { userHeader: "x-forwarded-user", allowLoopback: true },
    },
  },
  {
    name: "accepts a disabled Control UI without an origin",
    options: { controlUi: { enabled: false } },
  },
  {
    name: "ignores an inactive token SecretRef in trusted-proxy mode",
    options: {
      token: { source: "env", provider: "default", id: "UNUSED_GATEWAY_TOKEN" },
    },
  },
  {
    name: "preflights a resolvable active password SecretRef",
    options: {
      password: { source: "env", provider: "default", id: "SET_GATEWAY_PASSWORD" },
      env: { SET_GATEWAY_PASSWORD: "proxy-password-2f8a" },
    },
  },
  {
    name: "preserves an authored literal token while seeding startup origins",
    options: {
      token: "${LITERAL}",
      controlUi: { enabled: false },
      authoritativeResolutionFacts: true,
    },
    criticalIds: [readinessCritical],
    includes: ["mutually exclusive"],
  },
  {
    name: "preserves an authored literal password while seeding startup origins",
    options: {
      password: "${LITERAL}",
      controlUi: { enabled: false },
      authoritativeResolutionFacts: true,
    },
  },
  {
    name: "requires a canonical non-loopback browser origin",
    options: { controlUi: {} },
    criticalIds: [readinessCritical],
    includes: ["no canonical non-loopback browser origin"],
  },
  {
    name: "rejects a malformed browser origin",
    options: { controlUi: { allowedOrigins: ["not-an-origin"] } },
    criticalIds: [readinessCritical],
    includes: ["no canonical non-loopback browser origin"],
  },
  {
    name: "rejects a loopback-only browser origin",
    options: { controlUi: { allowedOrigins: ["http://127.0.0.1:18789"] } },
    criticalIds: [readinessCritical],
    includes: ["no canonical non-loopback browser origin"],
  },
  {
    name: "reports dangerous origin fallback with an invalid source",
    options: {
      trustedProxies: ["not-an-ip"],
      controlUi: {
        allowedOrigins: ["https://control.example.test"],
        dangerouslyAllowHostHeaderOriginFallback: true,
      },
    },
    criticalIds: [readinessCritical],
    includes: ["Host headers can widen", "invalid or unusable source"],
  },
  {
    name: "rejects a wildcard browser origin",
    options: { controlUi: { allowedOrigins: ["*"] } },
    criticalIds: [readinessCritical],
    includes: ["lets any browser origin"],
  },
  {
    name: "reports wildcard and Host-header fallback independently",
    options: {
      controlUi: {
        allowedOrigins: ["*"],
        dangerouslyAllowHostHeaderOriginFallback: true,
      },
    },
    criticalIds: [readinessCritical],
    includes: ["lets any browser origin", "Host headers can widen"],
  },
  {
    name: "rejects a sole host-interface proxy",
    options: { localInterfaces: ["192.0.2.10"] },
    criticalIds: [readinessCritical],
    includes: ["trusted_proxy_local_interface_source"],
  },
  {
    name: "rejects a sole loopback proxy without explicit opt-in",
    options: { trustedProxies: ["127.0.0.1"] },
    criticalIds: [readinessCritical],
    includes: ["loopback source", "allowLoopback is not enabled"],
  },
  {
    name: "does not let a remote proxy hide an unsafe loopback entry",
    options: { trustedProxies: ["192.0.2.10", "127.0.0.1"] },
    criticalIds: [readinessCritical],
    includes: ["loopback source", "allowLoopback is not enabled"],
  },
  {
    name: "fails closed when host-interface inspection fails",
    options: { interfaceLookupFails: true },
    criticalIds: [readinessCritical],
    includes: ["trusted_proxy_local_interface_check_failed"],
  },
  {
    name: "rejects a proxy subnet",
    options: { trustedProxies: ["192.0.2.0/24"] },
    criticalIds: [readinessCritical],
    includes: ["non-host-scoped CIDR"],
  },
  {
    name: "does not let an exact proxy hide a default-route source",
    options: { trustedProxies: ["192.0.2.10", "0.0.0.0/0"] },
    criticalIds: [readinessCritical],
    includes: ["non-host-scoped CIDR"],
  },
  {
    name: "reports an empty proxy list as one readiness failure",
    options: { trustedProxies: [] },
    criticalIds: [readinessCritical],
    includes: ["requires gateway.trustedProxies"],
  },
  {
    name: "rejects a prefix spelling the runtime parser cannot round-trip",
    options: { trustedProxies: ["192.0.2.10/3.2e1"] },
    criticalIds: [readinessCritical],
    includes: ["invalid or unusable source"],
  },
  {
    name: "reports an invalid header and proxy subnet together",
    options: {
      trustedProxies: ["192.0.2.0/24"],
      trustedProxy: { userHeader: "x forwarded user" },
    },
    criticalIds: [readinessCritical],
    includes: ["not a valid HTTP header name", "non-host-scoped CIDR"],
  },
  {
    name: "rejects an empty identity header",
    options: { trustedProxy: { userHeader: "   " } },
    criticalIds: [readinessCritical],
    includes: ["userHeader is empty"],
  },
  {
    name: "rejects an undeliverable required header",
    options: {
      trustedProxy: {
        userHeader: "x-forwarded-user",
        requiredHeaders: ["x required"],
      },
    },
    criticalIds: [readinessCritical],
    includes: ["requiredHeaders[0] is not a valid HTTP header name"],
  },
  {
    name: "rejects a prototype-key identity header",
    options: { trustedProxy: { userHeader: "__proto__" } },
    criticalIds: [readinessCritical],
    includes: ["not a deliverable HTTP header name"],
  },
  {
    name: "rejects an allowUsers entry a proxy cannot present exactly",
    options: {
      trustedProxy: { userHeader: "x-forwarded-user", allowUsers: [" alice "] },
    },
    criticalIds: [readinessCritical],
    includes: ["trusted_proxy_no_deliverable_allow_user"],
  },
  {
    name: "aggregates a shared-token conflict with an invalid source",
    options: { token: "test-token", trustedProxies: ["192.0.2.0/24"] },
    criticalIds: [readinessCritical],
    includes: ["mutually exclusive", "non-host-scoped CIDR"],
  },
  {
    name: "rejects a shared-token conflict from the environment",
    options: { env: { OPENCLAW_GATEWAY_TOKEN: "test-token" } },
    criticalIds: [readinessCritical],
    includes: ["mutually exclusive"],
  },
  {
    name: "reports startup and readiness failures together",
    options: { bind: "custom", trustedProxies: ["192.0.2.0/24"] },
    criticalIds: [readinessCritical],
    includes: ["requires gateway.customBindHost", "non-host-scoped CIDR"],
  },
  {
    name: "rejects a custom bind with an invalid host",
    options: { bind: "custom", customBindHost: "not-an-ip" },
    criticalIds: [readinessCritical],
    includes: ["requires a valid IPv4 customBindHost"],
  },
  {
    name: "rejects Tailscale serve on an exposed bind",
    options: { tailscaleMode: "serve" },
    criticalIds: [readinessCritical],
    includes: ["requires gateway bind=loopback"],
  },
  {
    name: "rejects an unresolved active env SecretRef",
    options: {
      password: { source: "env", provider: "default", id: "UNSET_GATEWAY_PASSWORD" },
    },
    criticalIds: [readinessCritical],
    includes: ["SecretRef is unresolved"],
  },
  {
    name: "does not execute an active exec SecretRef by default",
    options: {
      password: { source: "exec", provider: "vault", id: "gateway/password" },
      secrets: {
        providers: { vault: { source: "exec", command: "/nonexistent-doctor-exec-probe" } },
      },
    },
    criticalIds: [readinessCritical],
    includes: ["active exec SecretRef was skipped"],
  },
  {
    name: "executes an active exec SecretRef only when explicitly allowed",
    options: {
      password: { source: "exec", provider: "vault", id: "gateway/password" },
      secrets: {
        providers: { vault: { source: "exec", command: "/nonexistent-doctor-exec-probe" } },
      },
      allowExecSecretRefs: true,
    },
    criticalIds: [readinessCritical],
    includes: ["SecretRef is unresolved (exec:vault:gateway/password)"],
  },
];

describe("collectSecurityWarnings trusted-proxy readiness", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(cases)("$name", async ({ options = {}, criticalIds = [], includes = [] }) => {
    const networkInterfaces = vi.spyOn(os, "networkInterfaces");
    if (options.interfaceLookupFails) {
      networkInterfaces.mockImplementation(() => {
        throw new Error("synthetic interface lookup failure");
      });
    } else {
      networkInterfaces.mockReturnValue(
        makeNetworkInterfacesSnapshot({
          lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
          ...(options.localInterfaces
            ? {
                eth0: options.localInterfaces.map((address) => ({
                  address,
                  family: address.includes(":") ? ("IPv6" as const) : ("IPv4" as const),
                })),
              }
            : {}),
        }),
      );
    }

    const cfg = {
      secrets: options.secrets,
      gateway: {
        bind: options.bind ?? "lan",
        customBindHost: options.customBindHost,
        tailscale: options.tailscaleMode ? { mode: options.tailscaleMode } : undefined,
        trustedProxies: options.trustedProxies ?? ["192.0.2.10"],
        controlUi: options.controlUi ?? {
          allowedOrigins: ["https://control.example.test"],
        },
        auth: {
          mode: "trusted-proxy",
          token: options.token,
          password: options.password,
          trustedProxy: options.trustedProxy ?? { userHeader: "x-forwarded-user" },
        },
      },
    } as OpenClawConfig;
    if (options.authoritativeResolutionFacts) {
      setConfigResolutionFacts(cfg, createConfigResolutionFacts([]));
    }
    const findings = await collectSecurityWarnings(cfg, options.env ?? {}, {
      allowExecSecretRefs: options.allowExecSecretRefs,
    });
    const criticals = findings.filter((finding) => finding.severity === "critical");
    const criticalCheckIds = criticals.map((finding) => finding.checkId);
    const text = findings
      .flatMap((finding) => [finding.title, finding.detail, finding.remediation])
      .filter(Boolean)
      .join("\n");

    expect(criticalCheckIds).toEqual(criticalIds);
    for (const expected of includes) {
      expect(text).toContain(expected);
    }
    expect(findings.some((finding) => finding.checkId === "gateway.bind_no_auth")).toBe(false);
    expect(findings.some((finding) => finding.checkId === "gateway.bind_network_accessible")).toBe(
      criticalIds.length === 0,
    );
  });
});
