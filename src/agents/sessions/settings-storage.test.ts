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
    const realWriteFileSync = fs.writeFileSync;
    vi.spyOn(fs, "writeFileSync").mockImplementation((target, data, options) => {
      if (String(target).startsWith(dir)) {
        const text = String(data);
        realWriteFileSync(target, text.slice(0, Math.floor(text.length / 2)), options as never);
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
});
