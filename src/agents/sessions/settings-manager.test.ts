/** Tests session settings loading, persistence, and runtime overrides. */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FileSettingsStorage,
  SettingsManager,
  type SettingsScope,
  type SettingsStorage,
} from "./settings-manager.js";

class InspectableSettingsStorage implements SettingsStorage {
  private values: Record<SettingsScope, string | undefined> = {
    global: undefined,
    project: undefined,
  };

  withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void {
    const next = fn(this.values[scope]);
    if (next !== undefined) {
      this.values[scope] = next;
    }
  }

  set(scope: SettingsScope, value: unknown): void {
    this.values[scope] = typeof value === "string" ? value : JSON.stringify(value);
  }

  get(scope: SettingsScope): unknown {
    const value = this.values[scope];
    return value === undefined ? undefined : JSON.parse(value);
  }
}

describe("SettingsManager scoped persistence", () => {
  it("preserves external sibling changes while writing global and project scopes", async () => {
    const storage = new InspectableSettingsStorage();
    storage.set("global", {
      terminal: { showImages: true, imageWidthCells: 60 },
      packages: ["npm:@openclaw/global"],
    });
    storage.set("project", {
      packages: ["npm:@openclaw/project"],
      skills: ["old-skill"],
    });
    const settingsManager = SettingsManager.fromStorage(storage);

    const updatedSkills = ["new-skill"];
    settingsManager.setShowImages(false);
    settingsManager.setProjectSkillPaths(updatedSkills);
    updatedSkills.push("caller-mutation");
    storage.set("global", {
      terminal: { showImages: true, imageWidthCells: 120, clearOnShrink: true },
      packages: ["npm:@openclaw/global"],
    });
    storage.set("project", {
      packages: ["npm:@openclaw/external"],
      skills: ["old-skill"],
      themes: ["external-theme"],
    });

    await settingsManager.flush();

    expect(storage.get("global")).toEqual({
      terminal: { showImages: false, imageWidthCells: 120, clearOnShrink: true },
      packages: ["npm:@openclaw/global"],
    });
    expect(storage.get("project")).toEqual({
      packages: ["npm:@openclaw/external"],
      skills: ["new-skill"],
      themes: ["external-theme"],
    });

    await settingsManager.reload();
    expect(settingsManager.getShowImages()).toBe(false);
    expect(settingsManager.getImageWidthCells()).toBe(120);
    expect(settingsManager.getClearOnShrink()).toBe(true);
    expect(settingsManager.getPackages()).toEqual(["npm:@openclaw/external"]);
    expect(settingsManager.getSkillPaths()).toEqual(["new-skill"]);
    expect(settingsManager.getThemePaths()).toEqual(["external-theme"]);
  });

  it("isolates parse failures to the affected scope", async () => {
    const storage = new InspectableSettingsStorage();
    storage.set("global", "{");
    storage.set("project", { skills: ["old-skill"] });
    const settingsManager = SettingsManager.fromStorage(storage);

    expect(settingsManager.drainErrors()).toEqual([
      expect.objectContaining({ scope: "global", error: expect.any(SyntaxError) }),
    ]);
    settingsManager.setTheme("blocked-global-write");
    settingsManager.setProjectSkillPaths(["new-skill"]);
    await settingsManager.flush();

    expect(() => storage.get("global")).toThrow(SyntaxError);
    expect(storage.get("project")).toEqual({ skills: ["new-skill"] });
  });
});

describe("SettingsManager runtime overrides", () => {
  it("preserves compaction overrides after global setting writes", async () => {
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
    });

    settingsManager.applyOverrides({
      compaction: { reserveTokens: 50_000, keepRecentTokens: 16_000 },
    });
    settingsManager.setCompactionEnabled(false);

    expect(settingsManager.getCompactionSettings()).toEqual({
      enabled: false,
      reserveTokens: 50_000,
      keepRecentTokens: 16_000,
    });

    await settingsManager.flush();
    await settingsManager.reload();

    expect(settingsManager.getCompactionSettings()).toEqual({
      enabled: false,
      reserveTokens: 50_000,
      keepRecentTokens: 16_000,
    });
  });

  it("preserves runtime overrides after project setting writes", async () => {
    const settingsManager = SettingsManager.inMemory({
      compaction: { reserveTokens: 16_384 },
    });

    settingsManager.applyOverrides({ compaction: { reserveTokens: 50_000 } });
    settingsManager.setProjectPackages(["npm:@openclaw/example"]);

    expect(settingsManager.getPackages()).toEqual(["npm:@openclaw/example"]);
    expect(settingsManager.getCompactionReserveTokens()).toBe(50_000);

    await settingsManager.flush();
    await settingsManager.reload();

    expect(settingsManager.getPackages()).toEqual(["npm:@openclaw/example"]);
    expect(settingsManager.getCompactionReserveTokens()).toBe(50_000);
  });

  it("recursively merges provider retry overrides and replaces arrays", () => {
    const settingsManager = SettingsManager.inMemory({
      retry: {
        provider: { timeoutMs: 30_000, maxRetries: 2, maxRetryDelayMs: 60_000 },
      },
      packages: ["npm:@openclaw/base"],
    });

    settingsManager.applyOverrides({
      retry: { provider: { maxRetries: 5 } },
      packages: ["npm:@openclaw/override"],
    });

    expect(settingsManager.getProviderRetrySettings()).toEqual({
      timeoutMs: 30_000,
      maxRetries: 5,
      maxRetryDelayMs: 60_000,
    });
    expect(settingsManager.getPackages()).toEqual(["npm:@openclaw/override"]);
  });
});

