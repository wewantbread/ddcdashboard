/** Quality contract, fallback, and audit helpers for compaction safeguard summaries. */
import { localeLowercasePreservingWhitespace } from "@openclaw/normalization-core/string-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { extractKeywords, isQueryStopWordToken } from "../../memory-host-sdk/query.js";
import type { CompactionSummarizationInstructions } from "../compaction.js";
import { sanitizeForPromptLiteral, wrapUntrustedPromptDataBlock } from "../sanitize-for-prompt.js";

const MAX_ACTIVE_ASK_CHARS = 500;

/** Bound the active user ask to the size the summarizer actually sees.
 *
 * The untrusted-data wrapper caps the prompt fact at MAX_ACTIVE_ASK_CHARS. The
 * audit must derive its meaningful tokens from that same bounded representation,
 * otherwise a long ask whose meaningful terms fall after the cap could cancel
 * compaction even though the summarizer could never produce them (#123668).
 */
export function boundActiveAsk(ask: string): string {
  const sanitized = sanitizeForPromptLiteral(ask.replace(/[\r\n]+/g, " ")).trim();
  if (!sanitized) {
    return "";
  }
  return truncateUtf16Safe(sanitized, MAX_ACTIVE_ASK_CHARS);
}

// Compaction summary quality helpers. They define the structured summary contract
// and audit whether summaries preserve pending asks plus exact identifiers.
const MAX_EXTRACTED_IDENTIFIERS = 12;
const MAX_UNTRUSTED_INSTRUCTION_CHARS = 4000;
const MAX_ASK_OVERLAP_TOKENS = 12;
const MIN_ASK_OVERLAP_TOKENS_FOR_DOUBLE_MATCH = 3;
const REQUIRED_SUMMARY_SECTIONS = [
  "## Decisions",
  "## Open TODOs",
  "## Constraints/Rules",
  "## Pending user asks",
  "## Exact identifiers",
] as const;
const QUALITY_PROTECTED_SECTION_START = 3;
const PENDING_ASK_SECTION_INDEX = 3;
const EXACT_IDENTIFIERS_SECTION_INDEX = 4;
const MAX_PROTECTED_SECTION_CONTENT_SHARE = 0.25;
const STRICT_EXACT_IDENTIFIERS_INSTRUCTION =
  "For ## Exact identifiers, preserve literal values exactly as seen (IDs, URLs, file paths, ports, hashes, dates, times).";
const POLICY_OFF_EXACT_IDENTIFIERS_INSTRUCTION =
  "For ## Exact identifiers, include identifiers only when needed for continuity; do not enforce literal-preservation rules.";

/** Wraps operator-provided compaction instruction text as untrusted prompt data. */
export function wrapUntrustedInstructionBlock(label: string, text: string): string {
  return wrapUntrustedPromptDataBlock({
    label,
    text,
    maxChars: MAX_UNTRUSTED_INSTRUCTION_CHARS,
  });
}

/** Wrap the active user ask as bounded untrusted prompt data under a trusted
 * instruction.
 *
 * The active ask is user-derived text that must reach the summarizer so it
 * can foreground the latest request in ## Pending user asks (#123668). It
 * must not gain instruction authority: a malicious ask like "Ignore all
 * previous instructions" must be treated as data to summarize, not as a
 * command to execute. The canonical untrusted-data wrapper provides this
 * boundary — it sanitizes control characters, escapes tag delimiters, caps
 * length, and labels the content as data. A trusted outer instruction tells
 * the model to use the wrapped data in the pending-asks section.
 */
export function wrapActiveAskForInstruction(ask: string): string {
  const block = wrapUntrustedPromptDataBlock({
    label: "Active user request to foreground in ## Pending user asks",
    text: ask,
    maxChars: MAX_ACTIVE_ASK_CHARS,
  });
  if (!block) {
    return "";
  }
  return `Include the active user request provided as data below in the ## Pending user asks section.\n${block}`;
}

function resolveExactIdentifierSectionInstruction(
  summarizationInstructions?: CompactionSummarizationInstructions,
): string {
  const policy = summarizationInstructions?.identifierPolicy ?? "strict";
  if (policy === "off") {
    return POLICY_OFF_EXACT_IDENTIFIERS_INSTRUCTION;
  }
  const custom =
    policy === "custom" ? summarizationInstructions?.identifierInstructions?.trim() : undefined;
  if (custom) {
    // Operator text is runtime data, never prompt authority.
    return (
      wrapUntrustedInstructionBlock(
        "For ## Exact identifiers, apply this operator-defined policy text",
        custom,
      ) || STRICT_EXACT_IDENTIFIERS_INSTRUCTION
    );
  }
  return STRICT_EXACT_IDENTIFIERS_INSTRUCTION;
}

