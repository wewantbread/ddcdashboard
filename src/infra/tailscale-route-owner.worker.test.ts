import { fork, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  TAILSCALE_ROUTE_OWNER_ARG,
  type TailscaleRouteOwnerMessage,
} from "./tailscale-route-owner-protocol.js";
import { runTailscaleRouteOwner } from "./tailscale-route-owner.worker.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function spawnRouteOwnerFixture() {
  const workerPath = fileURLToPath(new URL("./tailscale-route-owner.worker.ts", import.meta.url));
  const fixturePath = fileURLToPath(
    new URL("../../test/fixtures/tailscale-foreground-fixture.mjs", import.meta.url),
  );
  const worker = fork(
    workerPath,
    [
      TAILSCALE_ROUTE_OWNER_ARG,
      JSON.stringify({ argv: [fixturePath, "serve", "--yes", "--bg=false", "18789"] }),
    ],
    {
      detached: true,
      execArgv: ["--import", "tsx"],
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    },
  );
  const messages: TailscaleRouteOwnerMessage[] = [];
  worker.on("message", (message: TailscaleRouteOwnerMessage) => messages.push(message));
  return { messages, worker };
}

function readProcessGroupId(pid: number): number {
  const result = spawnSync("ps", ["-p", String(pid), "-o", "pgid="], { encoding: "utf8" });
  const value = Number(result.stdout.trim());
  if (result.status !== 0 || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`failed to read process group for pid ${pid}`);
  }
  return value;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("Tailscale route owner", () => {
  it("reports readiness and terminates the foreground claim when its owner stops", async () => {
    const messages: TailscaleRouteOwnerMessage[] = [];
    const owner = runTailscaleRouteOwner(
      {
        argv: [
          process.execPath,
          "-e",
          'process.stdout.write("Press Ctrl+C to exit.\\n"); setInterval(() => {}, 1000)',
        ],
      },
      (message) => messages.push(message),
    );

    await vi.waitFor(() => {
      expect(messages).toContainEqual({ type: "ready" });
    });
    owner.stop();

    await expect(owner.exited).resolves.toMatchObject({ stopping: true });
    expect(messages.some((message) => message.type === "failed")).toBe(false);
  });

  it("reports command output when the claim exits before readiness", async () => {
    const messages: TailscaleRouteOwnerMessage[] = [];
    const owner = runTailscaleRouteOwner(
      {
        argv: [process.execPath, "-e", 'process.stderr.write("route denied\\n"); process.exit(7)'],
      },
      (message) => messages.push(message),
    );

    await expect(owner.exited).resolves.toMatchObject({ code: 7, stopping: false });
    expect(messages).toContainEqual(
      expect.objectContaining({ type: "failed", code: 7, stderr: "route denied\n" }),
    );
  });

  it.runIf(process.platform !== "win32")(
    "terminates the claim when the Gateway IPC owner disappears",
    async () => {
      const { messages, worker } = spawnRouteOwnerFixture();
      try {
        await vi.waitFor(() => {
          expect(messages).toContainEqual({ type: "ready" });
        });
        const spawned = messages.find(
          (message): message is Extract<TailscaleRouteOwnerMessage, { type: "spawned" }> =>
            message.type === "spawned",
        );
        expect(spawned).toBeDefined();
        expect(worker.pid).toBeDefined();
        expect(readProcessGroupId(spawned!.pid)).not.toBe(readProcessGroupId(worker.pid!));
        expect(readProcessGroupId(spawned!.pid)).toBe(spawned!.pid);
        expect(readProcessGroupId(worker.pid!)).toBe(worker.pid);
        const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
          (resolve) => {
            worker.once("exit", (code, signal) => resolve({ code, signal }));
          },
        );
        worker.disconnect();

        await expect(exit).resolves.toEqual({ code: 0, signal: null });
      } finally {
        if (worker.exitCode === null && worker.signalCode === null) {
          if (worker.pid) {
            try {
              process.kill(-worker.pid, "SIGKILL");
            } catch {
              worker.kill("SIGKILL");
            }
          } else {
            worker.kill("SIGKILL");
          }
        }
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "force-terminates wrapped descendants when the Gateway IPC owner disappears",
    async () => {
      const workerPath = fileURLToPath(
        new URL("./tailscale-route-owner.worker.ts", import.meta.url),
      );
      const temporaryDirectory = tempDirs.make("openclaw-route-owner-");
      const descendantPidPath = path.join(temporaryDirectory, "descendant.pid");
      const wrapperScript = [
        'const { spawn } = require("node:child_process")',
        'const { writeFileSync } = require("node:fs")',
        'const child = spawn(process.execPath, ["-e", "process.on(\'SIGTERM\', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" })',
        "writeFileSync(process.argv[1], String(child.pid))",
        'process.stdout.write("Press Ctrl+C to exit.\\n")',
        "process.on('SIGTERM', () => {})",
        "setInterval(() => {}, 1000)",
      ].join(";");
      const worker = fork(
        workerPath,
        [
          TAILSCALE_ROUTE_OWNER_ARG,
          JSON.stringify({ argv: [process.execPath, "-e", wrapperScript, descendantPidPath] }),
        ],
        {
          detached: true,
          execArgv: ["--import", "tsx"],
          stdio: ["ignore", "ignore", "ignore", "ipc"],
        },
      );
      const messages: TailscaleRouteOwnerMessage[] = [];
      let descendantPid: number | undefined;
      worker.on("message", (message: TailscaleRouteOwnerMessage) => messages.push(message));
      try {
        await vi.waitFor(() => {
          expect(messages).toContainEqual({ type: "ready" });
          descendantPid = Number(readFileSync(descendantPidPath, "utf8"));
          expect(Number.isSafeInteger(descendantPid)).toBe(true);
        });
        const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
          (resolve) => {
            worker.once("exit", (code, signal) => resolve({ code, signal }));
          },
        );
        worker.disconnect();

        await expect(exit).resolves.toEqual({ code: 0, signal: null });
        await vi.waitFor(
          () => {
            expect(processExists(descendantPid!)).toBe(false);
          },
          { timeout: 5_000 },
        );
      } finally {
        if (worker.exitCode === null && worker.signalCode === null && worker.pid) {
          try {
            process.kill(-worker.pid, "SIGKILL");
          } catch {
            worker.kill("SIGKILL");
          }
        }
        if (descendantPid && processExists(descendantPid)) {
          process.kill(descendantPid, "SIGKILL");
        }
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "stops the claim when IPC is already disconnected during worker startup",
    async () => {
      const workerPath = fileURLToPath(
        new URL("./tailscale-route-owner.worker.ts", import.meta.url),
      );
      const temporaryDirectory = tempDirs.make("openclaw-route-owner-");
      const claimantPidPath = path.join(temporaryDirectory, "claimant.pid");
      const claimantScript = [
        'const { writeFileSync } = require("node:fs")',
        "writeFileSync(process.argv[1], String(process.pid))",
        'process.stdout.write("Press Ctrl+C to exit.\\n")',
        "setInterval(() => {}, 1000)",
      ].join(";");
      const worker = fork(
        workerPath,
        [
          TAILSCALE_ROUTE_OWNER_ARG,
          JSON.stringify({ argv: [process.execPath, "-e", claimantScript, claimantPidPath] }),
        ],
        {
          detached: true,
          execArgv: ["--import", "tsx"],
          stdio: ["ignore", "ignore", "ignore", "ipc"],
        },
      );
      let claimantPid: number | undefined;
      try {
        const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
          (resolve) => {
            worker.once("exit", (code, signal) => resolve({ code, signal }));
          },
        );
        worker.disconnect();

        await expect(exit).resolves.toEqual({ code: 0, signal: null });
        if (existsSync(claimantPidPath)) {
          claimantPid = Number(readFileSync(claimantPidPath, "utf8"));
          expect(Number.isSafeInteger(claimantPid)).toBe(true);
          expect(processExists(claimantPid)).toBe(false);
        }
      } finally {
        if (worker.exitCode === null && worker.signalCode === null && worker.pid) {
          try {
            process.kill(-worker.pid, "SIGKILL");
          } catch {
            worker.kill("SIGKILL");
          }
        }
        if (claimantPid && processExists(claimantPid)) {
          process.kill(claimantPid, "SIGKILL");
        }
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "terminates the claim before exiting on an interactive interrupt",
    async () => {
      const { messages, worker } = spawnRouteOwnerFixture();
      let routePid: number | undefined;
      try {
        await vi.waitFor(() => {
          expect(messages).toContainEqual({ type: "ready" });
        });
        const spawned = messages.find((message) => message.type === "spawned");
        if (!spawned) {
          throw new Error("route owner did not report its claim process");
        }
        routePid = spawned.pid;
        const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
          (resolve) => {
            worker.once("exit", (code, signal) => resolve({ code, signal }));
          },
        );
        worker.kill("SIGINT");

        await expect(exit).resolves.toEqual({ code: 0, signal: null });
        await vi.waitFor(() => {
          expect(() => process.kill(spawned.pid, 0)).toThrow();
        });
      } finally {
        if (worker.exitCode === null && worker.signalCode === null) {
          worker.kill("SIGKILL");
        }
        if (routePid) {
          try {
            process.kill(routePid, "SIGKILL");
          } catch {
            // Already released by the worker.
          }
        }
      }
    },
  );
});