describe("FileSettingsStorage first-write locking", () => {
  const tempDirs: string[] = [];

  function makeTempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("holds the lock across the read when the settings file does not exist yet", () => {
    const dir = makeTempDir("openclaw-settings-race-");
    const settingsPath = join(dir, "settings.json");
    const storage = new FileSettingsStorage(dir, dir);
    const lockedDuringCallback: boolean[] = [];

    storage.withLockedUpdate("global", (current) => {
      // A competing process cannot take this lock, so it cannot read the same
      // empty base and overwrite the value written below.
      lockedDuringCallback.push(existsSync(`${settingsPath}.lock`));
      expect(current).toBeUndefined();
      return JSON.stringify({ defaultModel: "from-this-process" });
    });

    expect(lockedDuringCallback).toEqual([true]);
    expect(JSON.parse(readFileSync(settingsPath, "utf-8"))).toEqual({
      defaultModel: "from-this-process",
    });
    expect(existsSync(`${settingsPath}.lock`)).toBe(false);
  });

  it("merges against the file another process created before the lock was granted", () => {
    const dir = makeTempDir("openclaw-settings-existing-");
    const settingsPath = join(dir, "settings.json");
    const storage = new FileSettingsStorage(dir, dir);
    // Stand in for the process that won the create race.
    writeFileSync(settingsPath, JSON.stringify({ theme: "from-other-process" }), "utf-8");
    const callbackCalls: (string | undefined)[] = [];

    storage.withLockedUpdate("global", (current) => {
      callbackCalls.push(current);
      const base = current ? (JSON.parse(current) as Record<string, unknown>) : {};
      return JSON.stringify({ ...base, defaultModel: "from-this-process" });
    });

    expect(callbackCalls).toHaveLength(1);
    expect(JSON.parse(readFileSync(settingsPath, "utf-8"))).toEqual({
      theme: "from-other-process",
      defaultModel: "from-this-process",
    });
  });

  it("invokes the public withLock callback exactly once on the create path", () => {
    const dir = makeTempDir("openclaw-settings-once-");
    const settingsPath = join(dir, "settings.json");
    const storage = new FileSettingsStorage(dir, dir);
    const callbackCalls: (string | undefined)[] = [];

    storage.withLock("global", (current) => {
      callbackCalls.push(current);
      if (current === undefined) {
        // Another process creates the file mid-callback. The public contract is
        // one invocation, so plugin side effects are never replayed.
        writeFileSync(settingsPath, JSON.stringify({ theme: "from-other-process" }), "utf-8");
      }
      return JSON.stringify({ defaultModel: "from-this-process" });
    });

    expect(callbackCalls).toEqual([undefined]);
    expect(JSON.parse(readFileSync(settingsPath, "utf-8"))).toEqual({
      defaultModel: "from-this-process",
    });
  });

  it("writes normally when no competing process creates the file", () => {
    const dir = makeTempDir("openclaw-settings-first-");
    const settingsPath = join(dir, "settings.json");
    const storage = new FileSettingsStorage(dir, dir);

    storage.withLockedUpdate("global", () => JSON.stringify({ theme: "solo" }));

    expect(JSON.parse(readFileSync(settingsPath, "utf-8"))).toEqual({ theme: "solo" });
  });

  it("skips the write and releases the lock when the mutator returns undefined", () => {
    const dir = makeTempDir("openclaw-settings-noop-");
    const settingsPath = join(dir, "settings.json");
    const storage = new FileSettingsStorage(dir, dir);

    storage.withLockedUpdate("global", () => undefined);

    expect(existsSync(settingsPath)).toBe(false);
    expect(existsSync(`${settingsPath}.lock`)).toBe(false);
  });
});
