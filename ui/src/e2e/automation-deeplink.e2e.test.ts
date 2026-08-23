import { copyFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type { BrowserContext, Page } from "playwright";
import { expect, it } from "vitest";
import {
  controlUiE2eWaitTimeoutMs,
  installMockGateway,
  waitForControlUiRoute,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI automation deep links",
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed at ${executablePath}.`,
});

const artifactDir = path.resolve(process.cwd(), ".artifacts/control-ui-e2e/automation-deeplink");
const job = {
  id: "release.digest",
  name: "Prepare the daily security digest",
  description: "Summarize the security queue for the morning handoff.",
  enabled: true,
  createdAtMs: 0,
  updatedAtMs: 1,
  configRevision: "automation-deeplink-revision",
  schedule: { kind: "cron", expr: "0 8 * * *" },
  sessionTarget: "isolated",
  wakeMode: "now",
  payload: { kind: "agentTurn", message: "Prepare the security digest." },
  state: { lastRunStatus: "error", lastError: "Provider request failed" },
} as const;

async function newRecordedPage(): Promise<{
  context: BrowserContext;
  page: Page;
  rawVideoDir: string;
}> {
  await mkdir(artifactDir, { recursive: true });
  const rawVideoDir = path.join(artifactDir, "raw-video");
  await rm(rawVideoDir, { force: true, recursive: true });
  await mkdir(rawVideoDir, { recursive: true });
  const context = await suite.browser.newContext({
    locale: "en-US",
    recordVideo: { dir: rawVideoDir, size: { width: 1440, height: 900 } },
    serviceWorkers: "block",
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(controlUiE2eWaitTimeoutMs);
  return { context, page, rawVideoDir };
}

async function closeRecordedPage(recorded: Awaited<ReturnType<typeof newRecordedPage>>) {
  const video = recorded.page.video();
  await recorded.context.close();
  if (video) {
    await copyFile(await video.path(), path.join(artifactDir, "inbox-to-automation.webm"));
  }
  await rm(recorded.rawVideoDir, { force: true, recursive: true });
}

suite.define(() => {
  it("opens the failed automation from Inbox and preserves it across reload", async () => {
    await rm(artifactDir, { force: true, recursive: true });
    const recorded = await newRecordedPage();
    const { page } = recorded;
    try {
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "cron.status": { enabled: true, jobs: 1, triggersEnabled: true },
          "cron.list": {
            jobs: [job],
            snapshotRevision: "automation-deeplink",
            total: 1,
            offset: 0,
            limit: 50,
            hasMore: false,
            nextOffset: null,
          },
          "cron.get": job,
          "cron.runs": { entries: [], total: 0, offset: 0, hasMore: false },
          "models.authStatus": { providers: [], ts: 1 },
        },
      });

      expect((await page.goto(`${suite.server.baseUrl}new`))?.status()).toBe(200);
      await gateway.waitForRequest("cron.list");
      const attention = page.locator('[data-attention-kind="cronFailed"]');
      await attention.waitFor();
      await page.screenshot({ fullPage: true, path: path.join(artifactDir, "01-inbox.png") });

      await attention.locator(".sidebar-attention__open").click();
      const alert = page.locator(".custodian__alert-card");
      await alert.getByText("Provider request failed", { exact: false }).waitFor();
      await page.screenshot({
        fullPage: true,
        path: path.join(artifactDir, "02-custodian-alert.png"),
      });
      await alert.getByRole("button", { name: "Automations", exact: true }).click();

      await waitForControlUiRoute(page, {
        pathname: "/automations/release%2Edigest",
        routeId: "cron",
      });
      await page.getByText(job.name, { exact: true }).waitFor();
      await expect
        .poll(async () => (await gateway.getRequests("cron.get")).length)
        .toBeGreaterThanOrEqual(1);
      expect((await gateway.getRequests("cron.get")).at(-1)?.params).toEqual({ id: job.id });
      await page.screenshot({
        fullPage: true,
        path: path.join(artifactDir, "03-automation-detail.png"),
      });

      await page.reload();
      await page.getByText(job.name, { exact: true }).waitFor();
      await expect.poll(async () => (await gateway.getRequests("cron.get")).length).toBe(1);
      expect((await gateway.getRequests("cron.get"))[0]?.params).toEqual({ id: job.id });
      await page.screenshot({
        fullPage: true,
        path: path.join(artifactDir, "04-reloaded-detail.png"),
      });

      await page.locator('[data-test-id="cron-detail-tab-history"]').click();
      await waitForControlUiRoute(page, {
        pathname: "/automations/release%2Edigest/runs",
        routeId: "cron",
      });
      await page.locator('[data-test-id="cron-back"]').click();
      await waitForControlUiRoute(page, { pathname: "/automations", routeId: "cron" });
    } finally {
      await closeRecordedPage(recorded);
    }
  });
});
