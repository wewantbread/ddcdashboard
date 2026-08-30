import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isPidAlive } from "../../shared/pid-alive.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { killPidIfAlive, waitForPidFile, waitForPidToExit } from "../../test-utils/process-tree.js";
import { withTempDir } from "../../test-utils/temp-dir.js";
import { testing } from "./stage-sandbox-media.test-support.js";

async function rejectAfter<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let watchdog: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        watchdog = setTimeout(
          () => reject(new Error("scp cancellation watchdog expired")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (watchdog) {
      clearTimeout(watchdog);
    }
  }
}

describe("scpFile cancellation", () => {
  it.runIf(process.platform !== "win32")(
    "aborts the real scp process tree and preserves the run abort reason",
    { timeout: 10_000 },
    async () =>
      withTempDir("openclaw-scp-abort-", async (dir) => {
        const binDir = path.join(dir, "bin");
        const scpPath = path.join(binDir, "scp");
        const parentPidPath = path.join(dir, "parent.pid");
        const descendantPidPath = path.join(dir, "descendant.pid");
        await fs.mkdir(binDir);
        await fs.writeFile(
          scpPath,
          [
            "#!/usr/bin/env node",
            'const { spawn } = require("node:child_process");',
            'const { writeFileSync } = require("node:fs");',
            "process.on('SIGTERM', () => {});",
            "const descendantSource = \"process.on('SIGTERM', () => {}); process.send('ready'); setInterval(() => {}, 1000)\";",
            "const child = spawn(process.execPath, ['-e', descendantSource], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });",
            "child.once('message', () => {",
            "  writeFileSync(process.env.DESCENDANT_PID_FILE, String(child.pid));",
            "  writeFileSync(process.env.PARENT_PID_FILE, String(process.pid));",
            "});",
            "setInterval(() => {}, 1000);",
          ].join("\n"),
          "utf8",
        );
        await fs.chmod(scpPath, 0o700);

        let parentPid: number | undefined;
        let descendantPid: number | undefined;
        let scpPromise: Promise<void> | undefined;
        await withEnvAsync(
          {
            PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
            PARENT_PID_FILE: parentPidPath,
            DESCENDANT_PID_FILE: descendantPidPath,
          },
          async () => {
            const controller = new AbortController();
            const abortReason = new Error("remote media staging cancelled");
            try {
              scpPromise = testing.scpFile(
                "gateway-host",
                "/remote/attachment.jpg",
                path.join(dir, "download"),
                controller.signal,
              );
              [parentPid, descendantPid] = await Promise.all([
                waitForPidFile(parentPidPath),
                waitForPidFile(descendantPidPath),
              ]);
              expect(isPidAlive(parentPid)).toBe(true);
              expect(isPidAlive(descendantPid)).toBe(true);

              controller.abort(abortReason);

              await expect(rejectAfter(scpPromise, 2_000)).rejects.toBe(abortReason);
              expect(await waitForPidToExit(parentPid)).toBe(true);
              expect(await waitForPidToExit(descendantPid)).toBe(true);
            } finally {
              killPidIfAlive(descendantPid);
              killPidIfAlive(parentPid);
              await scpPromise?.catch(() => {});
            }
          },
        );
      }),
  );
});
