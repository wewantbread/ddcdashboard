import { afterEach, describe, expect, it, vi } from "vitest";
import * as bundledHealthChecks from "../flows/bundled-health-checks.js";
import { runDoctorLintCli } from "./doctor-lint.js";

const CRABBOX_CLOUD_WORKER_PROFILE_CHECK_ID = "crabbox/cloud-worker-profiles";

const mocks = vi.hoisted(() => ({
  readConfigFileSnapshot: vi.fn(),
  resolveDoctorContributionHealthChecks: vi.fn(),
}));

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    readConfigFileSnapshot: mocks.readConfigFileSnapshot,
  };
});

vi.mock("../flows/doctor-health-contributions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../flows/doctor-health-contributions.js")>();
  return {
    ...actual,
    resolveDoctorContributionHealthChecks: (...args: unknown[]) =>
      mocks.resolveDoctorContributionHealthChecks(...args),
  };
});

const runtime = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
};

describe("runDoctorLintCli crabbox profiles", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports an actionable Crabbox profile finding before dispatch", async () => {
    const binary = "/nonexistent/path/to/crabbox";
    mocks.readConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: true,
      config: {
        gateway: { mode: "local", port: 19_001 },
        cloudWorkers: {
          profiles: {
            aws: {
              provider: "crabbox",
              install: "bundle",
              settings: { provider: "aws", class: "standard", binary },
            },
          },
        },
      },
      path: "/tmp/openclaw.json",
    });
    mocks.resolveDoctorContributionHealthChecks.mockResolvedValue([
      {
        id: CRABBOX_CLOUD_WORKER_PROFILE_CHECK_ID,
        kind: "plugin",
        description: "Verify configured Crabbox cloud worker profiles before dispatch.",
        async detect() {
          return [
            {
              checkId: CRABBOX_CLOUD_WORKER_PROFILE_CHECK_ID,
              severity: "warning",
              message: `Cloud worker profile "aws" cannot use Crabbox because ${binary} is not an executable file.`,
              path: binary,
              target: "aws",
              fixHint:
                "Install Crabbox 0.41.1 or newer at /nonexistent/path/to/crabbox, or set cloudWorkers.profiles.aws.settings.binary to an executable absolute path, then rerun `openclaw doctor --json`.",
            },
          ];
        },
      },
    ]);
    vi.spyOn(bundledHealthChecks, "registerBundledHealthChecks").mockImplementation(() => {});
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const exitCode = await runDoctorLintCli(runtime, {
      json: true,
      onlyIds: [CRABBOX_CLOUD_WORKER_PROFILE_CHECK_ID],
    });

    expect(exitCode).toBe(1);
    const payload = JSON.parse(String(stdout.mock.calls.at(-1)?.[0]));
    expect(payload).toMatchObject({
      ok: false,
      checksRun: 1,
      findings: [
        {
          checkId: CRABBOX_CLOUD_WORKER_PROFILE_CHECK_ID,
          severity: "warning",
          path: binary,
          target: "aws",
        },
      ],
    });
    expect(payload.findings[0].message).toContain('profile "aws"');
    expect(payload.findings[0].fixHint).toContain("cloudWorkers.profiles.aws.settings.binary");
  });
});
