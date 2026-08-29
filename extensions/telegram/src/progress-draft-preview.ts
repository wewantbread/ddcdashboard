// Telegram progress-draft formatting and HTML preview rendering.
import type { ChannelProgressDraftCompositorLine } from "openclaw/plugin-sdk/channel-outbound";
import type { TelegramDraftPreview } from "./draft-stream.js";
import { renderTelegramHtmlText } from "./format.js";
import {
  boldRichText,
  codeRichText,
  italicRichText,
  paragraphBlock,
  type InputRichBlock,
  type RichText,
} from "./rich-block-model.js";
import { markdownToTelegramRichBlocks } from "./rich-blocks.js";
import { buildTelegramRichBlocksPlan } from "./rich-message.js";
import { clipTelegramProgressText, TELEGRAM_PROGRESS_MAX_CHARS } from "./truncate.js";

function sanitizeProgressMarkdownText(text: string): string {
  return text.replaceAll("`", "'");
}

function formatProgressAsMarkdownCode(text: string, maxLineChars: number): string {
  const clipped = clipTelegramProgressText(text, maxLineChars);
  return `\`${sanitizeProgressMarkdownText(clipped)}\``;
}

export function formatTelegramProgressLine(
  text: string,
  maxLineChars: number = TELEGRAM_PROGRESS_MAX_CHARS,
): string {
  const trimmed = text.trim();
  return trimmed.startsWith("_") && trimmed.endsWith("_")
    ? trimmed
    : formatProgressAsMarkdownCode(text, maxLineChars);
}

function escapeTelegramProgressHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function clipTelegramProgressDetail(detail: string, label: string, maxLineChars: number): string {
  // Mirror the shared compact renderer: the label prefix shares the line
  // budget, and the canonical compaction keeps the detail's useful prefix and
  // suffix around a middle ellipsis instead of blindly cutting the tail.
  const prefix = `${label}: `;
  const compacted = clipTelegramProgressText(`${prefix}${detail}`, maxLineChars);
  return compacted.startsWith(prefix)
    ? compacted.slice(prefix.length)
    : clipTelegramProgressText(detail, maxLineChars);
}

function renderTelegramProgressStringLine(text: string, maxLineChars: number): string {
  // Reasoning/commentary lanes carry model-authored markdown. Render through
  // renderTelegramHtmlText (parse_mode HTML-safe), not the full rich block
  // converter — block output from headings/lists can reject the edit.
  const trimmed = text.trim();
  const italic = trimmed.match(/^(\S+ )?_(.*)_$/u);
  const clipped = italic
    ? `${italic[1] ?? ""}_${clipTelegramProgressText(italic[2] ?? "", maxLineChars)}_`
    : clipTelegramProgressText(trimmed, maxLineChars);
  return renderTelegramHtmlText(clipped);
}

function renderTelegramProgressText(text: string, maxLineChars: number): string {
  return text
    .split(/\r?\n/u)
    .map((line) => renderTelegramProgressStringLine(line, maxLineChars))
    .filter(Boolean)
    .join("<br>");
}

function renderTelegramProgressLine(
  line: ChannelProgressDraftCompositorLine,
  maxLineChars: number,
): string {
  if (typeof line === "string") {
    return renderTelegramProgressText(line, maxLineChars);
  }
  if (!line.icon && (!line.label || line.label === "Commentary")) {
    return renderTelegramProgressText(line.text, maxLineChars);
  }
  const label = [line.icon, line.label].filter(Boolean).join(" ");
  const parts = [`<b>${escapeTelegramProgressHtml(label)}</b>`];
  const detail = line.detail && line.detail !== line.label ? line.detail : undefined;
  if (detail) {
    parts.push(
      `<code>${escapeTelegramProgressHtml(clipTelegramProgressDetail(detail, label, maxLineChars))}</code>`,
    );
  } else {
    const text = line.text.trim();
    if (text && text !== label) {
      parts.push(
        `<code>${escapeTelegramProgressHtml(clipTelegramProgressText(text, maxLineChars))}</code>`,
      );
    }
  }
  if (line.status && line.status !== "completed" && line.status !== line.detail) {
    parts.push(`<i>${escapeTelegramProgressHtml(line.status)}</i>`);
  }
  return parts.join(" ");
}

function joinRichText(parts: RichText[], separator: string): RichText {
  if (parts.length === 0) {
    return "";
  }
  if (parts.length === 1) {
    return parts[0] ?? "";
  }
  const result: RichText[] = [];
  for (const [index, part] of parts.entries()) {
    if (index > 0) {
      result.push(separator);
    }
    result.push(part);
  }
  return result;
}

function markdownLineToRichText(text: string, maxLineChars: number): RichText {
  const trimmed = text.trim();
  const italic = trimmed.match(/^(\S+ )?_(.*)_$/u);
  const clipped = italic
    ? `${italic[1] ?? ""}_${clipTelegramProgressText(italic[2] ?? "", maxLineChars)}_`
    : clipTelegramProgressText(trimmed, maxLineChars);
  const { blocks } = markdownToTelegramRichBlocks(clipped, { skipEntityDetection: true });
  const first = blocks[0];
  if (first?.type === "paragraph") {
    return first.text;
  }
  return clipped;
}

