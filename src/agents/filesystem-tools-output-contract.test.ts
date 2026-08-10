import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Value } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createOpenClawReadTool, wrapReadToolWithSkillContent } from "./agent-tools.read.js";
import type { AnyAgentTool } from "./agent-tools.types.js";
import { createApplyPatchTool } from "./apply-patch.js";
import { createEditTool, createReadTool, createWriteTool } from "./sessions/index.js";
import { DEFAULT_MAX_BYTES } from "./sessions/tools/truncate.js";
import { compactToolOutputHint } from "./tool-schema-hints.js";

const ONE_PIXEL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

function expectContract(tool: AnyAgentTool, details: unknown): void {
  expect(tool.outputSchema).toBeDefined();
  expect(Value.Check(tool.outputSchema!, details)).toBe(true);
}

describe("filesystem tool output contracts", () => {
  let tmpDir = "";

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-filesystem-contract-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("validates read text, image, truncation, and optional-not-found results", async () => {
    await fs.writeFile(path.join(tmpDir, "notes.txt"), "ordinary text\n", "utf8");
    await fs.writeFile(path.join(tmpDir, "pixel.png"), Buffer.from(ONE_PIXEL_PNG_BASE64, "base64"));
    await fs.writeFile(path.join(tmpDir, "long.txt"), "x".repeat(DEFAULT_MAX_BYTES + 1), "utf8");

    const tool = createOpenClawReadTool(
      createReadTool(tmpDir, { autoResizeImages: false }) as unknown as AnyAgentTool,
    );
    const text = await tool.execute("read-text", { path: "notes.txt", limit: 10 });
    const image = await tool.execute("read-image", { path: "pixel.png", limit: 10 });
    const truncated = await tool.execute("read-truncated", { path: "long.txt", limit: 10 });
    const notFound = await tool.execute("read-not-found", { path: "memory/2026-07-17.md" });

    for (const result of [text, image, truncated, notFound]) {
      expectContract(tool, result.details);
    }
    expect(text.details).toEqual({ kind: "text", content: "ordinary text\n" });
    expect(image.details).toMatchObject({ kind: "image", mimeType: "image/png" });
    expect(truncated.details).toMatchObject({ kind: "truncated" });
    expect(notFound.details).toEqual({
      kind: "not_found",
      status: "not_found",
      path: "memory/2026-07-17.md",
      optional: true,
    });
    expect(compactToolOutputHint(tool.outputSchema)).toBe(
      '{ content: string; kind: "text" } | { content: string; kind: "image"; mimeType: string } | { content: string; kind: "truncated"; truncation: { firstLineExceedsLimit: boolean; lastLinePartial: boolean; maxBytes: number; maxLines: number; outputBytes: number; outputLines: number; totalBytes: number; totalLines: number; truncated: true; truncatedBy: "lines" | "bytes" } } | { kind: "not_found"; optional: true; path: string; status: "not_found" }',
    );
  });

  it.each([
    {
      label: "multiple ASCII pages",
      lines: Array.from({ length: 5000 }, (_, index) => String(index + 1)),
      trailingNewline: false,
    },
    {
      label: "multiple CJK pages",
      lines: Array.from({ length: 3001 }, (_, index) => `漢${index + 1}`),
      trailingNewline: false,
    },
    {
      label: "empty boundary lines and a trailing newline",
      lines: Array.from({ length: 2505 }, (_, index) =>
        index === 1999 || index === 2000 ? "" : `line-${index + 1}`,
      ),
      trailingNewline: true,
    },
  ])("returns the original file bytes across $label", async ({ lines, trailingNewline }) => {
    const source = `${lines.join("\n")}${trailingNewline ? "\n" : ""}`;
    await fs.writeFile(path.join(tmpDir, "multi-page.txt"), source, "utf8");
    const tool = createOpenClawReadTool(createReadTool(tmpDir) as unknown as AnyAgentTool);

    const result = await tool.execute("read-multi-page", { path: "multi-page.txt" });

    expect(result.content).toEqual([{ type: "text", text: source }]);
    expect(result.details).toEqual({ kind: "text", content: source });
    expectContract(tool, result.details);
  });

  it("returns complete virtual skill content without inserting page separators", async () => {
    const locator = "node://node-1/skills/pond/SKILL.md";
    const source = Array.from({ length: 2501 }, (_, index) => String(index + 1)).join("\n");
    const base = createOpenClawReadTool(createReadTool(tmpDir) as unknown as AnyAgentTool);
    const tool = wrapReadToolWithSkillContent(base, [{ filePath: locator, readContent: source }]);

    const result = await tool.execute("read-whole-skill", { path: locator });

    expect(result.content).toEqual([{ type: "text", text: source }]);
    expect(result.details).toEqual({ kind: "text", content: source });
    expectContract(tool, result.details);
  });

  it("preserves explicit limits, offsets, and their continuation notices", async () => {
    const lines = Array.from({ length: 5000 }, (_, index) => String(index + 1));
    await fs.writeFile(path.join(tmpDir, "offset.txt"), lines.join("\n"), "utf8");
    const tool = createOpenClawReadTool(createReadTool(tmpDir) as unknown as AnyAgentTool);

    const limited = await tool.execute("read-limited", { path: "offset.txt", limit: 5 });
    const expectedLimited = `${lines.slice(0, 5).join("\n")}\n\n[4995 more lines in file. Use offset=6 to continue.]`;
    expect(limited.content).toEqual([{ type: "text", text: expectedLimited }]);
    expect(limited.details).toEqual({ kind: "text", content: expectedLimited });

    const offset = await tool.execute("read-offset", { path: "offset.txt", offset: 1990 });
    const expectedOffset = lines.slice(1989).join("\n");
    expect(offset.content).toEqual([{ type: "text", text: expectedOffset }]);
    expect(offset.details).toEqual({ kind: "text", content: expectedOffset });
  });

  it("preserves adaptive continuation offsets and their separate notice", async () => {
    const lines = Array.from(
      { length: 8000 },
      (_, index) => `line-${String(index + 1).padStart(4, "0")}-abcdefghijklmnopqrstuvwxyz`,
    );
    await fs.writeFile(path.join(tmpDir, "capped.txt"), lines.join("\n"), "utf8");
    const tool = createOpenClawReadTool(createReadTool(tmpDir) as unknown as AnyAgentTool);

    const result = await tool.execute("read-capped", { path: "capped.txt" });
    const output = result.content.find((block) => block.type === "text")?.text;

    expect(output).toBeDefined();
    expect(output).toMatch(
      /\n\n\[Read output capped at 32KB for this call\. Use offset=1384 to continue\.\]$/,
    );
    expect(result.details).toMatchObject({ kind: "truncated", content: output });
    expectContract(tool, result.details);
  });

  it("validates edit changed and no-op results", async () => {
    const filePath = path.join(tmpDir, "edit.txt");
    await fs.writeFile(filePath, "before\n", "utf8");
    const tool = createEditTool(tmpDir) as unknown as AnyAgentTool;
    const changed = await tool.execute("edit-changed", {
      path: filePath,
      edits: [{ oldText: "before", newText: "after" }],
    });
    const noOp = await tool.execute("edit-no-op", {
      path: filePath,
      edits: [{ oldText: "after", newText: "after" }],
    });

    expectContract(tool, changed.details);
    expectContract(tool, noOp.details);
    expect(changed.details).toMatchObject({ changed: true });
    expect(noOp.details).toEqual({ changed: false });
    expect(compactToolOutputHint(tool.outputSchema)).toBe(
      "{ changed: false } | { changed: true; diff: string; patch: string; firstChangedLine?: number }",
    );
  });

  it("validates write created, overwrite, unknown-state, and no-op results", async () => {
    const tool = createWriteTool(tmpDir) as unknown as AnyAgentTool;
    const created = await tool.execute("write-created", { path: "write.txt", content: "one\n" });
    const overwritten = await tool.execute("write-overwrite", {
      path: "write.txt",
      content: "two\n",
    });
    const noOp = await tool.execute("write-no-op", { path: "write.txt", content: "two\n" });
    await fs.writeFile(path.join(tmpDir, "large.txt"), "x".repeat(1024 * 1024 + 1), "utf8");
    const unknownOverwrite = await tool.execute("write-unknown-overwrite", {
      path: "large.txt",
      content: "replacement\n",
    });
    const boundedCreate = await tool.execute("write-bounded-create", {
      path: "large-created.txt",
      content: "x".repeat(1024 * 1024 + 1),
    });

    for (const result of [created, overwritten, unknownOverwrite, boundedCreate, noOp]) {
      expectContract(tool, result.details);
    }
    expectContract(tool, { changed: true });
    expect(created.details).toMatchObject({ changed: true, created: true });
    expect(overwritten.details).toMatchObject({ changed: true, created: false });
    expect(unknownOverwrite.details).toEqual({ changed: true, created: false });
    expect(boundedCreate.details).toEqual({ changed: true, created: true });
    expect(noOp.details).toEqual({ changed: false });
    expect(compactToolOutputHint(tool.outputSchema)).toBe(
      "{ changed: false } | { changed: true; created: true; diff: string; patch: string; firstChangedLine?: number } | { changed: true; created: false; diff: string; patch: string; firstChangedLine?: number } | { changed: true; created?: boolean }",
    );
  });

  it("validates apply_patch path summaries", async () => {
    const tool = createApplyPatchTool({ cwd: tmpDir }) as unknown as AnyAgentTool;
    const result = await tool.execute("patch-add", {
      input: "*** Begin Patch\n*** Add File: added.txt\n+added\n*** End Patch",
    });

    expectContract(tool, result.details);
    expect(result.details).toEqual({
      summary: { added: ["added.txt"], modified: [], deleted: [] },
    });
    expect(compactToolOutputHint(tool.outputSchema)).toBe(
      "{ summary: { added: Array<string>; deleted: Array<string>; modified: Array<string> } }",
    );
  });
});
