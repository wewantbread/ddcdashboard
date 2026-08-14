import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import type { PersistedWorkboardCard, WorkboardKeyedStore } from "./persistence-types.js";
import { WorkboardStore } from "./store.js";

describe("WorkboardStore lifecycle", () => {
  it("drains an admitted nested write, closes once, and rejects late operations", async () => {
    const registerEntered = createDeferred<void>();
    const releaseRegister = createDeferred<void>();
    const rows = new Map<string, PersistedWorkboardCard>();
    const persistence: WorkboardKeyedStore = {
      async register(key, value) {
        registerEntered.resolve();
        await releaseRegister.promise;
        rows.set(key, value);
      },
      async lookup(key) {
        return rows.get(key);
      },
      async delete(key) {
        return rows.delete(key);
      },
      async entries() {
        return [...rows].map(([key, value]) => ({ key, value }));
      },
    };
    const closePersistence = vi.fn();
    const store = new WorkboardStore(persistence, { close: closePersistence });

    const creating = store.create({ title: "Drain before close" });
    await registerEntered.promise;
    const closing = store.close();
    const closingAgain = store.close();

    expect(closePersistence).not.toHaveBeenCalled();
    releaseRegister.resolve();
    await expect(creating).resolves.toMatchObject({ title: "Drain before close" });
    await Promise.all([closing, closingAgain]);

    expect(closePersistence).toHaveBeenCalledOnce();
    expect(rows.size).toBe(1);
    await expect(store.list()).rejects.toThrow("workboard store is closed.");
    await expect(store.create({ title: "Too late" })).rejects.toThrow("workboard store is closed.");
    expect(rows.size).toBe(1);
  });
});
