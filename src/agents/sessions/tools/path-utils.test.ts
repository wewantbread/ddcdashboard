import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveReadPath } from "./path-utils.js";
import { normalizeWindowsPosixDrivePath } from "./windows-posix-path.js";

describe("resolveReadPath", () => {
  const cwd = path.resolve("workspace");

  it("resolves ordinary relative paths against cwd", () => {
    expect(resolveReadPath("notes/today.md", cwd)).toBe(path.resolve(cwd, "notes/today.md"));
  });

  it("resolves valid file URLs to their filesystem path", () => {
    const target = path.resolve(cwd, "notes.txt");
    expect(resolveReadPath(pathToFileURL(target).href, cwd)).toBe(target);
  });

  it("keeps malformed file URLs on the ordinary relative-path path", () => {
    const malformed = "file://%";
    expect(resolveReadPath(malformed, cwd)).toBe(path.resolve(cwd, malformed));
  });

  it.runIf(process.platform === "win32")(
    "expands a Windows-style home prefix against the OS home",
    () => {
      const homeDir = process.env.HOME ?? os.homedir();
      expect(resolveReadPath("~\\notes.txt", cwd)).toBe(path.resolve(homeDir, "notes.txt"));
    },
  );

  it.runIf(process.platform !== "win32")(
    "keeps a backslash-prefixed tilde literal on POSIX",
    () => {
      expect(resolveReadPath("~\\notes.txt", cwd)).toBe(path.resolve(cwd, "~\\notes.txt"));
    },
  );
});

describe("normalizeWindowsPosixDrivePath", () => {
  it.each([
    ["/c/Users/Test/file.txt", "C:\\Users\\Test\\file.txt"],
    ["/cygdrive/d/work/file.txt", "D:\\work\\file.txt"],
    ["/mnt/e/work/file.txt", "E:\\work\\file.txt"],
    ["/f", "F:\\"],
  ])("maps %s to %s on native Windows", (input, expected) => {
    expect(normalizeWindowsPosixDrivePath(input, "win32")).toBe(expected);
  });

  it.each(["/home/user/file.txt", "/tmp/file.txt", "/mnt/home/file.txt", "//server/share"])(
    "leaves non-drive path %s unchanged",
    (input) => {
      expect(normalizeWindowsPosixDrivePath(input, "win32")).toBe(input);
    },
  );

  it("leaves POSIX drive-like paths unchanged outside Windows", () => {
    expect(normalizeWindowsPosixDrivePath("/c/work/file.txt", "linux")).toBe("/c/work/file.txt");
  });
});
