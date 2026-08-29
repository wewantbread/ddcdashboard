import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;
const NOW = Date.now();

let browser: Browser;
let server: ControlUiE2eServer;

describeControlUiE2e("Control UI model provider profile outcomes", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(`Playwright Chromium is unavailable at ${chromiumExecutablePath}`);
    }
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("keeps a selected agent provider ready when its sibling profile is rejected", async () => {
    const context = await browser.newContext({
      colorScheme: "dark",
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 1000, width: 1440 },
    });
    const page = await context.newPage();
    const config = {
      auth: {
        profiles: {
          "openai:rejected": { provider: "openai" },
          "openai:ready": { provider: "openai" },
        },
      },
    };
    const readyModel = {
      id: "gpt-ready",
      name: "GPT Ready",
      provider: "openai",
      available: true,
    };
    const gateway = await installMockGateway(page, {
      featureMethods: ["chat.metadata", "chat.startup", "models.probe"],
      methodResponses: {
        "agents.list": {
          defaultId: "main",
          mainKey: "main",
          scope: "agent",
          agents: [
            { id: "main", identity: { name: "Main" }, name: "Main" },
            { id: "writer", identity: { name: "Writer" }, name: "Writer" },
          ],
        },
        "config.get": {
          config,
          sourceConfig: config,
          hash: "multi-profile-model-provider",
          issues: [],
          raw: JSON.stringify(config),
          valid: true,
        },
        "models.list": {
          cases: [
            {
              match: { view: "configured", agentId: "writer" },
              response: { models: [readyModel] },
            },
            { match: { view: "configured" }, response: { models: [] } },
            {
              match: { view: "all", agentId: "writer", refresh: true },
              response: {
                models: [readyModel],
                providerOutcomes: [
                  {
                    provider: "openai",
                    profileId: "openai:rejected",
                    status: "auth-rejected",
                  },
                  { provider: "openai", profileId: "openai:ready", status: "ready" },
                ],
              },
            },
          ],
        },
        "models.authStatus": {
          cases: [
            {
              match: { agentId: "writer" },
              response: {
                ts: NOW,
                providers: [
                  {
                    provider: "openai",
                    displayName: "OpenAI",
                    status: "ok",
                    profiles: [
                      { profileId: "openai:rejected", type: "oauth", status: "ok" },
                      { profileId: "openai:ready", type: "oauth", status: "ok" },
                    ],
                  },
                ],
              },
            },
            { response: { ts: NOW, providers: [] } },
          ],
        },
        "usage.status": { updatedAt: NOW, providers: [] },
        "sessions.usage": { aggregates: { byProvider: [] } },
      },
    });

    try {
      const response = await page.goto(`${server.baseUrl}settings/model-providers`);
      expect(response?.status()).toBe(200);
      await gateway.waitForRequest("agents.list");
      const pageScope = page.locator(".agent-scope-control openclaw-agent-select");
      await pageScope.locator(".agent-select__trigger").click();
      await pageScope
        .locator("wa-dropdown-item[data-agent-option]")
        .filter({ hasText: "Writer" })
        .click();
      await expect
        .poll(async () =>
          (await gateway.getRequests("models.list")).some((request) => {
            const params = request.params as Record<string, unknown> | undefined;
            return (
              params?.view === "configured" &&
              params.agentId === "writer" &&
              params.preparedOnly === true
            );
          }),
        )
        .toBe(true);

      const openaiCard = page.locator('[data-provider-id="openai"]');
      await openaiCard.waitFor();
      await page.getByRole("button", { name: "Refresh", exact: true }).click();
      await expect
        .poll(async () => {
          const request = (await gateway.getRequests("models.list")).find((candidate) => {
            const params = candidate.params as Record<string, unknown> | undefined;
            return params?.view === "all" && params.agentId === "writer";
          });
          return request?.params;
        })
        .toEqual({ view: "all", agentId: "writer", refresh: true });
      await expect.poll(async () => openaiCard.textContent()).toContain("Ready");
      await expect.poll(async () => openaiCard.textContent()).not.toContain("Credentials rejected");
    } finally {
      await context.close();
    }
  });
});
