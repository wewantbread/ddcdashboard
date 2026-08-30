// Codex tests cover attempt context plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  embeddedAgentLog,
  type EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  clearMemoryPluginState,
  registerMemoryCapability,
} from "openclaw/plugin-sdk/memory-host-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildCodexOpenClawPromptContext,
  buildCodexWatchedSessionsContext,
  buildCodexWorkspaceBootstrapContext,
  buildCodexSystemPromptReport,
  readContextEngineThreadBootstrapProjection,
  readMirroredSessionHistoryMessages,
  resolveContextEngineBootstrapProjectionDecision,
} from "./attempt-context.js";
import type { CodexDynamicToolSpec } from "./protocol.js";
import type { CodexAppServerContextEngineBinding } from "./session-binding.js";
import { useAutoCleanupTempDirTracker } from "./test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  vi.restoreAllMocks();
  clearMemoryPluginState();
});

describe("Codex app-server attempt context", () => {
  it("treats missing mirrored session history as empty without hook warning", async () => {
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-attempt-context-history-"));
    const sessionFile = path.join(dir, "session.jsonl");
    try {
      await expect(
        readMirroredSessionHistoryMessages({
          sessionFile,
          sessionId: "codex-session",
          sessionKey: "codex-session",
        }),
      ).resolves.toEqual([]);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("returns a run context report without deferred Codex dynamic tool schemas", () => {
    const tools = [
      {
        type: "function",
        name: "message",
        description: "Send a message.",
        inputSchema: {
          type: "object",
          properties: {
            text: { type: "string" },
          },
        },
      },
      {
        type: "namespace",
        name: "openclaw",
        description: "",
        tools: [
          {
            type: "function",
            name: "web_search",
            description: "Search the web.",
            inputSchema: {
              type: "object",
              properties: {
                query: { type: "string" },
              },
            },
            deferLoading: true,
          },
        ],
      },
    ] as CodexDynamicToolSpec[];

    const report = buildCodexSystemPromptReport({
      attempt: {
        sessionId: "session-1",
        provider: "codex",
        modelId: "gpt-5.4-codex",
      } as EmbeddedRunAttemptParams,
      sessionKey: "agent:main:session-1",
      workspaceDir: path.join("tmp", "workspace"),
      developerInstructions: "test developer instructions",
      workspaceBootstrapContext: {
        bootstrapFiles: [],
        contextFiles: [],
        inheritsAgentWorkspace: false,
        agentWorkspaceDeveloperInstructionsAllowed: true,
        nativeProjectDocNeedsOpenClawCarrier: false,
        nativeProjectInstructionSnapshotAllowed: true,
        promptContextFiles: [],
      },
      skillsPrompt: "",
      tools,
    });

    expect(report.source).toBe("run");
    expect(report.provider).toBe("codex");
    expect(report.model).toBe("gpt-5.4-codex");
    expect(report.systemPrompt.chars).toBeGreaterThan(0);
    expect(report.systemPrompt.hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(report.skills.hash).toMatch(/^[a-f0-9]{64}$/u);

    const message = report.tools.entries.find((tool) => tool.name === "message");
    const webSearch = report.tools.entries.find((tool) => tool.name === "web_search");
    expect(message?.schemaChars).toBeGreaterThan(0);
    expect(message?.summaryHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(message?.schemaHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(webSearch?.schemaChars).toBe(0);
    expect(webSearch?.summaryHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(webSearch?.schemaHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(report.tools.schemaChars).toBe(message?.schemaChars);
  });

  it("carries configured AGENTS.md when a sandbox changes the execution root", async () => {
    const workspaceDir = tempDirs.make("codex-memory-workspace-");
    const sandboxWorkspaceDir = tempDirs.make("codex-memory-sandbox-");
    const memorySummary = "Sandboxed turns need bounded memory fallback.";
    const agentsGuidance = "Sandboxed turns still follow the agent operating framework.";
    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), memorySummary);
    await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), agentsGuidance);

    const context = await buildCodexWorkspaceBootstrapContext({
      params: {
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        config: {
          agents: {
            defaults: {
              workspace: workspaceDir,
            },
          },
        },
      } as EmbeddedRunAttemptParams,
      resolvedWorkspace: workspaceDir,
      executionWorkspace: sandboxWorkspaceDir,
      effectiveWorkspace: sandboxWorkspaceDir,
      sessionKey: "agent:main:session-1",
      sessionAgentId: "main",
      memoryToolNames: ["memory_search", "memory_get"],
      ringZeroActive: false,
    });

    expect(context.memoryReferenceFiles).toEqual([
      { path: path.join(workspaceDir, "MEMORY.md"), content: memorySummary },
    ]);
    expect(context.promptContext).toBeUndefined();
    expect(context.threadDeveloperInstructions).toContain("OpenClaw Agent Workspace Instructions");
    expect(context.threadDeveloperInstructions).toContain(agentsGuidance);
    expect(context.threadDeveloperInstructions).not.toContain("native project-doc discovery");
    expect(context.agentWorkspaceDeveloperInstructions).toContain(agentsGuidance);
    expect(context.threadDeveloperInstructionFiles).toHaveLength(1);
    expect(context.memoryToolRouted).toBe(true);
  });

  it("passes agent context to Codex memory collaboration guidance", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-agent-memory-"));
    let observedContext:
      | { agentId?: string; agentSessionKey?: string; sandboxed?: boolean }
      | undefined;
    registerMemoryCapability("memory-core", {
      promptBuilder: (context) => {
        observedContext = context;
        return [
          "## Agent Memory",
          `agent=${context.agentId} session=${context.agentSessionKey}`,
          "",
        ];
      },
    });

    try {
      const context = await buildCodexWorkspaceBootstrapContext({
        params: {
          sessionId: "session-1",
          sessionKey: "agent:marketing-agent:session-1",
          config: {
            agents: {
              defaults: { workspace: workspaceDir },
              list: [{ id: "marketing-agent", default: true, workspace: workspaceDir }],
            },
          },
        } as EmbeddedRunAttemptParams,
        resolvedWorkspace: workspaceDir,
        effectiveWorkspace: workspaceDir,
        sessionKey: "agent:marketing-agent:session-1",
        sessionAgentId: "marketing-agent",
        memoryToolNames: ["memory_search", "memory_get"],
        ringZeroActive: false,
        sandboxed: true,
      });

      expect(context.memoryToolRouted).toBe(true);
      expect(observedContext).toMatchObject({
        agentId: "marketing-agent",
        agentSessionKey: "agent:marketing-agent:session-1",
        sandboxed: true,
      });
      expect(context.memoryCollaborationInstructions).toContain(
        "agent=marketing-agent session=agent:marketing-agent:session-1",
      );
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("defers same-workspace AGENTS.md authority to native Codex discovery", async () => {
    const workspaceDir = tempDirs.make("codex-agent-instructions-");
    const agentsGuidance = "Canonical agent operating instructions";
    await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), agentsGuidance);

    try {
      const context = await buildCodexWorkspaceBootstrapContext({
        params: {
          sessionId: "session-1",
          sessionKey: "agent:main:session-1",
          config: { agents: { defaults: { workspace: workspaceDir } } },
        } as EmbeddedRunAttemptParams,
        resolvedWorkspace: workspaceDir,
        executionWorkspace: workspaceDir,
        effectiveWorkspace: workspaceDir,
        sessionKey: "agent:main:session-1",
        sessionAgentId: "main",
        memoryToolNames: [],
        ringZeroActive: false,
      });

      expect(context.inheritsAgentWorkspace).toBe(false);
      expect(context.threadDeveloperInstructions).toBeUndefined();
      expect(context.agentWorkspaceDeveloperInstructions).toBeUndefined();
      expect(context.threadDeveloperInstructionFiles).toEqual([]);
      expect(context.promptContext).toBeUndefined();
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("does not duplicate the native root-to-cwd AGENTS.md hierarchy", async () => {
    const workspaceDir = tempDirs.make("codex-agent-hierarchy-");
    const nestedDir = path.join(workspaceDir, "packages", "worker");
    const rootGuidance = "Keep the established root policy.";
    const nestedGuidance = "Keep the established nested policy.";
    await fs.mkdir(path.join(workspaceDir, ".git"), { recursive: true });
    await fs.mkdir(nestedDir, { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), rootGuidance);
    await fs.writeFile(path.join(nestedDir, "AGENTS.md"), nestedGuidance);

    const context = await buildCodexWorkspaceBootstrapContext({
      params: {
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        config: { agents: { defaults: { workspace: workspaceDir } } },
      } as EmbeddedRunAttemptParams,
      resolvedWorkspace: workspaceDir,
      executionWorkspace: workspaceDir,
      effectiveWorkspace: workspaceDir,
      effectiveCwd: nestedDir,
      sessionKey: "agent:main:session-1",
      sessionAgentId: "main",
      memoryToolNames: [],
      ringZeroActive: false,
    });

    expect(context.threadDeveloperInstructions).toBeUndefined();
    expect(context.agentWorkspaceDeveloperInstructions).toBeUndefined();
  });

  it("inherits agent workspace instructions when Codex executes in another folder", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-agent-workspace-"));
    const executionDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-execution-workspace-"));
    await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), "Canonical agent instructions");
    await fs.writeFile(path.join(workspaceDir, "SOUL.md"), "Canonical agent soul");
    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "Canonical agent memory");
    await fs.writeFile(path.join(executionDir, "AGENTS.md"), "Execution project instructions");

    try {
      const context = await buildCodexWorkspaceBootstrapContext({
        params: {
          sessionId: "session-1",
          sessionKey: "agent:main:session-1",
          config: { agents: { defaults: { workspace: workspaceDir } } },
        } as EmbeddedRunAttemptParams,
        resolvedWorkspace: workspaceDir,
        executionWorkspace: executionDir,
        effectiveWorkspace: executionDir,
        sessionKey: "agent:main:session-1",
        sessionAgentId: "main",
        memoryToolNames: ["memory_search", "memory_get"],
        ringZeroActive: false,
      });

      expect(context.threadDeveloperInstructions).toContain("Canonical agent instructions");
      expect(context.threadDeveloperInstructions).toContain(
        "OpenClaw Agent Workspace Instructions",
      );
      expect(context.threadDeveloperInstructions).toContain(path.join(workspaceDir, "AGENTS.md"));
      expect(context.threadDeveloperInstructions).not.toContain("Canonical agent soul");
      expect(context.threadDeveloperInstructions).not.toContain("Execution project instructions");
      expect(context.threadDeveloperInstructions).not.toContain(
        path.join(executionDir, "AGENTS.md"),
      );
      expect(context.turnScopedDeveloperInstructions).toContain("Canonical agent soul");
      expect(context.turnScopedDeveloperInstructions).not.toContain("Canonical agent instructions");
      expect(context.memoryToolRouted).toBe(true);
      expect(context.promptContext).toBeUndefined();
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
      await fs.rm(executionDir, { recursive: true, force: true });
    }
  });

  it("leaves same-workspace sandbox project documents owned by the selected environment", async () => {
    const workspaceDir = tempDirs.make("codex-selected-environment-workspace-");
    await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), "Selected-environment policy");

    const context = await buildCodexWorkspaceBootstrapContext({
      params: {
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        config: { agents: { defaults: { workspace: workspaceDir } } },
      } as EmbeddedRunAttemptParams,
      resolvedWorkspace: workspaceDir,
      executionWorkspace: workspaceDir,
      effectiveWorkspace: workspaceDir,
      effectiveCwd: workspaceDir,
      sessionKey: "agent:main:session-1",
      sessionAgentId: "main",
      memoryToolNames: [],
      ringZeroActive: false,
      sandboxed: true,
    });

    expect(context.nativeProjectInstructionSnapshotAllowed).toBe(false);
    expect(context.nativeProjectDocNeedsOpenClawCarrier).toBe(false);
    expect(context.threadDeveloperInstructions).toBeUndefined();
    expect(context.agentWorkspaceDeveloperInstructions).toBeUndefined();
  });

  it.each([
    {
      name: "message-only",
      overrides: {
        toolsAllow: ["message"],
        sourceReplyDeliveryMode: "message_tool_only",
      },
    },
    { name: "tool-disabled", overrides: { disableTools: true } },
    {
      name: "lightweight heartbeat",
      overrides: { bootstrapContextMode: "lightweight", bootstrapContextRunKind: "heartbeat" },
    },
  ])("keeps $name cross-workspace turns free of agent instructions", async ({ overrides }) => {
    const workspaceDir = tempDirs.make("codex-isolated-agent-workspace-");
    const executionDir = tempDirs.make("codex-isolated-execution-workspace-");
    await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), "Ambient agent instructions");

    const context = await buildCodexWorkspaceBootstrapContext({
      params: {
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        config: { agents: { defaults: { workspace: workspaceDir } } },
        ...overrides,
      } as EmbeddedRunAttemptParams,
      resolvedWorkspace: workspaceDir,
      executionWorkspace: executionDir,
      effectiveWorkspace: executionDir,
      sessionKey: "agent:main:session-1",
      sessionAgentId: "main",
      memoryToolNames: [],
      ringZeroActive: false,
    });

    expect(context.inheritsAgentWorkspace).toBe(true);
    expect(context.agentWorkspaceDeveloperInstructionsAllowed).toBe(false);
    expect(context.threadDeveloperInstructions).toBeUndefined();
    expect(context.threadDeveloperInstructionFiles).toEqual([]);
  });

  it("keeps ambient workspace instructions out of overlapping ring-zero restrictions", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-ring-zero-workspace-"));
    const executionDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-ring-zero-execution-"));
    await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), "Ambient workspace instructions");

    try {
      const context = await buildCodexWorkspaceBootstrapContext({
        params: {
          sessionId: "session-1",
          sessionKey: "agent:openclaw:session-1",
          toolsAllow: ["openclaw"],
          pluginHarnessToolPolicyRestricted: true,
          config: { agents: { defaults: { workspace: workspaceDir } } },
        } as EmbeddedRunAttemptParams,
        resolvedWorkspace: workspaceDir,
        executionWorkspace: executionDir,
        effectiveWorkspace: executionDir,
        sessionKey: "agent:openclaw:session-1",
        sessionAgentId: "openclaw",
        memoryToolNames: [],
        ringZeroActive: true,
      });

      expect(context.threadDeveloperInstructions).toBeUndefined();
      expect(context.threadDeveloperInstructionFiles).toEqual([]);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
      await fs.rm(executionDir, { recursive: true, force: true });
    }
  });

  it("reads and compares thread-bootstrap context-engine projections", () => {
    const projection = readContextEngineThreadBootstrapProjection({
      mode: "thread_bootstrap",
      epoch: " epoch-1 ",
      fingerprint: " fingerprint-1 ",
    });
    expect(projection).toEqual({
      mode: "thread_bootstrap",
      epoch: "epoch-1",
      fingerprint: "fingerprint-1",
    });

    const expectedBinding = {
      schemaVersion: 1,
      engineId: "lossless",
      policyFingerprint: "policy-v1",
      projection: {
        schemaVersion: 1,
        mode: "thread_bootstrap",
        epoch: "epoch-1",
        fingerprint: "fingerprint-1",
      },
    } satisfies CodexAppServerContextEngineBinding;
    expect(
      resolveContextEngineBootstrapProjectionDecision({
        startupBinding: {
          threadId: "thread-existing",
          dynamicToolsFingerprint: "same-tools",
          contextEngine: expectedBinding,
        } as never,
        expectedBinding,
        projection: projection!,
        dynamicToolsFingerprint: "same-tools",
      }),
    ).toEqual({
      project: false,
      reason: "matching-thread-bootstrap-binding",
    });
    expect(
      resolveContextEngineBootstrapProjectionDecision({
        startupBinding: {
          threadId: "thread-existing",
          dynamicToolsFingerprint: "old-tools",
          contextEngine: expectedBinding,
        } as never,
        expectedBinding,
        projection: projection!,
        dynamicToolsFingerprint: "new-tools",
      }),
    ).toEqual({
      project: true,
      reason: "dynamic-tools-mismatch",
    });
  });

  it("stitches watched-session context into the per-turn OpenClaw prompt context", () => {
    const attempt = { config: {} } as EmbeddedRunAttemptParams;

    expect(
      buildCodexOpenClawPromptContext({
        params: attempt,
        watchedSessionsContext: [
          "## Watched Sessions",
          "- agent:main:telegram:group:beta — Family group",
        ].join("\n"),
      }),
    ).toContain("## Watched Sessions");

    // No ambient watches (and no state) must render nothing, not an empty section.
    expect(
      buildCodexWatchedSessionsContext({
        attempt,
        dynamicTools: [
          {
            type: "function",
            name: "sessions_history",
            description: "history",
            inputSchema: {},
          },
        ],
        sessionKey: "agent:codex-test:main",
      }),
    ).toBe(undefined);

    // Lightweight cron turns keep the runtime context byte-for-byte untouched.
    expect(
      buildCodexWatchedSessionsContext({
        attempt: {
          config: {},
          bootstrapContextMode: "lightweight",
          bootstrapContextRunKind: "cron",
        } as EmbeddedRunAttemptParams,
        dynamicTools: [],
        sessionKey: "agent:codex-test:main",
      }),
    ).toBe(undefined);
  });
});
