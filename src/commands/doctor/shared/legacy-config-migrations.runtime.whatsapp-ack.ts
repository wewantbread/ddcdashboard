// WhatsApp legacy ackReaction migration: moves the per-channel setting into the
// canonical messages ack settings while preserving per-agent runtime fallback.
import { ensureRecord, getRecord } from "../../../config/legacy.shared.js";
import { visitChannelEntries } from "./legacy-config-record-shared.js";

function moveKey(
  owner: Record<string, unknown> | null | undefined,
  legacyKey: string,
  canonicalKey: string,
  path: string,
  changes: string[],
): void {
  if (!owner || !Object.hasOwn(owner, legacyKey)) {
    return;
  }
  if (owner[canonicalKey] === undefined) {
    owner[canonicalKey] = owner[legacyKey];
    changes.push(`Moved ${path}.${legacyKey} → ${path}.${canonicalKey}.`);
  } else {
    changes.push(`Removed ${path}.${legacyKey} (${path}.${canonicalKey} already set).`);
  }
  delete owner[legacyKey];
}

/** Removes legacy status-reaction and ack-retention keys, migrates WhatsApp's
 * legacy per-channel ackReaction into the canonical messages ack settings. */
export function migrateWhatsAppAckSettings(raw: Record<string, unknown>, changes: string[]): void {
  let messages = getRecord(raw.messages);
  const statusReactions = getRecord(messages?.statusReactions);
  if (statusReactions && Object.hasOwn(statusReactions, "emojis")) {
    delete statusReactions.emojis;
    changes.push("Removed messages.statusReactions.emojis; curated defaults now apply.");
  }
  if (messages && Object.hasOwn(messages, "removeAckAfterReply")) {
    delete messages.removeAckAfterReply;
    changes.push("Removed messages.removeAckAfterReply; acknowledgements are retained.");
  }

  visitChannelEntries(raw, "whatsapp", (entry, path) => {
    moveKey(entry, "messagePrefix", "responsePrefix", path, changes);
    const ack = getRecord(entry.ackReaction);
    if (!ack) {
      return;
    }
    messages ??= ensureRecord(raw, "messages");
    // A partly-set destination must not read as a clean move: existing messages
    // keys win (same contract as moveKey above), but every legacy half they
    // shadow is named in the change line so the dropped intent stays recoverable.
    const applied: string[] = [];
    const kept: string[] = [];
    // Resolve both legacy halves before deciding, so the receipt compares the
    // same effective values the assignment would have written — an omitted
    // emoji still resolves through agent identity or the default.
    // Canonical roster precedence (agents/agent-scope.ts:listAgentEntriesWithSource):
    // a keyed agents.entries roster wins EXCLUSIVELY over agents.list when both are
    // present — list is stale/unreachable then, not a second source to combine.
    const agentsRoot = getRecord(raw.agents);
    const keyedEntries = getRecord(agentsRoot?.entries);
    const agentEntries: Record<string, unknown>[] =
      agentsRoot && Object.hasOwn(agentsRoot, "entries") && keyedEntries
        ? Object.values(keyedEntries).flatMap((value) => {
            const agentEntry = getRecord(value);
            return agentEntry ? [agentEntry] : [];
          })
        : Array.isArray(agentsRoot?.list)
          ? agentsRoot.list.flatMap((value) => {
              const agentEntry = getRecord(value);
              return agentEntry ? [agentEntry] : [];
            })
          : [];
    // WhatsApp trims the reaction emoji at send time, so a whitespace-only
    // legacy value is not effective there — it falls back to per-agent identity,
    // then "👀". That fallback is per ROUTED agent, not the default agent, so a
    // blank legacy value only has one universal effective value when every
    // agent resolves to the same one; otherwise no single written value is safe.
    const effectiveEmoji = (value: unknown): string | undefined => {
      const trimmed = typeof value === "string" ? value.trim() : "";
      return trimmed.length > 0 ? trimmed : undefined;
    };
    const rawEmoji = typeof ack.emoji === "string" ? ack.emoji : undefined;
    const rawEffectiveEmoji = effectiveEmoji(rawEmoji);
    // Every agent's own resolved fallback (its identity emoji, else "👀" — never
    // the default agent's identity, which is only one specific agent's route).
    // No agents at all resolves the same way as one agent with no identity: "👀".
    // Known gap: a binding can route WhatsApp to an implicit "main" agent that
    // has no matching agents.entries/list row (main is only implicitly valid
    // when the config predates a keyed roster). That phantom route is not
    // modeled here, so a single explicit entry can be misreported as universal
    // when main would actually fall back to "👀". Resolving this needs reading
    // every agent's bindings and correlating match.channel/accountId against
    // this exact WhatsApp entry — real work, but a distinct capability from a
    // migration-receipt fix; left as a known limitation rather than grown here.
    const perAgentFallback =
      agentEntries.length === 0
        ? new Set(["👀"])
        : new Set(
            agentEntries.map(
              (value) => effectiveEmoji(getRecord(getRecord(value)?.identity)?.emoji) ?? "👀",
            ),
          );
    const universalFallback = perAgentFallback.size === 1 ? [...perAgentFallback][0] : undefined;
    const routeDependent = rawEffectiveEmoji === undefined && universalFallback === undefined;
    // messages.ackReaction is shared by every channel, not just WhatsApp: the
    // generic resolveAckReaction (Discord/Slack/Signal/Telegram/Matrix) returns
    // configured.trim() as soon as the key is DEFINED AT ALL, with no further
    // agent-identity fallback — unlike WhatsApp's own resolver, which re-enters
    // that fallback after trimming. So neither "" nor a whitespace passthrough is
    // safe to write here: either would silently disable acks for every other
    // channel. The written value must always be a concrete, trimmed emoji — the
    // raw legacy one if it has one, else the fallback every agent already shares,
    // else (only when agents genuinely disagree) the default agent's own
    // resolved value, the best available single answer for a key every channel
    // reads the same way.
    const defaultAgent =
      agentEntries.find((value) => getRecord(value)?.default === true) ?? agentEntries[0];
    const defaultAgentFallback =
      effectiveEmoji(getRecord(getRecord(defaultAgent)?.identity)?.emoji) ?? "👀";
    const writtenEmoji = rawEffectiveEmoji ?? universalFallback ?? defaultAgentFallback;
    const describeEffectiveEmoji = routeDependent
      ? `a route-dependent legacy emoji (varies by agent identity, e.g. "${writtenEmoji}")`
      : `effective legacy emoji "${writtenEmoji}"`;
    if (messages.ackReaction === undefined) {
      messages.ackReaction = writtenEmoji;
      applied.push(`applied ${describeEffectiveEmoji} to messages.ackReaction`);
      // Before the messages.* consolidation, the legacy resolver returned
      // ack.emoji.trim() whenever the key was present at all, so an exact ""
      // emoji suppressed the ack outright — no identity fallback (git history:
      // the WhatsApp ack-emoji monitor's own resolver, PR #111527,
      // "keeps an explicit empty emoji disabled"). messages.ackReaction can't
      // reproduce a WhatsApp-only disable: every other channel's
      // resolveAckReaction returns it trimmed with no further fallback, so
      // writing "" here would silently mute acks on channels the user never
      // touched. The fallback above is still applied, but this note calls out
      // the lost disable intent explicitly instead of resolving it silently.
      // Only emitted when the fallback was actually written — the "kept"
      // branch below already discloses that the legacy value was dropped.
      if (rawEmoji === "") {
        changes.push(
          `Note: ${path}.ackReaction.emoji was explicitly empty, disabling WhatsApp acknowledgments; messages.ackReaction has no per-channel disable, so fallback emoji "${writtenEmoji}" was applied instead. ${path}.reactionLevel: "off" suppresses WhatsApp reactions again for this account, but also disables agent-initiated reactions; there is no exact ack-only equivalent.`,
        );
      }
    } else {
      const existingRaw = typeof messages.ackReaction === "string" ? messages.ackReaction : "";
      // An exact "" canonical value explicitly disables acks (resolveWhatsAppAckEmoji
      // returns it immediately, never reaching identity/default) — a materially
      // different behavior from any legacy value, concrete or route-dependent, so
      // it is never treated as equivalent regardless of what the legacy side is.
      const existingDisabled = existingRaw === "";
      // Compare effective (trimmed) behavior, not raw strings, for the non-disabled
      // case: a canonical value that trims to the same emoji as the legacy one —
      // including both being whitespace-only, which always falls back through the
      // same per-agent identity regardless of route — is not a real conflict.
      const existingEffective = effectiveEmoji(existingRaw);
      const behaviorallyEquivalent = existingDisabled
        ? false
        : routeDependent
          ? existingEffective === undefined
          : writtenEmoji === (existingEffective ?? universalFallback ?? "👀");
      if (!behaviorallyEquivalent) {
        kept.push(`kept existing messages.ackReaction over ${describeEffectiveEmoji}`);
      }
    }
    const direct = ack.direct !== false;
    const group = ack.group ?? "mentions";
    const scope =
      direct && group === "always"
        ? "all"
        : direct && group === "never"
          ? "direct"
          : !direct && group === "always"
            ? "group-all"
            : !direct && group === "mentions"
              ? "group-mentions"
              : !direct && group === "never"
                ? "off"
                : undefined;
    // shouldAckReaction (src/channels/ack-reactions.ts) treats "off" and "none"
    // identically — both disable acks — so they're not a real conflict here.
    const normalizeDisabledScope = (value: unknown): unknown =>
      value === "off" || value === "none" ? "off" : value;
    if (messages.ackReactionScope === undefined) {
      if (scope) {
        messages.ackReactionScope = scope;
        applied.push(`applied legacy scope "${scope}" to messages.ackReactionScope`);
      }
    } else if (
      scope !== undefined &&
      normalizeDisabledScope(scope) !== normalizeDisabledScope(messages.ackReactionScope)
    ) {
      kept.push(`kept existing messages.ackReactionScope over legacy scope "${scope}"`);
    }
    delete entry.ackReaction;
    changes.push(
      kept.length === 0
        ? `Moved translatable ${path}.ackReaction settings to messages ack settings.`
        : `Removed ${path}.ackReaction; ${[...applied, ...kept].join("; ")}.`,
    );
  });
}
