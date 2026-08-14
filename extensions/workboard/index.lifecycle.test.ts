import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  createPluginRegistryFixture,
  registerVirtualTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import {
  createEmptyPluginRegistry,
  getActivePluginRegistry,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "./api.js";
import plugin from "./index.js";
import { WorkboardStore } from "./src/store.js";

type GatewayHandler = Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];
type GatewayRespond = Parameters<GatewayHandler>[0]["respond"];

type GatewayResponse = {
  ok: boolean;
  payload?: unknown;
  error?: { code: string; message: string };
};

const tempDirs = new Set<string>();

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

async function callGateway(
  handlers: Record<string, GatewayHandler | undefined>,
  method: string,
  params: Record<string, unknown>,
): Promise<GatewayResponse> {
  const handler = handlers[method];
  if (!handler) {
    throw new Error(`missing gateway handler: ${method}`);
  }
  let response: GatewayResponse | undefined;
  const respond: GatewayRespond = (ok, payload, error) => {
    response = { ok, payload, error } as GatewayResponse;
  };
  await handler({
    params,
    respond,
  } as never);
  if (!response) {
    throw new Error(`gateway handler did not respond: ${method}`);
  }
  return response;
}

function registerWorkboardRegistry() {
  const fixture = createPluginRegistryFixture();
  registerVirtualTestPlugin({
    ...fixture,
    id: "workboard",
    name: "Workboard",
    register: plugin.register,
  });
  return fixture.registry.registry;
}

describe("Workboard plugin lifecycle", () => {
  it("drains real SQLite stores across active registry replacements", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-workboard-lifecycle-"));
    tempDirs.add(stateDir);
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const previousRegistry = getActivePluginRegistry() ?? createEmptyPluginRegistry();

    const close = vi.spyOn(DatabaseSync.prototype, "close");
    const oldRegistry = registerWorkboardRegistry();
    setActivePluginRegistry(oldRegistry);
    const oldHandlers = oldRegistry.gatewayHandlers;
    const created = await callGateway(oldHandlers, "workboard.cards.create", {
      title: "Lifecycle evidence",
    });
    expect(created).toMatchObject({ ok: true, payload: { card: { title: "Lifecycle evidence" } } });
    const dbPath = path.join(stateDir, "plugins", "workboard", "workboard.sqlite");
    expect(fs.existsSync(dbPath)).toBe(true);

    const listBoardsEntered = createDeferred<void>();
    const releaseListBoards = createDeferred<void>();
    const listBoards = WorkboardStore.prototype.listBoards;
    vi.spyOn(WorkboardStore.prototype, "listBoards").mockImplementationOnce(
      async function (this: WorkboardStore) {
        listBoardsEntered.resolve();
        await releaseListBoards.promise;
        return await listBoards.call(this);
      },
    );
    const oldRequest = callGateway(oldHandlers, "workboard.cards.list", {});
    await listBoardsEntered.promise;

    const lifecycle = oldRegistry.runtimeLifecycles.find(
      (entry) => entry.lifecycle.id === "workboard-sqlite-store",
    );
    const cleanupStarted = createDeferred<void>();
    const cleanup = lifecycle?.lifecycle.cleanup;
    if (!lifecycle || !cleanup) {
      throw new Error("missing Workboard SQLite lifecycle cleanup");
    }
    lifecycle.lifecycle.cleanup = async (context) => {
      cleanupStarted.resolve();
      await cleanup(context);
    };

    const replacementRegistry = registerWorkboardRegistry();
    const closeCountBeforeRetirement = close.mock.calls.length;
    setActivePluginRegistry(replacementRegistry);
    await cleanupStarted.promise;
    expect(close).toHaveBeenCalledTimes(closeCountBeforeRetirement);

    releaseListBoards.resolve();
    await expect(oldRequest).resolves.toMatchObject({ ok: true });
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(closeCountBeforeRetirement + 1));

    const afterCleanup = await callGateway(oldHandlers, "workboard.cards.list", {});
    expect(afterCleanup).toEqual({
      ok: false,
      payload: undefined,
      error: { code: "workboard_error", message: "workboard store is closed." },
    });

    const replacementCreate = callGateway(
      replacementRegistry.gatewayHandlers,
      "workboard.cards.create",
      {
        title: "Replacement remains usable",
      },
    );
    await expect(replacementCreate).resolves.toMatchObject({
      ok: true,
      payload: { card: { title: "Replacement remains usable" } },
    });

    const restoredRegistry = registerWorkboardRegistry();
    const closeCountBeforeRestore = close.mock.calls.length;
    setActivePluginRegistry(restoredRegistry);
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(closeCountBeforeRestore + 1));
    await expect(
      callGateway(restoredRegistry.gatewayHandlers, "workboard.cards.create", {
        title: "Fresh reload remains usable",
      }),
    ).resolves.toMatchObject({
      ok: true,
      payload: { card: { title: "Fresh reload remains usable" } },
    });

    const closeCountBeforeRestoreCleanup = close.mock.calls.length;
    setActivePluginRegistry(previousRegistry);
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(closeCountBeforeRestoreCleanup + 1));
  });
});
