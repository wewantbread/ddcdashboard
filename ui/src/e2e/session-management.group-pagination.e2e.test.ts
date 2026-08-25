import { expect, it } from "vitest";
import {
  captureUiProof,
  captureUiProofEnabled,
  collapsedSessionSectionsStorageKey,
  createSessionManagementE2eSuite,
  installMockGateway,
  requireRecord,
  sessionRow,
  sessionsListResponse,
  uiProofArtifactDir,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();

suite.define(() => {
  it("loads the global next page outside Other and regroups appended rows", async () => {
    const baseTime = Date.parse("2026-07-01T16:00:00.000Z");
    const jesseRows = Array.from({ length: 10 }, (_, index) =>
      sessionRow(`agent:main:jesse-${index}`, `Jesse session ${index + 1}`, baseTime - index, {
        category: "Jesse",
      }),
    );
    const firstPage = [
      jesseRows[0],
      ...Array.from({ length: 59 }, (_, index) =>
        sessionRow(
          `agent:main:other-${index}`,
          `Other session ${index + 1}`,
          baseTime - 100 - index,
        ),
      ),
    ];
    const context = await suite.browser.newContext({
      colorScheme: "dark",
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
      recordVideo: captureUiProofEnabled
        ? { dir: uiProofArtifactDir, size: { height: 900, width: 1280 } }
        : undefined,
    });
    const page = await context.newPage();
    await page.addInitScript(({ key, value }) => localStorage.setItem(key, value), {
      key: collapsedSessionSectionsStorageKey,
      value: JSON.stringify(["category:Jesse", "ungrouped"]),
    });
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "sessions.list": {
          cases: [
            {
              match: { limit: 60, offset: 60 },
              response: sessionsListResponse(jesseRows.slice(1), {
                offset: 60,
                totalCount: 69,
              }),
            },
            {
              response: sessionsListResponse(firstPage, {
                hasMore: true,
                nextOffset: 60,
                totalCount: 69,
              }),
            },
          ],
        },
      },
      featureMethods: ["chat.metadata", "chat.startup", "sessions.groups.list"],
      sessionGroups: ["Jesse"],
      sessionKey: "agent:main:jesse-0",
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const group = page.locator('[data-session-section="category:Jesse"]');
      await group.waitFor({ state: "visible", timeout: 10_000 });
      await expect.poll(() => group.locator(".sidebar-recent-session").count()).toBe(0);
      const globalPagination = page.locator(
        ".sidebar-recent-sessions > .sidebar-session-pagination",
      );
      await expect.poll(() => globalPagination.count()).toBe(1);
      await captureUiProof(page, "sidebar-global-pagination.png");

      await globalPagination.getByRole("button", { name: "Load more sessions" }).click();
      await expect
        .poll(async () =>
          (await gateway.getRequests("sessions.list")).some((request) => {
            const params = requireRecord(request.params);
            return params.offset === 60 && params.limit === 60 && params.category === undefined;
          }),
        )
        .toBe(true);
      await expect.poll(() => globalPagination.count()).toBe(0);

      await group.getByRole("button", { name: "Jesse", exact: true }).click();
      await expect.poll(() => group.locator(".sidebar-recent-session").count()).toBe(10);
      await captureUiProof(page, "sidebar-jesse-group-complete.png");
    } finally {
      await context.close();
    }
  });
});
