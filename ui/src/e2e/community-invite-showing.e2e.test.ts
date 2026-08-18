// Control UI tests cover the community invite showing protocol in a real browser,
// across two pages of one browser profile. jsdom cannot carry this proof: Web Locks
// do not exist there, so mutual exclusion, lock release and the fail-closed
// behavior of a browser without a lock manager can only be observed here.
import { expect, it } from "vitest";
import { installMockGateway, startControlUiE2eServer } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI community invite showing E2E",
  // The private source server, because this proof drives the invite module the app
  // loads lazily rather than reaching it through the shipped bundle.
  startServer: () => startControlUiE2eServer(undefined, { source: true }),
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

const STORAGE_KEY = "openclaw:control-ui:community-invite:v1";
const RUNTIME_MODULE = "/src/app/community-invite.runtime.ts";

/** Evaluated as source text so the browser itself imports the module. A literal
 * import() in this file would be rewritten for the test module runner and never
 * reach the page. */
const CLAIM_EXPRESSION = `import(${JSON.stringify(RUNTIME_MODULE)}).then((module) => module.claimCommunityInviteShowing())`;

type InviteContext = Awaited<ReturnType<typeof suite.browser.newContext>>;
type InvitePage = Awaited<ReturnType<InviteContext["newPage"]>>;
type StorageFault = "none" | "no-locks" | "throwing-write" | "dropped-write";

/** An armed record: qualified often enough already, upgraded cohort, never shown. */
function armedRecord(): string {
  return JSON.stringify({
    firstQualifiedAtMs: Date.now() - 60 * 60 * 1000,
    qualifiedLoads: 2,
    established: true,
  });
}

function claimIn(page: InvitePage): Promise<boolean> {
  return page.evaluate(CLAIM_EXPRESSION);
}

function seedArmedRecord(page: InvitePage): Promise<void> {
  return page.evaluate(
    ([key, record]) => {
      localStorage.setItem(key, record);
    },
    [STORAGE_KEY, armedRecord()] as const,
  );
}

function readTombstone(page: InvitePage): Promise<number | null> {
  return page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    return raw ? ((JSON.parse(raw) as { shownAtMs?: number }).shownAtMs ?? null) : null;
  }, STORAGE_KEY);
}

suite.define(() => {
  it("lets one page of a browser profile show the card, and never a second", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });

    async function openPage(): Promise<InvitePage> {
      const page = await context.newPage();
      await installMockGateway(page);
      await page.goto(suite.server.baseUrl);
      return page;
    }

    try {
      const first = await openPage();
      const second = await openPage();

      // Same origin and same browser profile, so both pages share one localStorage
      // and one Web Locks namespace — exactly the situation two tabs are in.
      await seedArmedRecord(first);
      expect(await readTombstone(second)).toBeNull();

      // Both pages race for the same showing.
      const claims = await Promise.all([claimIn(first), claimIn(second)]);
      expect(claims.filter(Boolean)).toHaveLength(1);

      // The winner left a durable tombstone, visible from the other page.
      expect(await readTombstone(second)).toBeGreaterThan(0);

      // The lock is released once the claim is decided, so a later attempt is
      // turned away by the tombstone rather than blocked by a held lock. Were the
      // lock still held, this would hang instead of resolving false.
      expect(await claimIn(first)).toBe(false);
      expect(await claimIn(second)).toBe(false);

      // A page that dies right after being shown changes nothing: the tombstone was
      // written before the card, so the surviving page still refuses.
      await first.close();
      expect(await claimIn(second)).toBe(false);
    } finally {
      await context.close();
    }
  });

  it("refuses to show when storage or Web Locks cannot carry the tombstone", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });

    try {
      const page = await context.newPage();
      await installMockGateway(page);
      await page.goto(suite.server.baseUrl);

      const applyFault = (fault: StorageFault) =>
        page.evaluate((mode) => {
          // Both faults are installed and undone through property descriptors, so
          // the originals are restored exactly as the platform defined them.
          const writeDescriptor = Object.getOwnPropertyDescriptor(Storage.prototype, "setItem");
          // `locks` lives on the prototype, so removing it there is what makes
          // `"locks" in navigator` false the way an unsupporting browser does.
          const locksDescriptor = Object.getOwnPropertyDescriptor(Navigator.prototype, "locks");
          Object.assign(globalThis, {
            openclawInviteRestore: () => {
              if (writeDescriptor) {
                Object.defineProperty(Storage.prototype, "setItem", writeDescriptor);
              }
              if (locksDescriptor) {
                Object.defineProperty(Navigator.prototype, "locks", locksDescriptor);
              }
            },
          });
          if (mode === "no-locks") {
            Reflect.deleteProperty(Navigator.prototype, "locks");
          }
          if (mode === "throwing-write") {
            Storage.prototype.setItem = () => {
              throw new DOMException("quota", "QuotaExceededError");
            };
          }
          if (mode === "dropped-write") {
            Storage.prototype.setItem = () => undefined;
          }
        }, fault);

      const undoFault = () =>
        page.evaluate(() => {
          (globalThis as { openclawInviteRestore?: () => void }).openclawInviteRestore?.();
        });

      async function claimUnder(
        fault: StorageFault,
      ): Promise<{ claimed: boolean; tombstone: number | null }> {
        await seedArmedRecord(page);
        await applyFault(fault);
        try {
          const claimed = await claimIn(page);
          await undoFault();
          return { claimed, tombstone: await readTombstone(page) };
        } finally {
          await undoFault();
          await page.evaluate(() => {
            localStorage.clear();
          });
        }
      }

      // The control: with everything working, this page does claim the showing.
      const granted = await claimUnder("none");
      expect(granted.claimed).toBe(true);
      expect(granted.tombstone).toBeGreaterThan(0);

      // Every fault answers the same way, because a card with no durable tombstone
      // would come back on the next load — and might already be up in another tab.
      expect(await claimUnder("no-locks")).toEqual({ claimed: false, tombstone: null });
      expect(await claimUnder("throwing-write")).toEqual({ claimed: false, tombstone: null });
      expect(await claimUnder("dropped-write")).toEqual({ claimed: false, tombstone: null });

      // Storage emptied between arming and the claim: nothing to stamp, so nothing
      // is shown.
      await seedArmedRecord(page);
      await page.evaluate(() => {
        localStorage.clear();
      });
      expect(await claimIn(page)).toBe(false);
    } finally {
      await context.close();
    }
  });
});
