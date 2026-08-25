import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CURRENT_SESSION_VERSION } from "../config/sessions/version.js";
import { createTestAdmittedRunContext } from "./admitted-run-context.test-support.js";
import { testing as cliBackendsTesting } from "./cli-backends.test-support.js";
import { runCliAgent } from "./cli-runner.js";
import { cliBackendLog } from "./cli-runner/log.js";

const tempDirs = new Set<string>();

afterEach(() => {
  cliBackendsTesting.resetDepsForTest();
  vi.restoreAllMocks();
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

describe("CLI terminal failure logging", () => {
  it("records one redacted warning after a real CLI subprocess exhausts recovery", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-terminal-log-"));
    tempDirs.add(dir);
    const scriptPath = path.join(dir, "fail.mjs");
    const sessionFile = path.join(dir, "agents", "main", "sessions", "session-test.jsonl");
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(
      sessionFile,
      `${JSON.stringify({
        type: "session",
        version: CURRENT_SESSION_VERSION,
        id: "session-test",
        timestamp: new Date(0).toISOString(),
        cwd: dir,
      })}\n`,
      "utf8",
    );
    const secret = "sk-abcdefghijklmnopqrstuv";
    fs.writeFileSync(
      scriptPath,
      `process.stderr.write("Authorization: Bearer ${secret}\\n"); process.exitCode = 1;\n`,
      "utf8",
    );
    cliBackendsTesting.setDepsForTest({
      resolvePluginSetupCliBackend: () => undefined,
      resolvePluginSetupRegistry: () => ({ cliBackends: [] }) as never,
      resolveRuntimeCliBackends: () => [
        {
          id: "fixture-cli",
          pluginId: "fixture",
          config: {
            command: process.execPath,
            args: [scriptPath],
            output: "text",
            input: "arg",
            sessionMode: "none",
            systemPromptWhen: "never",
          },
        },
      ],
    });
    const warn = vi.spyOn(cliBackendLog, "warn").mockImplementation(() => {});
    const runId = "run-terminal-failure";

    await expect(
      runCliAgent({
        admittedRunContext: createTestAdmittedRunContext(runId),
        sessionId: "session-test",
        sessionKey: "agent:main:private-session",
        sessionFile,
        workspaceDir: dir,
        prompt: "fail now",
        provider: "fixture-cli",
        model: "fixture-model",
        timeoutMs: 5_000,
        runId,
        config: { agents: { defaults: { workspace: dir } } },
      }),
    ).rejects.toThrow();

    const terminalWarnings = warn.mock.calls
      .map(([message]) => String(message))
      .filter((message) => message.startsWith("cli terminal failure:"));
    expect(terminalWarnings).toHaveLength(1);
    expect(terminalWarnings[0]).toContain("provider=fixture-cli");
    expect(terminalWarnings[0]).toContain("model=fixture-model");
    expect(terminalWarnings[0]).toContain(`runId=${runId}`);
    expect(terminalWarnings[0]).toContain("durationMs=");
    expect(terminalWarnings[0]).toContain("Authorization: Bearer");
    expect(terminalWarnings[0]).not.toContain(secret);
    expect(terminalWarnings[0]).not.toContain("private-session");
  });
});
