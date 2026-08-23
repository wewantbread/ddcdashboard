import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "OpenCode and Pi external session catalogs",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

const SHARE_ROUTE = {
  kind: "thread-id-prefix",
  routeSegment: "beam",
  hostId: "gateway",
  identifierAlphabet: "lowercase-hex",
  fullLength: 32,
  minPrefixLength: 12,
  lookup: "catalog-list-search-by-thread-id-prefix",
  ambiguity: "multiple-results-or-next-cursor",
} as const;

suite.define(() => {
  it("opens and refreshes a base-path Beam share without replacing its pretty URL", async () => {
    const artifactDir = path.resolve(".artifacts/control-ui-e2e/beam-share-url");
    await fs.mkdir(artifactDir, { recursive: true });
    const context = await suite.newBrowserContext({
      recordVideo: { dir: artifactDir, size: { width: 1280, height: 720 } },
      viewport: { width: 1280, height: 720 },
    });
    const page = await context.newPage();
    const fullId = "0123456789abcdef0123456789abcdef";
    const prettyPath = "/openclaw/beam/0123456789ab";
    const gateway = await installMockGateway(page, {
      basePath: "/openclaw",
      featureMethods: [
        "chat.metadata",
        "chat.startup",
        "sessions.catalog.list",
        "sessions.catalog.read",
      ],
      methodResponses: {
        "sessions.catalog.list": {
          catalogs: [
            {
              id: "beam",
              label: "Beam",
              capabilities: { continueSession: false, archive: false },
              shareRoute: SHARE_ROUTE,
              hosts: [
                {
                  hostId: "gateway",
                  label: "Beamed sessions",
                  kind: "gateway",
                  connected: true,
                  sessions: [
                    {
                      threadId: fullId,
                      name: "Pretty Beam route",
                      status: "live",
                      archived: false,
                      canContinue: false,
                      canArchive: false,
                    },
                  ],
                },
              ],
            },
          ],
        },
        "sessions.catalog.read": {
          hostId: "gateway",
          label: "Pretty Beam route",
          threadId: fullId,
          items: [
            { type: "userMessage", text: "Keep this Beam URL readable." },
            { type: "agentMessage", text: "The pretty route stayed put." },
          ],
        },
      },
    });

    try {
      const response = await page.goto(new URL(prettyPath, suite.server.baseUrl).href);
      expect(response?.status()).toBe(200);
      const transcript = page.getByText("The pretty route stayed put.", { exact: true });
      await transcript.waitFor();
      expect(new URL(page.url()).pathname).toBe(prettyPath);
      expect(new URL(page.url()).search).toBe("");
      await page
        .locator(".sidebar-recent-session--active", { hasText: "Pretty Beam route" })
        .waitFor();
      await page
        .locator(".chat-pane__session-title-text", { hasText: "Pretty Beam route" })
        .waitFor();
      expect(
        await page
          .locator("openclaw-chat-pane.chat-pane-cache__pane--visible textarea")
          .isDisabled(),
      ).toBe(true);
      const resolution = (await gateway.getRequests("sessions.catalog.list")).find(
        (request) => (request.params as { search?: string } | undefined)?.search,
      );
      expect(resolution?.params).toEqual({
        agentId: "main",
        search: "0123456789ab",
        limitPerHost: 2,
      });
      expect((await gateway.getRequests("sessions.catalog.read")).at(-1)?.params).toMatchObject({
        catalogId: "beam",
        hostId: "gateway",
        threadId: fullId,
      });

      await page.reload();
      await page.getByText("The pretty route stayed put.", { exact: true }).waitFor();
      expect(new URL(page.url()).pathname).toBe(prettyPath);
      expect(new URL(page.url()).search).toBe("");

      await page.goto(new URL("/openclaw/chat", suite.server.baseUrl).href);
      const beamRow = page.locator("a", { hasText: "Pretty Beam route" }).first();
      await beamRow.waitFor();
      await beamRow.click();
      await page.getByText("The pretty route stayed put.", { exact: true }).waitFor();
      expect(new URL(page.url()).pathname).toBe(prettyPath);
      expect(new URL(page.url()).search).toBe("");
      await page.screenshot({
        path: path.join(artifactDir, "beam-pretty-route.png"),
        fullPage: true,
      });
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("shows both paired-node catalogs and opens their view-only transcripts", async () => {
    const page = await suite.browser.newPage({ viewport: { width: 1440, height: 900 } });
    const gateway = await installMockGateway(page, {
      featureMethods: [
        "chat.metadata",
        "chat.startup",
        "sessions.catalog.list",
        "sessions.catalog.read",
      ],
      methodResponses: {
        "sessions.catalog.list": {
          catalogs: [
            {
              id: "opencode",
              label: "OpenCode",
              capabilities: { continueSession: false, archive: false },
              hosts: [
                {
                  hostId: "node:devbox",
                  label: "Dev Box",
                  kind: "node",
                  connected: true,
                  nodeId: "devbox",
                  sessions: [
                    {
                      threadId: "opencode-1",
                      name: "OpenCode release review",
                      status: "stored",
                      canContinue: false,
                      canArchive: false,
                    },
                  ],
                },
              ],
            },
            {
              id: "pi",
              label: "Pi",
              capabilities: { continueSession: false, archive: false },
              hosts: [
                {
                  hostId: "node:devbox",
                  label: "Dev Box",
                  kind: "node",
                  connected: true,
                  nodeId: "devbox",
                  sessions: [
                    {
                      threadId: "pi-1",
                      name: "Pi architecture notes",
                      status: "stored",
                      canContinue: false,
                      canArchive: false,
                    },
                  ],
                },
              ],
            },
          ],
        },
        "sessions.catalog.read": {
          cases: [
            {
              match: { catalogId: "opencode", threadId: "opencode-1" },
              response: {
                hostId: "node:devbox",
                threadId: "opencode-1",
                items: [{ type: "agentMessage", text: "OpenCode transcript loaded" }],
              },
            },
            {
              match: { catalogId: "pi", threadId: "pi-1" },
              response: {
                hostId: "node:devbox",
                threadId: "pi-1",
                items: [{ type: "agentMessage", text: "Pi transcript loaded" }],
              },
            },
          ],
        },
      },
    });

    await page.goto(`${suite.server.baseUrl}chat`);
    await expect
      .poll(() =>
        page
          .locator('[data-session-section="catalog:opencode"] [data-provider-icon="opencode"]')
          .count(),
      )
      .toBe(1);
    await expect
      .poll(() =>
        page.locator('[data-session-section="catalog:pi"] [data-provider-icon="pi"]').count(),
      )
      .toBe(1);
    const piIconResponse = await page.request.get(
      new URL("provider-icons/ProviderIcon-pi.svg", suite.server.baseUrl).toString(),
    );
    expect(piIconResponse.ok()).toBe(true);

    await page.getByText("OpenCode release review", { exact: true }).click();
    await expect.poll(() => page.getByText("OpenCode transcript loaded").count()).toBe(1);
    await page.getByText("Pi architecture notes", { exact: true }).click();
    const piPane = page
      .locator("openclaw-chat-pane.chat-pane-cache__pane--visible")
      .filter({ hasText: "Pi transcript loaded" });
    await piPane.getByText("Pi transcript loaded").waitFor();
    expect(await piPane.locator(".agent-chat__composer-combobox > textarea").isDisabled()).toBe(
      true,
    );
    expect(await gateway.getRequests("sessions.catalog.read")).toHaveLength(2);

    const artifactDir = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
    if (artifactDir) {
      await fs.mkdir(artifactDir, { recursive: true });
      await page.screenshot({
        path: path.join(artifactDir, "external-session-catalogs.png"),
        fullPage: true,
      });
    }
    await page.close();
  });
});
