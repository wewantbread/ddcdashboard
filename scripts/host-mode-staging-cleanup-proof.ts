import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../src/config/config.js";
import {
  disconnectGatewayClient,
  startGatewayWithClient,
} from "../src/gateway/test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "../src/gateway/test-openai-responses-model.js";
import { captureEnv, setTestEnvValue } from "../src/test-utils/env.js";

const envKeys = [
  "HOME",
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_GATEWAY_TOKEN",
  "OPENCLAW_SKIP_CHANNELS",
  "OPENCLAW_SKIP_GMAIL_WATCHER",
  "OPENCLAW_SKIP_CRON",
  "OPENCLAW_SKIP_CANVAS_HOST",
  "OPENCLAW_SKIP_BROWSER_CONTROL_SERVER",
  "OPENCLAW_SKIP_PROVIDERS",
  "OPENCLAW_BUNDLED_PLUGINS_DIR",
  "OPENCLAW_DISABLE_BUNDLED_PLUGINS",
] as const;

function writeAssistantSseResponse(res: ServerResponse, text: string): void {
  res.writeHead(200, { "content-type": "text/event-stream" });
  const message = {
    type: "message",
    id: "proof-message-id",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  res.end(
    [
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { ...message, status: "in_progress", content: [] },
      },
      { type: "response.output_item.done", output_index: 0, item: message },
      {
        type: "response.completed",
        response: {
          status: "completed",
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        },
      },
    ]
      .map((event) => `data: ${JSON.stringify(event)}\n\n`)
      .concat("data: [DONE]\n\n")
      .join(""),
  );
}

