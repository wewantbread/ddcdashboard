/**
 * Byte-limit helpers for session tool stderr/stdout tails.
 *
 * Tail storage is byte-bounded but decoded as UTF-8, so truncation avoids
 * splitting multi-byte characters in display output.
 */
import { Buffer } from "node:buffer";
import { resolveIntegerOption } from "@openclaw/normalization-core/number-coercion";
import { truncateUtf8Suffix } from "../../../utils/utf8-truncate.js";

/** Normalizes optional positive numeric limits to a finite integer. */
export function normalizePositiveLimit(value: number | undefined, fallback: number): number {
  return resolveIntegerOption(value, fallback, { min: 1 });
}

/** Default stderr tail retained for long-running session tools. */
export const SESSION_TOOL_STDERR_TAIL_BYTES = 64 * 1024;

/** Prefixes a retained stderr tail with its exact UTF-8 loss accounting. */
export function formatRetainedStderr(tail: string, droppedBytes: number): string {
  const trimmed = tail.trim();
  return droppedBytes > 0
    ? `[${droppedBytes} UTF-8 bytes of earlier stderr discarded at the ${SESSION_TOOL_STDERR_TAIL_BYTES}-byte retention cap]\n${trimmed}`
    : trimmed;
}

/** Retains a UTF-8-safe tail and counts bytes discarded by this append. */
export function appendBoundedTextTail(
  current: string,
  chunk: string,
  maxBytes = SESSION_TOOL_STDERR_TAIL_BYTES,
): { tail: string; droppedBytes: number } {
  const effectiveMaxBytes = normalizePositiveLimit(maxBytes, SESSION_TOOL_STDERR_TAIL_BYTES);
  const combined = `${current}${chunk}`;
  const tail = truncateUtf8Suffix(combined, effectiveMaxBytes);
  return { tail, droppedBytes: Buffer.byteLength(combined) - Buffer.byteLength(tail) };
}
