// @vitest-environment jsdom

import type { RouteLoaderOptions } from "@openclaw/uirouter";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SessionsListResult } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import type { SessionListOptions, SessionListSnapshot } from "../../lib/sessions/index.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { loadSessionsPagePreferences, saveSessionsPagePreferences } from "./page-state.ts";
import { page, type SessionsRouteData } from "./route.ts";
import {
  createContext,
  createGateway,
  createRenderedPage,
  createSessions,
} from "./sessions-page.test-support.ts";

const result: SessionsListResult = {
  ts: 1,
  path: "",
  count: 0,
  defaults: { modelProvider: null, model: null, contextTokens: null },
  sessions: [],
};

async function loadSessionsRoute(options: {
  search: string;
  scopeId: string | null;
  expectedQuery: SessionListOptions;
}) {
  let snapshot: SessionListSnapshot = {
    result: null,
    agentId: null,
    loading: false,
    error: null,
  };
  const list = vi.fn();
  const listSnapshot = vi.fn(() => snapshot);
  const refreshList = vi.fn(async () => {
    snapshot = { result, agentId: options.scopeId, loading: false, error: null };
  });
  const context = {
    gateway: { snapshot: { phase: "connected", client: {} } },
    sessions: { list, listSnapshot, refreshList },
    runtimeConfig: { ensureLoaded: vi.fn(async () => undefined) },
    agentSelection: { state: { selectedId: options.scopeId, scopeId: options.scopeId } },
  } as unknown as ApplicationContext;
  const loaderOptions: RouteLoaderOptions = {
    signal: new AbortController().signal,
    shouldRun: () => true,
    revalidating: false,
    location: { pathname: "/sessions", search: options.search, hash: "" },
    deps: "",
    cause: "navigation",
  };

  const data = (await page.loader?.(context, loaderOptions)) as SessionsRouteData;

  expect(refreshList).toHaveBeenCalledWith({ ...options.expectedQuery, force: true });
  expect(listSnapshot).toHaveBeenLastCalledWith(options.expectedQuery);
  expect(list).not.toHaveBeenCalled();
  expect(data).toMatchObject({ result, loading: false, error: null });
}

describe("sessions route", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    {
      name: "default selected-agent roster",
      search: "",
      scopeId: "writer",
      expectedQuery: {
        limit: 50,
        includeGlobal: true,
        includeUnknown: false,
        includeDerivedTitles: false,
        includeLastMessage: false,
        archivedFilter: "active" as const,
        agentId: "writer",
      },
    },
    {
      name: "archived all-agent roster",
      search: "?status=archived",
      scopeId: null,
      expectedQuery: {
        limit: 50,
        includeGlobal: true,
        includeUnknown: false,
        includeDerivedTitles: false,
        includeLastMessage: false,
        archivedFilter: "archived" as const,
      },
    },
    {
      name: "all-status selected-agent roster",
      search: "?status=all",
      scopeId: "main",
      expectedQuery: {
        limit: 50,
        includeGlobal: true,
        includeUnknown: false,
        includeDerivedTitles: false,
        includeLastMessage: false,
        archivedFilter: "all" as const,
        agentId: "main",
      },
    },
    {
      name: "deep link owned by a different agent",
      search: "?session=agent%3Aresearch%3Alinked",
      scopeId: "main",
      expectedQuery: {
        limit: 50,
        search: "agent:research:linked",
        includeGlobal: true,
        includeUnknown: true,
        includeDerivedTitles: false,
        includeLastMessage: false,
        archivedFilter: "active" as const,
        agentId: "research",
      },
    },
  ])("loads the managed $name without a raw list", async (testCase) => {
    await loadSessionsRoute(testCase);
  });

  it("uses persisted filters for the initial list request", async () => {
    saveSessionsPagePreferences({
      ...loadSessionsPagePreferences(),
      activeMinutes: "15",
      limit: "100",
      includeGlobal: false,
      includeUnknown: true,
      statusFilter: "active",
    });

    await loadSessionsRoute({
      search: "",
      scopeId: "writer",
      expectedQuery: {
        activeMinutes: 15,
        limit: 100,
        includeGlobal: false,
        includeUnknown: true,
        includeDerivedTitles: false,
        includeLastMessage: false,
        archivedFilter: "active",
        agentId: "writer",
      },
    });
  });

  it("gives an explicit status URL precedence over persisted status", async () => {
    saveSessionsPagePreferences({
      ...loadSessionsPagePreferences(),
      activeMinutes: "15",
      statusFilter: "archived",
    });

    await loadSessionsRoute({
      search: "?status=all",
      scopeId: null,
      expectedQuery: {
        limit: 50,
        includeGlobal: true,
        includeUnknown: false,
        includeDerivedTitles: false,
        includeLastMessage: false,
        archivedFilter: "all",
      },
    });
  });

  it("keeps unrelated saved preferences when controls change in a direct-session view", async () => {
    const savedPreferences = {
      ...loadSessionsPagePreferences(),
      activeMinutes: "15",
      limit: "100",
      includeGlobal: false,
      includeUnknown: false,
      statusFilter: "archived" as const,
      searchQuery: "saved",
      sortColumn: "updated" as const,
      sortDir: "desc" as const,
      groupBy: "category" as const,
      pageSize: 25,
    };
    saveSessionsPagePreferences(savedPreferences);

    const key = "agent:main:linked";
    const context = createContext(
      createGateway({} as GatewayBrowserClient).gateway,
      createSessions(),
    );
    const linkedResult: SessionsListResult = {
      ...result,
      count: 1,
      sessions: [{ key, kind: "direct" }],
    };
    const sessionsPage = await createRenderedPage(context, linkedResult, "active", key);

    const limitInput = sessionsPage.querySelector<HTMLInputElement>(
      "input.session-filter-input--limit",
    );
    const keySortButton = sessionsPage.querySelector<HTMLButtonElement>(
      "th[data-sortable] .data-table-sort-button",
    );
    const pageSize = sessionsPage.querySelector<HTMLSelectElement>(
      "select.data-table-pagination__size",
    );
    const searchInput = sessionsPage.querySelector<HTMLInputElement>(
      ".sessions-toolbar__search input",
    );
    if (!limitInput || !keySortButton || !pageSize || !searchInput) {
      throw new Error("Expected direct-session preference controls");
    }

    limitInput.value = "25";
    limitInput.dispatchEvent(new Event("input", { bubbles: true }));
    keySortButton.click();
    pageSize.value = "50";
    pageSize.dispatchEvent(new Event("change", { bubbles: true }));
    searchInput.value = "linked";
    searchInput.dispatchEvent(new Event("input", { bubbles: true }));

    expect(loadSessionsPagePreferences()).toEqual({
      ...savedPreferences,
      limit: "25",
      searchQuery: "linked",
      sortColumn: "key",
      pageSize: 50,
    });
  });
});
