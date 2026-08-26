import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import type { Api, Model, SimpleStreamOptions, StreamFunction } from "openclaw/plugin-sdk/llm";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { streamSimpleOpenAICodexResponses } from "../../../packages/ai/src/providers/openai-chatgpt-responses.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
} from "./agent-session-loop-correctness.test-support.js";
import { createResourceLoader } from "./agent-session-loop-resource-loader.test-support.js";
import { clearExtensionCache, loadExtensionsCached } from "./extensions/loader.js";
import type { ToolDefinition } from "./extensions/types.js";

registerAgentSessionLoopTestLifecycle();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("AgentSession loaded-plugin provider boundary", () => {
  it("stops after a loaded plugin result through the real provider client", async () => {
    const passthroughTool: ToolDefinition = {
      name: "finish_via_middleware",
      label: "Finish via middleware",
      description: "returns a normal tool result that middleware can terminate",
      parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: "text", text: "raw tool result" }], details: {} }),
    };
    const pluginDir = tempDirs.make("openclaw-terminate-plugin-");
    const pluginPath = path.join(pluginDir, "extension.mjs");
    await writeFile(
      pluginPath,
      `export default async api => api.on("tool_result", async event => ({...event, terminate: true}));\n`,
    );
    clearExtensionCache();
    const loaded = await loadExtensionsCached([pluginPath], pluginDir);
    expect(loaded.errors).toEqual([]);
    expect(loaded.extensions[0]?.handlers.get("tool_result")).toHaveLength(1);
    const resourceLoader = { ...createResourceLoader(), getExtensions: () => loaded };
    const providerRequests: string[] = [];
    const providerServer = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        const requestNumber = providerRequests.push(request.method ?? "unknown");
        const output =
          requestNumber === 1
            ? [
                {
                  type: "function_call",
                  id: "fc-finish",
                  call_id: "call-finish-via-middleware",
                  name: "finish_via_middleware",
                  arguments: "{}",
                },
              ]
            : [
                {
                  type: "message",
                  id: "msg-second",
                  role: "assistant",
                  content: [{ type: "output_text", text: "unexpected second turn" }],
                },
              ];
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.end(
          `data: ${JSON.stringify({ type: "response.completed", response: { id: `resp_${requestNumber}`, status: "completed", output, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } })}\n\n`,
        );
      });
    });
    await new Promise<void>((resolve, reject) => {
      providerServer.once("error", reject);
      providerServer.listen(0, "127.0.0.1", resolve);
    });
    const address = providerServer.address();
    if (!address || typeof address === "string") {
      providerServer.close();
      throw new Error("provider loopback server did not bind to a TCP port");
    }
    const providerModel = {
      id: "loopback-model",
      name: "Loopback Model",
      api: "openai-chatgpt-responses",
      provider: "openai",
      baseUrl: `http://127.0.0.1:${address.port}`,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 100_000,
      maxTokens: 100,
    } satisfies Model<"openai-chatgpt-responses">;
    const apiKey = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString("base64url")}.${Buffer.from('{"https://api.openai.com/auth":{"chatgpt_account_id":"loopback"}}').toString("base64url")}.signature`;
    try {
      const { session } = await createTestSession({
        model: providerModel,
        provider: {
          model: providerModel,
          streamSimple: streamSimpleOpenAICodexResponses as unknown as StreamFunction<
            Api,
            SimpleStreamOptions
          >,
          apiKey,
        },
        resourceLoader,
        customTools: [passthroughTool],
      });
      await session.prompt("finish through loaded middleware");
      await vi.waitFor(() =>
        expect(providerRequests.filter((method) => method === "POST")).toEqual(["POST"]),
      );
      expect(streamMocks.streamSimple).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((resolve, reject) => {
        providerServer.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