function progressTextToRichText(text: string, maxLineChars: number): RichText | undefined {
  const parts = text
    .split(/\r?\n/u)
    .map((line) => markdownLineToRichText(line, maxLineChars))
    .filter((part) => part !== "");
  return parts.length ? joinRichText(parts, "\n") : undefined;
}

function progressLineToRichText(
  line: ChannelProgressDraftCompositorLine,
  maxLineChars: number,
): RichText | undefined {
  if (typeof line === "string") {
    return progressTextToRichText(line, maxLineChars);
  }
  if (!line.icon && (!line.label || line.label === "Commentary")) {
    return progressTextToRichText(line.text, maxLineChars);
  }
  const label = [line.icon, line.label].filter(Boolean).join(" ");
  const parts: RichText[] = [boldRichText(label)];
  const detail = line.detail && line.detail !== line.label ? line.detail : undefined;
  if (detail) {
    parts.push(codeRichText(clipTelegramProgressDetail(detail, label, maxLineChars)));
  } else {
    const text = line.text.trim();
    if (text && text !== label) {
      parts.push(codeRichText(clipTelegramProgressText(text, maxLineChars)));
    }
  }
  if (line.status && line.status !== "completed" && line.status !== line.detail) {
    parts.push(italicRichText(line.status));
  }
  return joinRichText(parts, " ");
}

function buildProgressRichBlocks(parts: RichText[]): InputRichBlock[] {
  return [paragraphBlock(joinRichText(parts, "\n"))];
}

function isStatusHeadlineWorkLine(
  line: ChannelProgressDraftCompositorLine,
): line is Exclude<ChannelProgressDraftCompositorLine, string> {
  if (typeof line === "string") {
    return false;
  }
  return !line.id?.startsWith("reasoning:") && !line.id?.startsWith("commentary:");
}

export function renderTelegramProgressDraftPreview(
  text: string,
  lines: readonly ChannelProgressDraftCompositorLine[],
  richMessages: boolean,
  statusHeadlineActive = false,
  maxLineChars: number = TELEGRAM_PROGRESS_MAX_CHARS,
): TelegramDraftPreview {
  const trimmed = text.trimEnd();
  if (statusHeadlineActive) {
    const statusLines = trimmed
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean);
    const workLines = lines.filter(isStatusHeadlineWorkLine);
    const renderedLines = workLines
      .map((line) => renderTelegramProgressLine(line, maxLineChars))
      .filter(Boolean);
    if (!richMessages) {
      const renderedStatusLines =
        statusLines.length > 1
          ? [
              `<b>${escapeTelegramProgressHtml(statusLines[0] ?? "")}</b>`,
              ...statusLines
                .slice(1)
                .map((line) => renderTelegramProgressStringLine(line, maxLineChars)),
            ]
          : statusLines.map((line) => renderTelegramProgressStringLine(line, maxLineChars));
      return { text: [...renderedStatusLines, ...renderedLines].join("<br>"), parseMode: "HTML" };
    }
    const richStatusParts: RichText[] =
      statusLines.length > 1
        ? [
            boldRichText(statusLines[0] ?? ""),
            ...statusLines.slice(1).map((line) => markdownLineToRichText(line, maxLineChars)),
          ]
        : statusLines.map((line) => markdownLineToRichText(line, maxLineChars));
    const richLineParts = workLines
      .map((line) => progressLineToRichText(line, maxLineChars))
      .filter((part): part is RichText => part !== undefined);
    const plainLineTexts = workLines
      .map((line) => line.text)
      .map((line) => line.trim())
      .filter(Boolean);
    const plainText = [...statusLines, ...plainLineTexts].join("\n");
    return {
      text: plainText,
      richMessage: buildTelegramRichBlocksPlan(
        buildProgressRichBlocks([...richStatusParts, ...richLineParts]),
        {
          skipEntityDetection: true,
          plainText,
        },
      ).richMessage,
    };
  }
  const renderedLines = lines
    .map((line) => renderTelegramProgressLine(line, maxLineChars))
    .filter(Boolean);
  const textLines = trimmed
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  const heading = textLines.length > renderedLines.length ? textLines[0] : undefined;
  if (!richMessages) {
    const htmlParts = heading
      ? [`<b>${escapeTelegramProgressHtml(heading)}</b>`, ...renderedLines]
      : renderedLines;
    return { text: htmlParts.join("<br>"), parseMode: "HTML" };
  }
  const richLineParts = lines
    .map((line) => progressLineToRichText(line, maxLineChars))
    .filter((part): part is RichText => part !== undefined);
  const richParts = heading ? [boldRichText(heading), ...richLineParts] : richLineParts;
  return {
    text: trimmed,
    richMessage: buildTelegramRichBlocksPlan(buildProgressRichBlocks(richParts), {
      skipEntityDetection: true,
      plainText: trimmed,
    }).richMessage,
  };
}
