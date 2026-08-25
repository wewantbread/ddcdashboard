import { randomUUID } from "node:crypto";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  readWorkspaceFileCache,
  retireWorkspaceFileCache,
  writeWorkspaceFileCache,
} from "./workspace-file-cache.js";

const MIB = 1024 * 1024;
let workspaceRoot = "";

beforeEach(() => {
  workspaceRoot = path.resolve(`/workspace-cache-${randomUUID()}`);
});

afterEach(() => {
  retireWorkspaceFileCache([workspaceRoot]);
});

function cacheFile(name: string, sizeBytes: number, identity = name): string {
  const filePath = path.join(workspaceRoot, name);
  writeWorkspaceFileCache({
    filePath,
    content: "x".repeat(sizeBytes),
    identity,
  });
  return filePath;
}

describe("workspace file byte cache", () => {
  it("evicts the oldest of 65 empty entries", () => {
    const oldest = cacheFile("entry-0", 0);
    for (let index = 1; index <= 64; index += 1) {
      cacheFile(`entry-${index}`, 0);
    }

    expect(readWorkspaceFileCache(oldest, "entry-0")).toBeUndefined();
    expect(readWorkspaceFileCache(path.join(workspaceRoot, "entry-64"), "entry-64")).toBe("");
  });

  it("evicts oldest content by aggregate bytes", () => {
    const oldest = cacheFile("oldest", 7 * MIB);
    const newest = cacheFile("newest", 6 * MIB);

    expect(readWorkspaceFileCache(oldest, "oldest")).toBeUndefined();
    expect(readWorkspaceFileCache(newest, "newest")).toHaveLength(6 * MIB);
  });

  it("promotes cache hits before weighted eviction", () => {
    const first = cacheFile("first", 4 * MIB);
    const second = cacheFile("second", 4 * MIB);
    const third = cacheFile("third", 4 * MIB);
    expect(readWorkspaceFileCache(first, "first")).toHaveLength(4 * MIB);

    const newest = cacheFile("newest", 1);

    expect(readWorkspaceFileCache(second, "second")).toBeUndefined();
    expect(readWorkspaceFileCache(first, "first")).toHaveLength(4 * MIB);
    expect(readWorkspaceFileCache(third, "third")).toHaveLength(4 * MIB);
    expect(readWorkspaceFileCache(newest, "newest")).toHaveLength(1);
  });

  it("subtracts replaced bytes before applying the limit", () => {
    const replaced = cacheFile("replaced", 8 * MIB, "old");
    writeWorkspaceFileCache({
      filePath: replaced,
      content: "replacement".padEnd(MIB, "x"),
      identity: "new",
    });
    const peer = cacheFile("peer", 8 * MIB);

    expect(readWorkspaceFileCache(replaced, "new")).toHaveLength(MIB);
    expect(readWorkspaceFileCache(peer, "peer")).toHaveLength(8 * MIB);
  });

  it("does not retain an entry larger than the total byte limit", () => {
    const retained = cacheFile("retained", 1, "old");
    writeWorkspaceFileCache({
      filePath: retained,
      content: "x".repeat(12 * MIB + 1),
      identity: "oversized",
    });

    expect(readWorkspaceFileCache(retained, "old")).toBe("x");
  });

  it("returns an unchanged cached entry", () => {
    const filePath = path.join(workspaceRoot, "unchanged");
    writeWorkspaceFileCache({ filePath, content: "unchanged", identity: "unchanged" });

    expect(readWorkspaceFileCache(filePath, "unchanged")).toBe("unchanged");
  });
});
