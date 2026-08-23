import { describe, expect, it } from "vitest";
import {
  buildControlUiAutomationPath,
  parseControlUiAutomationPath,
} from "./automation.runtime.js";

describe("buildControlUiAutomationPath", () => {
  it.each([
    ["settings", undefined, "/automations/nightly%2Edigest"],
    ["runs", "runs", "/automations/nightly%2Edigest/runs"],
    ["nested base path", undefined, "/control/automations/nightly%2Edigest"],
  ] as const)("builds the %s route", (_label, tab, expected) => {
    expect(
      buildControlUiAutomationPath("nightly.digest", {
        ...(tab ? { tab } : {}),
        ...(_label === "nested base path" ? { basePath: "/control/" } : {}),
      }),
    ).toBe(expected);
  });

  it("encodes opaque job ids as one safe path segment", () => {
    expect(buildControlUiAutomationPath("team/audit ~ daily")).toBe(
      "/automations/team%2Faudit%20~%20daily",
    );
  });

  it("rejects a blank job id", () => {
    expect(buildControlUiAutomationPath(" ")).toBeNull();
  });
});

describe("parseControlUiAutomationPath", () => {
  it("round-trips an encoded job route", () => {
    const path = buildControlUiAutomationPath("nightly.digest", { tab: "runs" });
    expect(path && parseControlUiAutomationPath(path)).toEqual({
      jobId: "nightly.digest",
      tab: "runs",
    });
  });

  it("accepts the legacy route alias", () => {
    expect(parseControlUiAutomationPath("/cron/nightly%2Edigest/runs")).toEqual({
      jobId: "nightly.digest",
      tab: "runs",
    });
  });

  it.each(["/automations/%", "/automations/job/runs/extra", "/automations/job/unknown"])(
    "rejects the malformed route %s",
    (path) => {
      expect(parseControlUiAutomationPath(path)).toBeNull();
    },
  );

  it("decodes an encoded slash without accepting a nested route", () => {
    expect(parseControlUiAutomationPath("/automations/job%2Fchild")).toEqual({
      jobId: "job/child",
      tab: "settings",
    });
    expect(parseControlUiAutomationPath("/automations/job/child")).toBeNull();
  });
});
