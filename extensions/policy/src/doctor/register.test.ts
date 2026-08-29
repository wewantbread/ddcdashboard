import { vi } from "vitest";

vi.mock("openclaw/plugin-sdk/exec-approvals-runtime", async () => {
  const nodeFs = await import("node:fs");
  const nodePath = await import("node:path");
  const displayPath = () => {
    const stateDir = process.env.OPENCLAW_STATE_DIR?.trim();
    return stateDir
      ? nodePath.join(stateDir, "state", "openclaw.sqlite#exec_approvals_config")
      : "~/.openclaw/state/openclaw.sqlite#exec_approvals_config";
  };
  return {
    resolveExecModePolicy: ({
      mode,
      security,
      ask,
    }: {
      mode?: "deny" | "allowlist" | "ask" | "auto" | "full" | null;
      security: "deny" | "allowlist" | "full";
      ask: "off" | "on-miss" | "always";
    }) => {
      if (!mode) {
        return {
          mode:
            security === "deny"
              ? "deny"
              : security === "allowlist" && ask === "off"
                ? "allowlist"
                : security === "full" && ask !== "always"
                  ? "full"
                  : "ask",
          security,
          ask,
          autoReview: false,
        };
      }
      const policy = {
        deny: { security: "deny", ask: "off", autoReview: false },
        allowlist: { security: "allowlist", ask: "off", autoReview: false },
        ask: { security: "allowlist", ask: "on-miss", autoReview: false },
        auto: { security: "allowlist", ask: "on-miss", autoReview: true },
        full: { security: "full", ask: "off", autoReview: false },
      }[mode];
      return { mode, ...policy };
    },
    resolveExecApprovalsDisplayPath: displayPath,
    readExecApprovalsSnapshot: () => {
      const fixtureRoot =
        process.env.OPENCLAW_STATE_DIR?.trim() ?? process.env.OPENCLAW_HOME?.trim() ?? "";
      const directFixturePath = nodePath.join(fixtureRoot, "exec-approvals.json");
      const fixturePath = nodeFs.existsSync(directFixturePath)
        ? directFixturePath
        : nodePath.join(fixtureRoot, ".openclaw", "exec-approvals.json");
      try {
        const raw = nodeFs.readFileSync(fixturePath, "utf8");
        return {
          path: displayPath(),
          exists: true,
          raw,
          file: { version: 1, agents: {} },
          hash: "fixture",
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
        return {
          path: displayPath(),
          exists: false,
          raw: null,
          file: { version: 1, agents: {} },
          hash: "missing:fixture",
        };
      }
    },
  };
});

import "./register.base.test-utils.js";
import "./register.models-and-mcp.test-utils.js";
import "./register.ingress-and-secrets.test-utils.js";
import "./register.sandbox-and-tools.test-utils.js";
import "./register.gateway-data-and-approvals.test-utils.js";
