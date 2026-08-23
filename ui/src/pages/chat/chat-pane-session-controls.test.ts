/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { ApplicationGatewaySnapshot } from "../../app/gateway.ts";
import {
  createChatPaneSessionActionCallbacks,
  renderChatPaneComposerControls,
  resolveChatModelCatalogState,
} from "./chat-pane-session-controls.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { renderChatPermissionPicker } from "./components/chat-permission-picker.ts";

function sessionActionSnapshot(params: {
  hasClient?: boolean;
  phase: ApplicationGatewaySnapshot["phase"];
  scopes?: string[];
}): ApplicationGatewaySnapshot {
  return {
    client: params.hasClient === false ? null : ({} as ApplicationGatewaySnapshot["client"]),
    hello: params.scopes
      ? ({
          auth: { role: "operator", scopes: params.scopes },
          features: { methods: ["chat.abort"] },
        } as ApplicationGatewaySnapshot["hello"])
      : null,
    phase: params.phase,
  } as ApplicationGatewaySnapshot;
}

function createSessionActionHarness(params: {
  getSnapshot: () => ApplicationGatewaySnapshot;
  hasLocalRun: () => boolean;
}) {
  const onAbort = vi.fn();
  const onDenied = vi.fn();
  const callbacks = createChatPaneSessionActionCallbacks({
    ...params,
    sessionParticipationBlocked: false,
    onDenied,
    onCompact: vi.fn(),
    onAbort,
    onRewind: vi.fn(),
    onFork: vi.fn(),
    onReset: vi.fn(),
  });
  return { callbacks, onAbort, onDenied };
}

describe("chat pane session actions", () => {
  it("keeps an exact local run abort available while reconnecting", () => {
    const { callbacks, onAbort, onDenied } = createSessionActionHarness({
      getSnapshot: () => sessionActionSnapshot({ phase: "reconnecting" }),
      hasLocalRun: () => true,
    });

    expect(callbacks.onAbort).toBeTypeOf("function");
    callbacks.onAbort?.();
    expect(onAbort).toHaveBeenCalledOnce();
    expect(onDenied).not.toHaveBeenCalled();
  });

  it("does not expose an offline session-only abort without an exact local run", () => {
    const { callbacks } = createSessionActionHarness({
      getSnapshot: () => sessionActionSnapshot({ phase: "reconnecting" }),
      hasLocalRun: () => false,
    });

    expect(callbacks.onAbort).toBeUndefined();
  });

  it("does not expose an offline exact-run abort without its source client", () => {
    const { callbacks } = createSessionActionHarness({
      getSnapshot: () => sessionActionSnapshot({ hasClient: false, phase: "reconnecting" }),
      hasLocalRun: () => true,
    });

    expect(callbacks.onAbort).toBeUndefined();
  });

  it("captures an exact-run abort if the connection drops after rendering", () => {
    let snapshot = sessionActionSnapshot({ phase: "connected", scopes: ["operator.write"] });
    const { callbacks, onAbort, onDenied } = createSessionActionHarness({
      getSnapshot: () => snapshot,
      hasLocalRun: () => true,
    });
    snapshot = sessionActionSnapshot({ phase: "reconnecting" });

    callbacks.onAbort?.();

    expect(onAbort).toHaveBeenCalledOnce();
    expect(onDenied).not.toHaveBeenCalled();
  });

  it("rechecks online write access before aborting", () => {
    let snapshot = sessionActionSnapshot({ phase: "connected", scopes: ["operator.write"] });
    const { callbacks, onAbort, onDenied } = createSessionActionHarness({
      getSnapshot: () => snapshot,
      hasLocalRun: () => true,
    });
    snapshot = sessionActionSnapshot({ phase: "connected", scopes: ["operator.read"] });

    callbacks.onAbort?.();

    expect(onAbort).not.toHaveBeenCalled();
    expect(onDenied).toHaveBeenCalledOnce();
  });
});

describe("chat model catalog state", () => {
  const cachedCatalog = [
    {
      id: "gpt-5.6-luna",
      name: "GPT-5.6 Luna",
      provider: "openai",
      available: false,
    },
  ];

  it.each([
    {
      label: "ready",
      state: {
        chatModelCatalog: [],
        chatModelCatalogError: null,
        chatModelsLoading: false,
        connected: true,
      },
      expected: { hasSnapshot: true, status: "ready" },
    },
    {
      label: "refreshing with a cached snapshot",
      state: {
        chatModelCatalog: cachedCatalog,
        chatModelCatalogError: null,
        chatModelsLoading: true,
        connected: true,
      },
      expected: { hasSnapshot: true, status: "refreshing" },
    },
    {
      label: "offline",
      state: {
        chatModelCatalog: cachedCatalog,
        chatModelCatalogError: null,
        chatModelsLoading: false,
        connected: false,
      },
      expected: { hasSnapshot: true, status: "offline" },
    },
    {
      label: "error",
      state: {
        chatModelCatalog: cachedCatalog,
        chatModelCatalogError: "metadata unavailable",
        chatModelsLoading: false,
        connected: true,
      },
      expected: { hasSnapshot: true, status: "error" },
    },
  ])("resolves $label", ({ state, expected }) => {
    expect(resolveChatModelCatalogState(state)).toEqual(expected);
  });
});

