// Telegram renders progress lines from their structured fields, so a line that
// arrives without detail falls back to text that already carries its icon.
import { buildChannelProgressDraftLine } from "openclaw/plugin-sdk/channel-outbound";
import { describe, expect, it } from "vitest";
import { renderTelegramProgressDraftPreview } from "./progress-draft-preview.js";

function renderToolLine(name: string) {
  const line = buildChannelProgressDraftLine(
    {
      event: "tool",
      toolCallId: "call-1",
      name,
      phase: "start",
      args: { command: "echo alpha", description: "print text" },
    },
    { commandText: "raw" },
  );
  if (!line) {
    throw new Error(`expected a progress line for ${name}`);
  }
  return renderTelegramProgressDraftPreview("Working", [line], false, true).text;
}

describe("renderTelegramProgressDraftPreview", () => {
  it("prints one tool icon per line for every backend spelling", () => {
    for (const name of ["Bash", "bash", "exec"]) {
      const rendered = renderToolLine(name);
      expect(rendered.match(/🛠️/gu) ?? []).toHaveLength(1);
    }
  });

  it("keeps the label and detail separate for a non-shell tool", () => {
    const line = buildChannelProgressDraftLine({
      event: "tool",
      toolCallId: "call-1",
      name: "Read",
      phase: "start",
      args: { file_path: "/tmp/x.ts" },
    });
    if (!line) {
      throw new Error("expected a progress line for Read");
    }

    const rendered = renderTelegramProgressDraftPreview("Working", [line], false, true).text;

    expect(rendered).toContain("<b>📖 Read</b>");
    expect(rendered.match(/📖/gu) ?? []).toHaveLength(1);
  });

  it("honors a configured budget and cuts prose on word boundaries", () => {
    const line = {
      kind: "item" as const,
      label: "Commentary",
      text: "alpha beta gamma delta epsilon zeta eta theta iota kappa",
      prefix: false,
    };

    const rendered = renderTelegramProgressDraftPreview("Working", [line], false, true, 24).text;

    expect(rendered).toContain("alpha beta gamma…");
    expect(rendered).not.toContain("epsilon");
  });

  it("keeps command detail prefixes and useful path suffixes", () => {
    const path = `path/to/${"nested/".repeat(20)}file.ts`;
    const line = buildChannelProgressDraftLine(
      {
        event: "tool",
        toolCallId: "call-1",
        name: "Bash",
        phase: "start",
        args: { command: `cat ${path}` },
      },
      { commandText: "raw" },
    );
    if (!line) {
      throw new Error("expected a progress line for Bash");
    }

    const rendered = renderTelegramProgressDraftPreview("Working", [line], false, true, 60).text;

    expect(rendered).toContain("<b>🛠️ Bash</b>");
    // The tail of the path carries the information; keep it visible.
    expect(rendered).toMatch(/…[^<]*file\.ts<\/code>/u);
  });

  it("keeps the historical 300 budget when no budget is passed", () => {
    const line = {
      kind: "item" as const,
      label: "Commentary",
      text: `${"x ".repeat(150)}tail`,
      prefix: false,
    };

    const rendered = renderTelegramProgressDraftPreview("Working", [line], false, true).text;

    expect(rendered).toContain("…");
    expect(rendered).not.toContain("tail");
  });
});