async function runHostModeStagingCleanupProof(): Promise<void> {
  console.log("=== Host-Mode Staging Media Production Gateway Proof ===");

  const envSnapshot = captureEnv([...envKeys]);
  let tempHome: string | undefined;
  let providerServer: ReturnType<typeof createServer> | undefined;
  let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;

  try {
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-host-staging-gateway-proof-"));
    const stateDir = path.join(tempHome, ".openclaw");
    const workspaceDir = path.join(tempHome, "workspace");
    const configPath = path.join(stateDir, "openclaw.json");
    const mediaDir = path.join(stateDir, "media", "inbound");

    await Promise.all([
      fs.mkdir(workspaceDir, { recursive: true }),
      fs.mkdir(mediaDir, { recursive: true }),
      fs.mkdir(path.dirname(configPath), { recursive: true }),
    ]);

    for (const [key, value] of Object.entries({
      HOME: tempHome,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_GATEWAY_TOKEN: "proof-gateway-token-128454",
      OPENCLAW_SKIP_CHANNELS: "1",
      OPENCLAW_SKIP_GMAIL_WATCHER: "1",
      OPENCLAW_SKIP_CRON: "1",
      OPENCLAW_SKIP_CANVAS_HOST: "1",
      OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
      OPENCLAW_SKIP_PROVIDERS: "1",
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    })) {
      setTestEnvValue(key, value);
    }

    // Inbound media source attachment in host inbound media directory
    const sampleFileName = "proof-sample.jpg";
    const sampleFilePath = path.join(mediaDir, sampleFileName);
    const mediaContent = Buffer.from("JPEG_SAMPLE_HOST_MODE_ATTACHMENT_DATA_STREAM");
    await fs.writeFile(sampleFilePath, mediaContent);

    // Setup local mock HTTP model server
    let serverReceivedRequests = 0;
    providerServer = createServer((_req, res) => {
      serverReceivedRequests++;
      writeAssistantSseResponse(res, "I analyzed the inbound media attachment.");
    });

    await new Promise<void>((resolve, reject) => {
      providerServer?.once("error", reject);
      providerServer?.listen(0, "127.0.0.1", resolve);
    });

    const providerAddress = providerServer.address();
    if (!providerAddress || typeof providerAddress === "string") {
      throw new Error("Proof provider did not bind a loopback port");
    }
    const provider = buildMockOpenAiResponsesProvider(
      `http://127.0.0.1:${providerAddress.port}/v1`,
    );

    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          skipBootstrap: true,
          sandbox: { mode: "off" },
          model: { primary: provider.modelRef },
          models: {
            [provider.modelRef]: { params: { transport: "sse", openaiWsWarmup: false } },
          },
        },
        entries: { main: { default: true } },
      },
      models: { mode: "replace", providers: { [provider.providerId]: provider.config } },
      gateway: { auth: { mode: "token", token: "proof-gateway-token-128454" } },
    };

    console.log("\n[1/5] Starting real Gateway server in host mode (sandbox: off)...");
    gateway = await startGatewayWithClient({
      cfg,
      configPath,
      token: "proof-gateway-token-128454",
      clientDisplayName: "proof-client-host-staging",
    });
    console.log("  -> Gateway connected and listening.");

    // Scenario 1: Real Gateway chat.send turn with host-mode staged media
    console.log("\n[2/5] Dispatching chat.send turn with inbound media attachment...");
    const sessionKey = "agent:main:proof-session-host-staging";

    const started = await gateway.client.request<{ runId?: string; status?: string }>(
      "chat.send",
      {
        sessionKey,
        message: "Please inspect this attached image",
        attachments: [
          {
            mimeType: "image/jpeg",
            fileName: sampleFileName,
            content: mediaContent.toString("base64"),
          },
        ],
        deliver: false,
        idempotencyKey: "proof-turn-1",
      },
    );

    assert.equal(started.status, "started", "Turn must start successfully");
    assert.ok(started.runId, "Turn must return runId");
    console.log(`  -> Turn started: runId=${started.runId}`);

    // Wait for the agent run to complete / settle through gateway
    console.log("\n[3/5] Awaiting agent execution and lifecycle settlement via agent.wait...");
    const waitRes = await gateway.client.request<{ status?: string }>(
      "agent.wait",
      { runId: started.runId, timeoutMs: 30_000 },
      { timeoutMs: 35_000 },
    );
    assert.equal(waitRes.status, "ok", "Agent run must settle with status ok");
    console.log("  -> Agent run settled successfully.");

    // Verify workspace media staging directory cleanup
    console.log("\n[4/5] Verifying post-settlement host staging directory removal...");
    const workspaceMediaInbound = path.join(workspaceDir, "media", "inbound");
    let stagingDirectories: string[] = [];
    try {
      const entries = await fs.readdir(workspaceMediaInbound);
      stagingDirectories = entries.filter((e) => e.startsWith("openclaw-staged-"));
    } catch {
      stagingDirectories = [];
    }

    console.log(
      `  -> Remaining openclaw-staged-* directories: count=${stagingDirectories.length} (expected=0)`,
    );
    assert.equal(
      stagingDirectories.length,
      0,
      "All openclaw-staged-* directories must be removed after settlement",
    );

    // Scenario 2: Verify chat.history reflects the completed turn
    console.log("\n[5/5] Verifying chat.history reflects the settled turn...");
    const history = await gateway.client.request<{ messages?: Array<{ role?: string; content?: unknown }> }>(
      "chat.history",
      { sessionKey },
    );
    const messages = history.messages ?? [];
    assert.ok(messages.length >= 2, "History must contain user and assistant messages");
    console.log(`  -> chat.history contains ${messages.length} messages. Verified OK.`);

    console.log("\n=== Production Gateway Proof Execution Complete: SUCCESS ===");
  } finally {
    if (gateway) {
      await disconnectGatewayClient(gateway.client);
      await gateway.server.close({ reason: "Proof complete" });
    }
    if (providerServer) {
      providerServer.close();
    }
    clearConfigCache();
    clearRuntimeConfigSnapshot();
    envSnapshot.restore();
    if (tempHome) {
      await fs.rm(tempHome, { recursive: true, force: true });
    }
  }
}

runHostModeStagingCleanupProof().catch((err: unknown) => {
  console.error("Proof Execution Failed:", err);
  process.exit(1);
});