describe("chat pane composer controls", () => {
  it("assembles model and permission controls as separate footer inputs", () => {
    const container = document.createElement("div");
    const state = {
      chatRunId: null,
      connected: true,
      client: {},
      chatLoading: false,
      chatModelCatalog: [],
      sessions: { state: { modelOverrides: {} }, patch: vi.fn() },
      chatModelSwitchPromises: {},
      sessionKey: "main",
      chatModelsLoading: false,
      chatSending: false,
      sessionsResult: null,
      chatStream: null,
    } as unknown as ChatPageHost;
    const onModelSetup = vi.fn();

    const controls = renderChatPaneComposerControls({
      state,
      selectedSession: undefined,
      agentDefaultModel: undefined,
      modelAccess: { allowed: true, requiredScope: "operator.write" },
      effortAccess: { allowed: true, requiredScope: "operator.write" },
      permissionAccess: { allowed: true, requiredScope: "operator.write" },
      canSelectFull: true,
      onModelSetup,
    });
    render(controls.composerControls, container);

    expect(Array.from(container.children).map((node) => node.className)).toEqual([
      "chat-composer-model-control",
    ]);
    expect(container.querySelector('[data-chat-provider-usage="true"]')).toBeNull();
    expect(container.querySelector('[data-chat-permission-select="true"]')).toBeNull();
    const permissionContainer = document.createElement("div");
    render(renderChatPermissionPicker(controls.permissionPicker), permissionContainer);
    expect(
      permissionContainer.querySelector('[data-chat-permission-select="true"]'),
    ).not.toBeNull();
    container.querySelector<HTMLButtonElement>('[data-chat-model-setup="true"]')?.click();
    expect(onModelSetup).toHaveBeenCalledOnce();
  });

  it("patches a keyboard-selected mode, clears to default, and locks full access", async () => {
    const container = document.createElement("div");
    const patch = vi.fn(async () => ({}));
    const state = {
      chatRunId: null,
      connected: true,
      client: {},
      chatLoading: false,
      chatModelCatalog: [],
      sessions: { state: { modelOverrides: {} }, patch },
      chatModelSwitchPromises: {},
      sessionKey: "agent:main:permission-test",
      chatModelsLoading: false,
      chatSending: false,
      sessionsResult: null,
      chatStream: null,
    } as unknown as ChatPageHost;

    const controls = renderChatPaneComposerControls({
      state,
      selectedSession: {
        key: "agent:main:permission-test",
        kind: "direct",
        permissionMode: "full",
        sessionRoot: "/workspace/projects/openclaw",
      },
      agentDefaultModel: undefined,
      modelAccess: { allowed: true, requiredScope: "operator.write" },
      effortAccess: { allowed: true, requiredScope: "operator.write" },
      permissionAccess: { allowed: true, requiredScope: "operator.write" },
      canSelectFull: false,
      onModelSetup: vi.fn(),
    });
    render(renderChatPermissionPicker(controls.permissionPicker), container);

    const dropdown = container.querySelector<HTMLElement>(".chat-controls__permission-picker");
    dropdown?.setAttribute("open", "");
    const full = container.querySelector<HTMLElement>('[data-chat-permission-option="full"]');
    const defaultOption = container.querySelector<HTMLElement>(
      '[data-chat-permission-option="default"]',
    );
    expect(defaultOption?.textContent).toContain("Follow the agent's configured policy");
    expect(full?.hasAttribute("disabled")).toBe(true);
    expect(full?.getAttribute("aria-checked")).toBe("true");
    expect(full?.querySelector(".chat-controls__inline-select-check")).not.toBeNull();
    expect(full?.getAttribute("aria-label")).toContain("operator.admin");

    dropdown?.dispatchEvent(new KeyboardEvent("keydown", { key: "3", bubbles: true }));
    await Promise.resolve();
    expect(patch).toHaveBeenCalledWith(
      "agent:main:permission-test",
      { permissionMode: "guarded" },
      {},
    );

    dropdown?.setAttribute("open", "");
    dropdown?.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true }));
    await Promise.resolve();
    expect(patch).toHaveBeenLastCalledWith(
      "agent:main:permission-test",
      { permissionMode: null },
      {},
    );
  });

  it("refreshes the configured model catalog when the picker opens", async () => {
    const container = document.createElement("div");
    const request = vi.fn(async () => ({ models: [] }));
    const state = {
      chatRunId: null,
      connected: true,
      connectionEpoch: 1,
      client: { request },
      chatLoading: false,
      chatModelCatalog: [],
      chatModelCatalogError: null,
      sessions: { state: { modelOverrides: {} }, patch: vi.fn() },
      chatModelSwitchPromises: {},
      sessionKey: "main",
      chatModelsLoading: false,
      chatSending: false,
      sessionsResult: null,
      chatStream: null,
      requestUpdate: vi.fn(),
    } as unknown as ChatPageHost;
    const controls = renderChatPaneComposerControls({
      state,
      selectedSession: undefined,
      agentDefaultModel: undefined,
      modelAccess: { allowed: true, requiredScope: "operator.write" },
      effortAccess: { allowed: true, requiredScope: "operator.write" },
      permissionAccess: { allowed: true, requiredScope: "operator.write" },
      canSelectFull: true,
      onModelSetup: vi.fn(),
    });
    render(controls.composerControls, container);

    const picker = container.querySelector<HTMLDetailsElement>(".chat-controls__model-picker");
    picker!.open = true;
    picker!.dispatchEvent(new Event("toggle"));

    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    expect(request).toHaveBeenCalledWith("models.list", {
      view: "configured",
      agentId: "main",
      refresh: true,
    });
  });
});
