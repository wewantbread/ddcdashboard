/** Tests FileSettingsStorage atomic persistence and failure behavior. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileSettingsStorage } from "./settings-storage.js";

describe("FileSettingsStorage", () => {
  let tempDir = "";

  afterEach(() => {
    vi.restoreAllMocks();
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = "";
    }
  });

  function createStorage() {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-settings-storage-"));
    const agentDir = path.join(tempDir, "agent");
    const cwd = path.join(tempDir, "project");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(cwd, { recursive: true });
    return {
      storage: new FileSettingsStorage(cwd, agentDir),
      agentDir,
      settingsPath: path.join(agentDir, "settings.json"),
    };
  }

  function failWritesUnder(dir: string) {
    const realOpenSync = fs.openSync;
    const realWriteFileSync = fs.writeFileSync;
    const tempFds = new Set<number>();
    // fs-safe writes the temp blob through openSync + writeFileSync(fd), so the
    // fault hooks the temp-file open and fails its first fd write, leaving a
    // half-written blob behind, exactly like a mid-write ENOSPC.
    vi.spyOn(fs, "openSync").mockImplementation((target, flags, mode) => {
      const fd = realOpenSync(target, flags as never, mode as never);
      if (String(target).startsWith(dir) && String(target).endsWith(".tmp")) {
        tempFds.add(fd);
      }
      return fd;
    });
    vi.spyOn(fs, "writeFileSync").mockImplementation((target, data, options) => {
      if (typeof target === "number" && tempFds.has(target) && typeof data === "string") {
        realWriteFileSync(target, data.slice(0, Math.floor(data.length / 2)), options as never);
        throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      }
      return realWriteFileSync(target, data, options as never);
    });
  }

  it("persists settings through withLock", () => {
    const { storage, settingsPath } = createStorage();

    storage.withLock("global", (current) => {
      expect(current).toBeUndefined();
      return JSON.stringify({ packages: ["npm:@openclaw/global"] });
    });

    expect(fs.readFileSync(settingsPath, "utf-8")).toBe(
      JSON.stringify({ packages: ["npm:@openclaw/global"] }),
    );
  });

  it("keeps the original settings when a save fails partway through the write", () => {
    const { storage, agentDir, settingsPath } = createStorage();
    const original = JSON.stringify({ packages: ["npm:@openclaw/keep"] });
    fs.writeFileSync(settingsPath, original, "utf-8");
    failWritesUnder(agentDir);

    expect(() =>
      storage.withLock("global", () => JSON.stringify({ packages: ["npm:@openclaw/new"] })),
    ).toThrow("disk full");

    expect(fs.readFileSync(settingsPath, "utf-8")).toBe(original);
    expect(fs.readdirSync(agentDir).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
  });

  it.runIf(process.platform !== "win32")("preserves the existing file mode across rewrites", () => {
    const { storage, settingsPath } = createStorage();
    fs.writeFileSync(settingsPath, JSON.stringify({ packages: ["old"] }), "utf-8");
    fs.chmodSync(settingsPath, 0o600);

    storage.withLock("global", () => JSON.stringify({ packages: ["new"] }));

    expect(fs.statSync(settingsPath).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(settingsPath, "utf-8")).toBe(JSON.stringify({ packages: ["new"] }));
  });

  it.runIf(process.platform !== "win32")(
    "preserves a final settings.json symlink and updates its target",
    () => {
      const { storage, agentDir, settingsPath } = createStorage();
      const target = path.join(agentDir, "operator-managed-settings.json");
      fs.writeFileSync(target, JSON.stringify({ packages: ["old"] }), "utf-8");
      fs.symlinkSync(target, settingsPath);

      storage.withLock("global", () => JSON.stringify({ packages: ["new"] }));

      expect(fs.lstatSync(settingsPath).isSymbolicLink()).toBe(true);
      expect(fs.readFileSync(target, "utf-8")).toBe(JSON.stringify({ packages: ["new"] }));
      expect(fs.readFileSync(settingsPath, "utf-8")).toBe(JSON.stringify({ packages: ["new"] }));
      expect(fs.readdirSync(agentDir).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
    },
  );
});
