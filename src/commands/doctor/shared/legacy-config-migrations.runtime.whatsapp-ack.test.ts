import { describe, expect, it } from "vitest";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_RETIRED } from "./legacy-config-migrations.runtime.retired.js";

function applyAll(raw: Record<string, unknown>) {
  const changes: string[] = [];
  for (const migration of LEGACY_CONFIG_MIGRATIONS_RUNTIME_RETIRED) {
    migration.apply(raw, changes);
  }
  return { raw, changes };
}

describe("WhatsApp legacy ackReaction migration", () => {
  it("reports the kept scope when messages.ackReactionScope is already set", () => {
    const result = applyAll({
      messages: { ackReactionScope: "group-mentions" },
      channels: {
        whatsapp: { ackReaction: { emoji: "✅", direct: true, group: "never" } },
      },
    });

    expect(result.raw).not.toHaveProperty("channels.whatsapp.ackReaction");
    expect(result.raw).toHaveProperty("messages.ackReaction", "✅");
    expect(result.raw).toHaveProperty("messages.ackReactionScope", "group-mentions");
    expect(result.changes).toContain(
      'Removed channels.whatsapp.ackReaction; applied effective legacy emoji "✅" to messages.ackReaction; kept existing messages.ackReactionScope over legacy scope "direct".',
    );
    expect(result.changes).not.toContain(
      "Moved translatable channels.whatsapp.ackReaction settings to messages ack settings.",
    );
  });

  it("reports the kept emoji when messages.ackReaction is already set", () => {
    const result = applyAll({
      messages: { ackReaction: "🔥" },
      channels: {
        whatsapp: { ackReaction: { emoji: "✅", direct: false, group: "always" } },
      },
    });

    expect(result.raw).toHaveProperty("messages.ackReaction", "🔥");
    expect(result.raw).toHaveProperty("messages.ackReactionScope", "group-all");
    expect(result.changes).toContain(
      'Removed channels.whatsapp.ackReaction; applied legacy scope "group-all" to messages.ackReactionScope; kept existing messages.ackReaction over effective legacy emoji "✅".',
    );
  });

  it("reports the derived fallback emoji a different canonical emoji shadows", () => {
    const result = applyAll({
      messages: { ackReaction: "🔥" },
      channels: { whatsapp: { ackReaction: { direct: false, group: "always" } } },
      agents: { list: [{ default: true, identity: { emoji: "🤖" } }] },
    });

    expect(result.raw).toHaveProperty("messages.ackReaction", "🔥");
    expect(result.changes).toContain(
      'Removed channels.whatsapp.ackReaction; applied legacy scope "group-all" to messages.ackReactionScope; kept existing messages.ackReaction over effective legacy emoji "🤖".',
    );
  });

  it("treats a whitespace-only legacy emoji as absent, not effective (#119501)", () => {
    const result = applyAll({
      messages: { ackReaction: "🔥" },
      channels: { whatsapp: { ackReaction: { emoji: " ", direct: false, group: "always" } } },
      agents: { list: [{ default: true, identity: { emoji: "🤖" } }] },
    });

    // WhatsApp trims a whitespace-only emoji and falls back, so the effective
    // legacy value is the identity emoji "🤖", not the literal " ".
    expect(result.raw).toHaveProperty("messages.ackReaction", "🔥");
    expect(result.changes).toContain(
      'Removed channels.whatsapp.ackReaction; applied legacy scope "group-all" to messages.ackReactionScope; kept existing messages.ackReaction over effective legacy emoji "🤖".',
    );
  });

  it("writes the default agent's concrete emoji for a blank legacy value in multi-agent WhatsApp, never blank (#119501)", () => {
    // codex review: messages.ackReaction is shared by every channel, not just
    // WhatsApp. The generic resolveAckReaction (Discord/Slack/Signal/Telegram/
    // Matrix) returns configured.trim() as soon as the key is defined at all —
    // it never re-enters an identity fallback the way WhatsApp's own resolver
    // does. Writing raw whitespace here (an earlier, reverted fix) would
    // silently disable acknowledgements for every one of those other channels.
    // The safest available write is the default agent's own concrete resolved
    // emoji; the receipt still discloses that it's a best-effort pick, not a
    // universal one, since "routed" and "main" resolve differently.
    const result = applyAll({
      messages: { ackReactionScope: "group-mentions" },
      agents: {
        list: [
          { id: "routed", identity: { emoji: "🚀" } },
          { default: true, id: "main", identity: { emoji: "🤖" } },
        ],
      },
      channels: {
        whatsapp: { ackReaction: { emoji: " ", direct: true, group: "never" } },
      },
    });

    expect(result.raw).toHaveProperty("messages.ackReaction", "🤖");
    expect(result.changes).toContain(
      'Removed channels.whatsapp.ackReaction; applied a route-dependent legacy emoji (varies by agent identity, e.g. "🤖") to messages.ackReaction; kept existing messages.ackReactionScope over legacy scope "direct".',
    );
  });

  it("reports a kept blank legacy emoji as route-dependent in multi-agent WhatsApp (#119501)", () => {
    // ClawSweeper's exact reproduction: an existing messages.ackReaction survives,
    // so this hits the "kept" branch rather than "applied" above. Before the fix,
    // the receipt claimed the default agent's "🤖" was the displaced value even
    // though "routed" would actually have fallen back to "🚀" — misdescribing a
    // route-dependent legacy value as a single universal one.
    const result = applyAll({
      messages: { ackReaction: "🔥" },
      agents: {
        list: [
          { id: "routed", identity: { emoji: "🚀" } },
          { default: true, id: "main", identity: { emoji: "🤖" } },
        ],
      },
      channels: {
        whatsapp: { ackReaction: { emoji: " ", direct: false, group: "always" } },
      },
    });

    expect(result.raw).toHaveProperty("messages.ackReaction", "🔥");
    expect(result.changes).toContain(
      'Removed channels.whatsapp.ackReaction; applied legacy scope "group-all" to messages.ackReactionScope; kept existing messages.ackReaction over a route-dependent legacy emoji (varies by agent identity, e.g. "🤖").',
    );
  });

  it("bakes in the default agent's fallback (never blank) when the default identity is itself blank (#119501)", () => {
    // The legacy object omits emoji entirely, the DEFAULT agent has no identity
    // emoji either, but "routed" has "🚀". writeEmoji still must be a concrete,
    // non-blank value (never "" or whitespace — see the cross-channel test
    // above), so it falls all the way to the default agent's own resolved
    // fallback ("👀", since main has no identity) — the best available single
    // answer, disclosed as route-dependent rather than claimed as universal.
    const result = applyAll({
      messages: { ackReactionScope: "group-mentions" },
      agents: {
        list: [
          { id: "routed", identity: { emoji: "🚀" } },
          { default: true, id: "main" },
        ],
      },
      channels: {
        whatsapp: { ackReaction: { direct: true, group: "never" } },
      },
    });

    expect(result.raw).toHaveProperty("messages.ackReaction", "👀");
    expect(result.changes).toContain(
      'Removed channels.whatsapp.ackReaction; applied a route-dependent legacy emoji (varies by agent identity, e.g. "👀") to messages.ackReaction; kept existing messages.ackReactionScope over legacy scope "direct".',
    );
  });

  it("never treats a canonical empty-string ackReaction as equivalent to a legacy fallback (#119501)", () => {
    // codex review: messages.ackReaction === "" is a distinct disable sentinel
    // (resolveWhatsAppAckEmoji returns it immediately, skipping the fallback
    // chain) — behaviorally different from any legacy value, so it must always
    // be reported as a real conflict, never silently treated as "no change".
    const result = applyAll({
      messages: { ackReaction: "" },
      channels: { whatsapp: { ackReaction: { emoji: " ", direct: false, group: "always" } } },
    });

    expect(result.raw).toHaveProperty("messages.ackReaction", "");
    expect(result.changes).toContain(
      'Removed channels.whatsapp.ackReaction; applied legacy scope "group-all" to messages.ackReactionScope; kept existing messages.ackReaction over effective legacy emoji "👀".',
    );
  });

  it("follows canonical entries-over-list roster precedence, not a merge of both (#119501)", () => {
    // codex review: when agents.entries is present, runtime roster resolution
    // (listAgentEntriesWithSource) uses it EXCLUSIVELY — a stale agents.list is
    // never reachable and must not influence the receipt or the written value.
    const result = applyAll({
      messages: { ackReactionScope: "group-mentions" },
      agents: {
        entries: { main: { default: true, identity: { emoji: "🤖" } } },
        // Stale/unreachable once agents.entries exists — must be ignored.
        list: [{ id: "routed", identity: { emoji: "🚀" } }],
      },
      channels: {
        whatsapp: { ackReaction: { direct: true, group: "never" } },
      },
    });

    expect(result.raw).toHaveProperty("messages.ackReaction", "🤖");
    expect(result.changes).toContain(
      'Removed channels.whatsapp.ackReaction; applied effective legacy emoji "🤖" to messages.ackReaction; kept existing messages.ackReactionScope over legacy scope "direct".',
    );
  });

  it("reads identity emojis from a canonical keyed agent roster, not just the legacy array (#119501)", () => {
    // codex review: a config already migrated to agents.entries (keyed roster) is
    // a valid current shape, not just a pre-migration one — the receipt must read
    // it too, or it silently reports the universal "👀" fallback for every real,
    // routable agent identity.
    const result = applyAll({
      messages: { ackReaction: "🔥" },
      agents: {
        entries: {
          routed: { identity: { emoji: "🚀" } },
          main: { default: true, identity: { emoji: "🤖" } },
        },
      },
      channels: {
        whatsapp: { ackReaction: { emoji: " ", direct: false, group: "always" } },
      },
    });

    expect(result.changes).toContain(
      'Removed channels.whatsapp.ackReaction; applied legacy scope "group-all" to messages.ackReactionScope; kept existing messages.ackReaction over a route-dependent legacy emoji (varies by agent identity, e.g. "🤖").',
    );
  });

  it("treats a trimmed-equivalent canonical value as a clean move, not a shadowed conflict (#119501)", () => {
    // codex review: comparing raw strings instead of effective (trimmed) values
    // misreported "✅" vs " ✅ " — and blank-vs-blank in a multi-agent setup — as
    // the canonical value shadowing legacy intent, when they behave identically.
    const result = applyAll({
      messages: { ackReaction: " ✅ " },
      channels: { whatsapp: { ackReaction: { emoji: "✅", direct: false, group: "always" } } },
    });

    expect(result.raw).toHaveProperty("messages.ackReaction", " ✅ ");
    expect(result.changes).toContain(
      "Moved translatable channels.whatsapp.ackReaction settings to messages ack settings.",
    );
  });

  it("treats blank-vs-blank as equivalent even when identities diverge by route (#119501)", () => {
    const result = applyAll({
      messages: { ackReaction: "   " },
      agents: {
        list: [
          { id: "routed", identity: { emoji: "🚀" } },
          { default: true, id: "main", identity: { emoji: "🤖" } },
        ],
      },
      channels: {
        whatsapp: { ackReaction: { emoji: " ", direct: false, group: "always" } },
      },
    });

    expect(result.raw).toHaveProperty("messages.ackReaction", "   ");
    expect(result.changes).toContain(
      "Moved translatable channels.whatsapp.ackReaction settings to messages ack settings.",
    );
  });

  it("never writes an exact empty-string legacy emoji verbatim, but flags the lost disable intent (#119501)", () => {
    // Historically (pre-consolidation), the legacy per-channel resolver returned
    // ack.emoji.trim() whenever the key was present at all, so an exact "" emoji
    // suppressed the ack outright with no identity fallback (git history:
    // the WhatsApp ack-emoji monitor's own resolver, PR #111527,
    // "keeps an explicit empty emoji disabled"). But messages.ackReaction is
    // shared by every channel's resolveAckReaction, which returns it trimmed
    // with no further fallback — writing "" there would silently mute acks on
    // channels the user never configured. A concrete fallback is applied
    // instead, with an explicit note calling out the lost disable intent.
    const result = applyAll({
      messages: { ackReactionScope: "group-mentions" },
      agents: { list: [{ default: true, id: "main", identity: { emoji: "🤖" } }] },
      channels: {
        whatsapp: { ackReaction: { emoji: "", direct: false, group: "always" } },
      },
    });

    expect(result.raw).toHaveProperty("messages.ackReaction", "🤖");
    expect(result.changes).toContain(
      'Removed channels.whatsapp.ackReaction; applied effective legacy emoji "🤖" to messages.ackReaction; kept existing messages.ackReactionScope over legacy scope "group-all".',
    );
    expect(result.changes).toContain(
      'Note: channels.whatsapp.ackReaction.emoji was explicitly empty, disabling WhatsApp acknowledgments; messages.ackReaction has no per-channel disable, so fallback emoji "🤖" was applied instead. channels.whatsapp.reactionLevel: "off" suppresses WhatsApp reactions again for this account, but also disables agent-initiated reactions; there is no exact ack-only equivalent.',
    );
  });

  it("points the disable-recovery note at the account's own reactionLevel, not the shared root (#119501)", () => {
    // codex review: channels.whatsapp.reactionLevel disables reactions for
    // every WhatsApp account. When the empty legacy emoji lives under a
    // specific account, the note must reference that account's own
    // reactionLevel path, which is what runtime resolution actually reads.
    const result = applyAll({
      messages: { ackReactionScope: "group-mentions" },
      agents: { list: [{ default: true, id: "main", identity: { emoji: "🤖" } }] },
      channels: {
        whatsapp: {
          accounts: { work: { ackReaction: { emoji: "", direct: false, group: "always" } } },
        },
      },
    });

    expect(result.raw).toHaveProperty("messages.ackReaction", "🤖");
    expect(result.changes).toContain(
      'Note: channels.whatsapp.accounts.work.ackReaction.emoji was explicitly empty, disabling WhatsApp acknowledgments; messages.ackReaction has no per-channel disable, so fallback emoji "🤖" was applied instead. channels.whatsapp.accounts.work.reactionLevel: "off" suppresses WhatsApp reactions again for this account, but also disables agent-initiated reactions; there is no exact ack-only equivalent.',
    );
  });

  it("never claims a fallback was applied when an existing canonical value was kept instead (#119501)", () => {
    // codex review: the explicit-disable note used to fire whenever the legacy
    // emoji was exactly "", even when messages.ackReaction already had a value
    // and the "kept" branch below never wrote the fallback at all — a
    // contradictory receipt claiming an application that did not happen.
    const result = applyAll({
      messages: { ackReaction: "🔥" },
      agents: { list: [{ default: true, id: "main", identity: { emoji: "🤖" } }] },
      channels: {
        whatsapp: { ackReaction: { emoji: "", direct: true, group: "never" } },
      },
    });

    expect(result.raw).toHaveProperty("messages.ackReaction", "🔥");
    expect(result.changes).toContain(
      'Removed channels.whatsapp.ackReaction; applied legacy scope "direct" to messages.ackReactionScope; kept existing messages.ackReaction over effective legacy emoji "🤖".',
    );
    expect(result.changes.some((change) => change.includes("was explicitly empty"))).toBe(false);
  });

  it("reports the default fallback emoji when no legacy emoji or identity exists", () => {
    const result = applyAll({
      messages: { ackReaction: "🔥" },
      channels: { whatsapp: { ackReaction: { direct: false, group: "always" } } },
    });

    expect(result.changes).toContain(
      'Removed channels.whatsapp.ackReaction; applied legacy scope "group-all" to messages.ackReactionScope; kept existing messages.ackReaction over effective legacy emoji "👀".',
    );
  });

  it("stays on the clean-move message when the canonical emoji equals the fallback", () => {
    const result = applyAll({
      messages: { ackReaction: "👀" },
      channels: { whatsapp: { ackReaction: { direct: false, group: "always" } } },
    });

    expect(result.raw).toHaveProperty("messages.ackReaction", "👀");
    expect(result.raw).toHaveProperty("messages.ackReactionScope", "group-all");
    expect(result.changes).toContain(
      "Moved translatable channels.whatsapp.ackReaction settings to messages ack settings.",
    );
  });

  it("reports both kept halves when messages ack settings are fully set", () => {
    const result = applyAll({
      messages: { ackReaction: "🔥", ackReactionScope: "group-mentions" },
      channels: {
        whatsapp: { ackReaction: { emoji: "✅", direct: true, group: "never" } },
      },
    });

    expect(result.raw).not.toHaveProperty("channels.whatsapp.ackReaction");
    expect(result.raw).toHaveProperty("messages.ackReaction", "🔥");
    expect(result.raw).toHaveProperty("messages.ackReactionScope", "group-mentions");
    expect(result.changes).toContain(
      'Removed channels.whatsapp.ackReaction; kept existing messages.ackReaction over effective legacy emoji "✅"; kept existing messages.ackReactionScope over legacy scope "direct".',
    );
  });

  it("keeps the clean-move message when existing keys equal the legacy values", () => {
    const result = applyAll({
      messages: { ackReactionScope: "direct" },
      channels: {
        whatsapp: { ackReaction: { emoji: "✅", direct: true, group: "never" } },
      },
    });

    expect(result.raw).toHaveProperty("messages.ackReaction", "✅");
    expect(result.raw).toHaveProperty("messages.ackReactionScope", "direct");
    expect(result.changes).toContain(
      "Moved translatable channels.whatsapp.ackReaction settings to messages ack settings.",
    );
  });

  it("treats an existing 'none' scope as equivalent to a legacy 'off' scope (#119501)", () => {
    // codex review: shouldAckReaction (src/channels/ack-reactions.ts:34) treats
    // "off" and "none" identically — both disable acks — so this must not be
    // reported as the canonical scope shadowing legacy intent.
    const result = applyAll({
      messages: { ackReactionScope: "none" },
      channels: {
        whatsapp: { ackReaction: { emoji: "✅", direct: false, group: "never" } },
      },
    });

    expect(result.raw).toHaveProperty("messages.ackReactionScope", "none");
    expect(result.changes).toContain(
      "Moved translatable channels.whatsapp.ackReaction settings to messages ack settings.",
    );
  });
});
