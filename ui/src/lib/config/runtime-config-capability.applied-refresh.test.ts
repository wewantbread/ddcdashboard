// @vitest-environment node
import { expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ConfigSnapshot } from "../../api/types.ts";
import { createConfigCapabilityHarness, deferred } from "./config-test-harness.ts";

it("keeps applied-hash polling in the background while converging", async () => {
  vi.useFakeTimers();
  const refresh = deferred<ConfigSnapshot>();
  let getCount = 0;
  const snapshot = {
    config: { count: 2 },
    raw: '{"count":2}',
    hash: "raw-hash-2",
    configRevisionHash: "revision-2",
    appliedConfigHash: "revision-1",
    valid: true,
    issues: [],
  } satisfies ConfigSnapshot;
  const request = vi.fn((method: string) => {
    if (method !== "config.get") {
      return Promise.resolve({});
    }
    getCount += 1;
    return getCount === 1 ? Promise.resolve(snapshot) : refresh.promise;
  });
  const { runtimeConfig } = createConfigCapabilityHarness(
    request as GatewayBrowserClient["request"],
  );
  await runtimeConfig.ensureLoaded();
  const loadingPublications: boolean[] = [];
  runtimeConfig.subscribe((state) => loadingPublications.push(state.configLoading));

  await vi.advanceTimersByTimeAsync(250);

  expect(getCount).toBe(2);
  expect(loadingPublications).not.toContain(true);
  refresh.resolve({ ...snapshot, appliedConfigHash: "revision-2" });
  await vi.advanceTimersByTimeAsync(0);
  expect(runtimeConfig.state.configNeedsApply).toBe(false);
  runtimeConfig.dispose();
});