/** Build the required structured summary instructions for compaction. */
export function buildCompactionStructureInstructions(
  customInstructions?: string,
  summarizationInstructions?: CompactionSummarizationInstructions,
): string {
  const identifierSectionInstruction =
    resolveExactIdentifierSectionInstruction(summarizationInstructions);
  const sectionsTemplate = [
    "Produce a compact, factual summary with these exact section headings:",
    ...REQUIRED_SUMMARY_SECTIONS,
    identifierSectionInstruction,
    "Do not omit unresolved asks from the user.",
    "The ## Pending user asks section must foreground the latest non-superseded user request as the active work item; earlier completed or abandoned tasks are historical context only.",
    "When prior compaction summaries are present, re-distill them with new messages and remove stale duplicate detail.",
  ].join("\n");
  const custom = customInstructions?.trim();
  const customBlock =
    custom && wrapUntrustedInstructionBlock("Additional context from /compact", custom);
  return customBlock ? `${sectionsTemplate}\n\n${customBlock}` : sectionsTemplate;
}

function normalizedSummaryLines(summary: string): string[] {
  return summary
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function hasRequiredSummarySections(summary: string): boolean {
  const lines = normalizedSummaryLines(summary);
  let cursor = 0;
  for (const heading of REQUIRED_SUMMARY_SECTIONS) {
    const index = lines.findIndex((line, lineIndex) => lineIndex >= cursor && line === heading);
    if (index < 0) {
      return false;
    }
    cursor = index + 1;
  }
  return true;
}

type SummaryQualityRetentionPlan = {
  minimumChars: number;
  /**
   * True when render() must rebuild even a body that fits: a strict source
   * identifier is missing, or an audit-bearing section exceeds its share cap.
   */
  needsRebuild: (maxChars: number) => boolean;
  /** Null when even the protected facts cannot fit `maxChars`. */
  render: (maxChars: number) => { text: string; trimmed: boolean } | null;
};

function parseRequiredSummarySectionContents(summary: string): string[] | null {
  const contents = REQUIRED_SUMMARY_SECTIONS.map(() => new Array<string>());
  const preamble: string[] = [];
  let sectionIndex = -1;

  for (const line of summary.split(/\r?\n/u)) {
    const nextHeading = REQUIRED_SUMMARY_SECTIONS[sectionIndex + 1];
    if (nextHeading && line.trim() === nextHeading) {
      sectionIndex += 1;
      continue;
    }
    (sectionIndex < 0 ? preamble : contents[sectionIndex])?.push(line);
  }
  if (sectionIndex !== REQUIRED_SUMMARY_SECTIONS.length - 1) {
    return null;
  }
  contents[0]?.unshift(...preamble);
  return contents.map((lines) => lines.join("\n").trim());
}

/**
 * Plan truncation that keeps the audit facts and lets everything else shrink.
 * Only the headings, the bounded latest-ask context, and the audited source
 * identifiers are untrimmable. Model-written section text — including the
 * "## Exact identifiers" list — is optional content; protecting it verbatim let
 * a re-distilled identifier dump grow past the whole artifact budget while the
 * real sections were starved to empty headings.
 */
export function createSummaryQualityRetentionPlan(
  summary: string,
  truncatedMarker: string,
  params: {
    auditSummary?: string;
    identifiers: string[];
    latestAsk: string | null;
    requiredAskContext?: string;
    identifierPolicy?: CompactionSummarizationInstructions["identifierPolicy"];
  },
): SummaryQualityRetentionPlan | null {
  const contents = parseRequiredSummarySectionContents(summary);
  if (!contents) {
    return null;
  }
  const enforceIdentifiers = (params.identifierPolicy ?? "strict") === "strict";
  const auditSummary = params.auditSummary ?? summary;
  if (!hasAskOverlap(auditSummary, params.latestAsk)) {
    return null;
  }
  const requiredAskContext = params.requiredAskContext?.trim() ?? "";
  const auditedIdentifiers = enforceIdentifiers ? params.identifiers : [];
  const marker = truncatedMarker.trim();
  // The bounded active ask must be the canonical leading entry in ## Pending
  // user asks — the first content line the resumed agent reads. When the
  // model output defers it to a later line, the retention plan rebuilds and
  // prepends it so a stale task can no longer foreground superseded work
  // (#123668).
  const askIsLeading =
    !requiredAskContext || hasAskOverlap(extractLeadingPendingAskLine(summary), requiredAskContext);
  // Protected tails render after each section's optional content (identifiers)
  // or before it (pending asks) so the audit facts survive regardless of how
  // much model text the budget keeps.
  const protectedTails = REQUIRED_SUMMARY_SECTIONS.map((_, index) =>
    index === PENDING_ASK_SECTION_INDEX
      ? requiredAskContext
      : index === EXACT_IDENTIFIERS_SECTION_INDEX
        ? auditedIdentifiers.join("\n")
        : "",
  );
  const bodyHasIdentifiers = auditedIdentifiers.every((identifier) =>
    summaryIncludesIdentifier(summary, identifier),
  );
  const renderSections = (sectionContents: string[]) =>
    REQUIRED_SUMMARY_SECTIONS.map((heading, index) => {
      const content = sectionContents[index];
      return content ? `${heading}\n${content}` : heading;
    });
  const joinSectionContent = (index: number, optional: string) => {
    const tail = protectedTails[index] ?? "";
    if (!tail) {
      return optional;
    }
    if (index === PENDING_ASK_SECTION_INDEX) {
      // Canonical leading position: the bounded active ask is the first
      // content line so the resumed agent sees it before any stale work.
      // If the existing first line already overlaps the ask, the leading
      // position is satisfied; otherwise prepend the ask before the
      // model's content (#123668).
      const firstLine = normalizedSummaryLines(optional)[0] ?? "";
      if (hasAskOverlap(firstLine, tail)) {
        return optional;
      }
      return [tail, optional].filter(Boolean).join("\n");
    }
    if (index === EXACT_IDENTIFIERS_SECTION_INDEX) {
      const missing = auditedIdentifiers.filter(
        (identifier) => !summaryIncludesIdentifier(optional, identifier),
      );
      return [optional, ...missing].filter(Boolean).join("\n");
    }
    return [optional, tail].filter(Boolean).join("\n");
  };
  // Reserve every heading/content/tail separator up front so trimmed optional
  // text can never push the rendered artifact past `maxChars`.
  const minimumBlocks = REQUIRED_SUMMARY_SECTIONS.map(
    (heading, index) => `${heading}\n\n${protectedTails[index] ?? ""}`,
  );
  const minimumSummary = [
    ...minimumBlocks.slice(0, QUALITY_PROTECTED_SECTION_START),
    marker,
    ...minimumBlocks.slice(QUALITY_PROTECTED_SECTION_START),
  ].join("\n\n");
  // Audit-bearing sections (pending asks, exact identifiers) are funded first so
  // a runaway earlier section cannot starve them, but each is hard-capped: an
  // uncapped identifier list re-distills into the whole budget — even while the
  // artifact still fits — and leaves every other section as a bare heading.
  const protectedCapFor = (maxChars: number) =>
    Math.floor(Math.max(0, maxChars - minimumSummary.length) * MAX_PROTECTED_SECTION_CONTENT_SHARE);
  const protectedWithinCap = (maxChars: number) =>
    contents
      .slice(QUALITY_PROTECTED_SECTION_START)
      .every((content) => content.length <= protectedCapFor(maxChars));

  return {
    minimumChars: minimumSummary.length,
    needsRebuild: (maxChars) =>
      !bodyHasIdentifiers || !protectedWithinCap(maxChars) || !askIsLeading,
    render(maxChars) {
      const bodyHasRequiredAskContext = !requiredAskContext || summary.includes(requiredAskContext);
      if (
        summary.length <= maxChars &&
        bodyHasRequiredAskContext &&
        bodyHasIdentifiers &&
        protectedWithinCap(maxChars) &&
        askIsLeading
      ) {
        return { text: summary, trimmed: false };
      }
      if (maxChars < minimumSummary.length) {
        return null;
      }
      const contentBudget = maxChars - minimumSummary.length;
      const protectedCap = protectedCapFor(maxChars);
      const allocations = contents.map((content, index) =>
        index >= QUALITY_PROTECTED_SECTION_START ? Math.min(content.length, protectedCap) : 0,
      );
      const optionalBudget = Math.max(
        0,
        contentBudget - allocations.reduce((total, chars) => total + chars, 0),
      );
      const optionalContents = contents.slice(0, QUALITY_PROTECTED_SECTION_START);
      const optionalTotal = optionalContents.reduce((total, content) => total + content.length, 0);
      for (const [index, content] of optionalContents.entries()) {
        allocations[index] =
          optionalTotal > 0 ? Math.floor((optionalBudget * content.length) / optionalTotal) : 0;
      }
      // Surplus returns to the optional sections only; the protected caps stay
      // hard so short decisions cannot hand the budget back to the identifier dump.
      let remainder =
        optionalBudget -
        allocations
          .slice(0, QUALITY_PROTECTED_SECTION_START)
          .reduce((total, chars) => total + chars, 0);
      for (const [index, content] of optionalContents.entries()) {
        const allocation = allocations[index] ?? 0;
        const extra = Math.min(remainder, Math.max(0, content.length - allocation));
        allocations[index] = allocation + extra;
        remainder -= extra;
      }
      const trimmed = contents.some((content, index) => content.length > (allocations[index] ?? 0));
      const sectionContents = contents.map((content, index) =>
        joinSectionContent(index, truncateUtf16Safe(content, allocations[index] ?? 0)),
      );
      const blocks = renderSections(sectionContents);
      return {
        text: [
          ...blocks.slice(0, QUALITY_PROTECTED_SECTION_START),
          ...(trimmed ? [marker] : []),
          ...blocks.slice(QUALITY_PROTECTED_SECTION_START),
        ].join("\n\n"),
        trimmed,
      };
    },
  };
}

/** Return a structured fallback summary when model output is missing/invalid. */
export function buildStructuredFallbackSummary(
  previousSummary: string | undefined,
  activeAsk?: string,
): string {
  const trimmedPreviousSummary = previousSummary?.trim() ?? "";
  if (trimmedPreviousSummary && hasRequiredSummarySections(trimmedPreviousSummary)) {
    // Reused a prior structured summary. If an active ask is present, ensure
    // it is the canonical leading entry in ## Pending user asks so the quality
    // audit (which requires the latest ask as the first content line) can pass
    // even when there are no summarizable messages to regenerate (#123668).
    if (activeAsk) {
      return ensureActiveAskInStructuredSummary(trimmedPreviousSummary, activeAsk);
    }
    return trimmedPreviousSummary;
  }
  const boundedAsk = activeAsk?.trim();
  const pendingValue = boundedAsk || "None.";
  const values = [
    trimmedPreviousSummary || "No prior history.",
    "None.",
    "None.",
    pendingValue,
    "None captured.",
  ];
  return REQUIRED_SUMMARY_SECTIONS.map((heading, index) => `${heading}\n${values[index]}`).join(
    "\n\n",
  );
}

const PENDING_ASKS_HEADING = "## Pending user asks";

// Find the line range of the last occurrence of a section heading. Split-turn
// compaction appends a second structured prefix summary after the history
// summary, so duplicate headings are a supported output shape. The trailing
// section is the active work item — earlier history sections may mention the
// latest request as historical context, but only the trailing section
// identifies the current task the resumed agent will follow. Both the quality
// audit and the fallback rewriter use this locator so they agree on which
// section is authoritative (#123668).
function findLastSectionRange(
  lines: string[],
  heading: string,
): { start: number; end: number } | null {
  let startIndex = -1;
  for (let i = 0; i < lines.length; i += 1) {
    // Trim before comparing so an indented heading (e.g. "  ## Pending user
    // asks") is found consistently with the audit's normalizedSummaryLines
    // trim. Without this, the rewriter misses a heading the audit accepts,
    // leaving a stale trailing pending item in the persisted checkpoint
    // (#123668).
    if (lines[i]?.trim() === heading) {
      startIndex = i;
    }
  }
  if (startIndex < 0) {
    return null;
  }
  let endIndex = lines.length;
  for (let i = startIndex + 1; i < lines.length; i += 1) {
    const line = lines[i]?.trim();
    if (line !== undefined && line.startsWith("## ")) {
      endIndex = i;
      break;
    }
  }
  return { start: startIndex, end: endIndex };
}

/** Ensures the active ask is the canonical leading entry in ## Pending user asks.
 *
 * The quality audit requires the latest ask to be the first content line in
 * the trailing ## Pending user asks section. When a reused prior summary
 * defers the active ask to a later line (or omits it entirely), the audit
 * would reject it and the fallback cannot regenerate (no summarizable
 * messages). Prepend the active ask as the first content line so a stale
 * task can no longer foreground superseded work (#123668).
 */
export function ensureActiveAskInStructuredSummary(summary: string, activeAsk: string): string {
  // Use the same CRLF-tolerant split as normalizedSummaryLines so a reused
  // prior checkpoint with CRLF line endings is parsed consistently with the
  // structural check and audit (#123668).
  const lines = summary.split(/\r?\n/u);
  const range = findLastSectionRange(lines, PENDING_ASKS_HEADING);
  if (!range) {
    return summary;
  }
  // If the first content line already overlaps the active ask, the canonical
  // leading position is satisfied — no rewrite needed.
  const leadingLine = lines
    .slice(range.start + 1, range.end)
    .find((line) => line.trim().length > 0);
  if (leadingLine !== undefined && hasAskOverlap(leadingLine, activeAsk)) {
    return summary;
  }
  // Prepend the active ask as the first content line, right after the heading.
  const beforeContent = lines.slice(0, range.start + 1);
  const afterHeading = lines.slice(range.start + 1);
  return [...beforeContent, activeAsk, ...afterHeading].join("\n");
}

/** Appends a bounded post-compaction section to an existing summary. */
export function appendSummarySection(summary: string, section: string): string {
  if (!section) {
    return summary;
  }
  if (!summary.trim()) {
    return section.trimStart();
  }
  return `${summary}${section}`;
}

function sanitizeExtractedIdentifier(value: string): string {
  return value
    .trim()
    .replace(/^[("'`[{<]+/, "")
    .replace(/[)\]"'`,;:.!?<>]+$/, "");
}

function isPureHexIdentifier(value: string): boolean {
  return /^[A-Fa-f0-9]{8,}$/.test(value);
}

function normalizeOpaqueIdentifier(value: string): string {
  return isPureHexIdentifier(value) ? value.toUpperCase() : value;
}

function summaryIncludesIdentifier(summary: string, identifier: string): boolean {
  if (isPureHexIdentifier(identifier)) {
    return summary.toUpperCase().includes(identifier.toUpperCase());
  }
  return summary.includes(identifier);
}

/** Extracts likely exact identifiers that summaries should preserve literally. */
export function extractOpaqueIdentifiers(text: string): string[] {
  // Decimal/scientific syntax is unambiguous numeric data, including unit suffixes. Integer tokens
  // with letters remain opaque because the suffix may be part of an exact identifier.
  return uniqueStrings(
    Array.from(
      text.matchAll(
        /(https?:\/\/\S+|(?<![A-Za-z0-9._-])\/[\w.-]{2,}(?:\/[\w.-]+)+|[A-Za-z]:\\[\w\\.-]+|(?<![A-Za-z0-9._-])[A-Za-z0-9._-]+\.[A-Za-z0-9._/-]+:\d{1,5})|(?:(?:(?:\d+\.\d+|\.\d+)(?:[eE][+-]?\d+)?|\d+\.[eE][+-]?\d+|\d+\.?[eE][+-]\d+|(?![A-Fa-f0-9]{8,}(?![A-Fa-f0-9]))\d+\.?[eE]\d+)(?:(?=[A-Za-z]+(?![A-Za-z0-9]))(?=[A-Za-z]*[G-Zg-z])[A-Za-z]+)?(?![A-Za-z0-9])|(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]*(?:[A-Fa-f0-9]{8,}|\d{6,}))([A-Za-z0-9_-]+))/g,
      ),
      (match) => match[1] ?? match[2] ?? "",
    )
      .map((value) => normalizeOpaqueIdentifier(sanitizeExtractedIdentifier(value)))
      .filter((value) => value.length >= 4),
  ).slice(0, MAX_EXTRACTED_IDENTIFIERS);
}

function tokenizeAskOverlapText(text: string): string[] {
  const normalized = localeLowercasePreservingWhitespace(text.normalize("NFKC")).trim();
  if (!normalized) {
    return [];
  }
  const keywords = extractKeywords(normalized);
  if (keywords.length > 0) {
    return keywords;
  }
  return normalized
    .split(/[^\p{L}\p{N}]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

function resolveAskOverlapRequirement(latestAsk: string | null): {
  tokens: string[];
  requiredMatches: number;
} | null {
  if (!latestAsk) {
    return null;
  }
  const askTokens = uniqueStrings(tokenizeAskOverlapText(latestAsk)).slice(
    0,
    MAX_ASK_OVERLAP_TOKENS,
  );
  if (askTokens.length === 0) {
    return null;
  }
  const meaningfulAskTokens = askTokens.filter(
    (token) => token.length > 1 && !isQueryStopWordToken(token),
  );
  const tokensToCheck = meaningfulAskTokens.length > 0 ? meaningfulAskTokens : askTokens;
  const requiredMatches = tokensToCheck.length >= MIN_ASK_OVERLAP_TOKENS_FOR_DOUBLE_MATCH ? 2 : 1;
  return { tokens: tokensToCheck, requiredMatches };
}

function hasAskOverlap(summary: string, latestAsk: string | null): boolean {
  const requirement = resolveAskOverlapRequirement(latestAsk);
  if (!requirement) {
    return true;
  }
  const summaryTokens = new Set(tokenizeAskOverlapText(summary));
  const overlapCount = requirement.tokens.filter((token) => summaryTokens.has(token)).length;
  const { requiredMatches } = requirement;
  return overlapCount >= requiredMatches;
}

// Extract the body lines under the last occurrence of a section heading from
// a summary. Returns empty when the heading is absent (the missing_section
// check already flags required sections).
function extractLastSectionContent(summary: string, heading: string): string {
  const lines = normalizedSummaryLines(summary);
  const range = findLastSectionRange(lines, heading);
  if (!range) {
    return "";
  }
  return lines.slice(range.start + 1, range.end).join("\n");
}

// Extract the first non-empty content line under the trailing ## Pending user
// asks section. The canonical leading entry is the line the resumed agent
// reads first — if it names a stale task, the latest request is backgrounded
// even though it appears later in the same section (#123668).
function extractLeadingPendingAskLine(summary: string): string {
  const lines = normalizedSummaryLines(summary);
  const range = findLastSectionRange(lines, PENDING_ASKS_HEADING);
  if (!range) {
    return "";
  }
  return lines[range.start + 1] ?? "";
}

/** Audits a candidate summary for required sections, pending asks, and identifier preservation. */
export function auditSummaryQuality(params: {
  summary: string;
  structuralSummary: string;
  identifiers: string[];
  latestAsk: string | null;
  identifierPolicy?: CompactionSummarizationInstructions["identifierPolicy"];
}): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const lines = new Set(normalizedSummaryLines(params.structuralSummary));
  for (const section of REQUIRED_SUMMARY_SECTIONS) {
    if (!lines.has(section)) {
      reasons.push(`missing_section:${section}`);
    }
  }
  const enforceIdentifiers = (params.identifierPolicy ?? "strict") === "strict";
  if (enforceIdentifiers) {
    const missingIdentifiers = params.identifiers.filter(
      (identifier) => !summaryIncludesIdentifier(params.summary, identifier),
    );
    if (missingIdentifiers.length > 0) {
      reasons.push(`missing_identifiers:${missingIdentifiers.slice(0, 3).join(",")}`);
    }
  }
  // The latest non-superseded user request must appear in the trailing
  // ## Pending user asks section. extractLastSectionContent selects the last
  // occurrence of the heading, so split-turn summaries with duplicate headings
  // validate the trailing (active) section. A split-turn section whose own
  // pending-asks heading was truncated by the formatter cap falls back to the
  // last surviving heading; the audit does not reject it, because rejecting a
  // structurally valid summary whose only defect is a truncated suffix would
  // cancel compaction on a path that cannot regenerate (#123668).
  const pendingAsksContent = extractLastSectionContent(
    params.structuralSummary,
    PENDING_ASKS_HEADING,
  );
  if (!hasAskOverlap(pendingAsksContent, params.latestAsk)) {
    reasons.push("latest_user_ask_not_in_pending_asks");
  }
  // The latest ask must be the canonical leading entry — the first content
  // line the resumed agent reads. A stale task on the first line with the
  // latest ask deferred to a later line still foregrounds the superseded
  // task, which is the defect this guard prevents (#123668).
  if (params.latestAsk) {
    const leadingLine = extractLeadingPendingAskLine(params.structuralSummary);
    if (!hasAskOverlap(leadingLine, params.latestAsk)) {
      reasons.push("latest_user_ask_not_leading_in_pending_asks");
    }
  }
  return { ok: reasons.length === 0, reasons };
}
