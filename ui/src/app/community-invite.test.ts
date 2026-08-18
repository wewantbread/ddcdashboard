/* @vitest-environment jsdom */

import { afterEach, describe, expect, it } from "vitest";
import {
  COMMUNITY_INVITE_KEY,
  communityInviteReadiness,
  parseCommunityInviteRecord,
  readCommunityInviteRecord,
  recordQualifiedLoad,
  type CommunityInviteRecord,
} from "./community-invite.runtime.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 1_760_000_000_000;

function record(overrides: Partial<CommunityInviteRecord> = {}): CommunityInviteRecord {
  return {
    firstQualifiedAtMs: NOW - 30 * DAY_MS,
    qualifiedLoads: 1,
    established: true,
    ...overrides,
  };
}

describe("recordQualifiedLoad", () => {
  it("classifies a browser that already sees sessions as an upgraded operator", () => {
    expect(recordQualifiedLoad(null, true, NOW)).toEqual({
      firstQualifiedAtMs: NOW,
      qualifiedLoads: 1,
      established: true,
    });
  });

  it("classifies a browser with no sessions as a fresh install", () => {
    expect(recordQualifiedLoad(null, false, NOW)).toEqual({
      firstQualifiedAtMs: NOW,
      qualifiedLoads: 1,
      established: false,
    });
  });

  it("keeps the original cohort and first sighting once classified", () => {
    const previous = record({ established: false, qualifiedLoads: 2 });
    // A fresh install that later grows sessions must not be promoted to the
    // upgrade cohort, or its evaluation window would be cut short.
    expect(recordQualifiedLoad(previous, true, NOW + DAY_MS)).toEqual({
      firstQualifiedAtMs: previous.firstQualifiedAtMs,
      qualifiedLoads: 3,
      established: false,
    });
  });

  it("carries an existing tombstone forward instead of dropping it", () => {
    const shown = record({ shownAtMs: NOW - DAY_MS });
    expect(recordQualifiedLoad(shown, true, NOW).shownAtMs).toBe(shown.shownAtMs);
  });
});

describe("communityInviteReadiness", () => {
  const cases: ReadonlyArray<{
    name: string;
    record: CommunityInviteRecord;
    expected: "ready" | "waiting";
  }> = [
    {
      name: "upgraded operator waits out the first load of the new build",
      record: record({ established: true, qualifiedLoads: 1 }),
      expected: "waiting",
    },
    {
      name: "upgraded operator arms on the second qualified load",
      record: record({ established: true, qualifiedLoads: 2 }),
      expected: "ready",
    },
    {
      name: "fresh install waits while it is still young, even after many loads",
      record: record({
        established: false,
        qualifiedLoads: 9,
        firstQualifiedAtMs: NOW - DAY_MS,
      }),
      expected: "waiting",
    },
    {
      name: "fresh install waits while load count is short, even when old enough",
      record: record({
        established: false,
        qualifiedLoads: 2,
        firstQualifiedAtMs: NOW - 30 * DAY_MS,
      }),
      expected: "waiting",
    },
    {
      name: "fresh install arms once it is both old enough and used enough",
      record: record({
        established: false,
        qualifiedLoads: 3,
        firstQualifiedAtMs: NOW - 2 * DAY_MS,
      }),
      expected: "ready",
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      expect(communityInviteReadiness(testCase.record, NOW)).toBe(testCase.expected);
    });
  }

  it("treats the two-day boundary as reached, not passed", () => {
    const boundary = record({
      established: false,
      qualifiedLoads: 3,
      firstQualifiedAtMs: NOW - 2 * DAY_MS,
    });
    expect(communityInviteReadiness(boundary, NOW)).toBe("ready");
    expect(communityInviteReadiness(boundary, NOW - 1)).toBe("waiting");
  });
});

describe("parseCommunityInviteRecord", () => {
  it("round-trips a record the invite wrote, tombstone and metadata included", () => {
    const stored = record({
      qualifiedLoads: 4,
      shownAtMs: NOW,
      shownVersion: "2026.8.1",
      outcome: "joined",
    });
    expect(parseCommunityInviteRecord(structuredClone(stored))).toEqual(stored);
  });

  it("accepts a null build identity, which is what an unstamped artifact writes", () => {
    const stored = record({ shownAtMs: NOW, shownVersion: null });
    expect(parseCommunityInviteRecord(structuredClone(stored))).toEqual(stored);
  });

  const rejected: ReadonlyArray<{ name: string; value: unknown }> = [
    { name: "a non-object payload", value: "shown" },
    { name: "an array, which spreads into nonsense", value: [] },
    // `{}` used to spread into the next write as `undefined + 1` qualified loads.
    { name: "an empty object with no counters at all", value: {} },
    {
      name: "a partial record carrying only an outcome",
      // The exact shape that used to pass the old startup check and suppress the
      // invite on that browser permanently.
      value: { settledAtMs: 1, outcome: "dismissed" },
    },
    {
      name: "a non-finite first sighting",
      value: { firstQualifiedAtMs: null, qualifiedLoads: 2, established: true },
    },
    {
      name: "a fractional load count",
      value: { firstQualifiedAtMs: NOW, qualifiedLoads: 1.5, established: true },
    },
    {
      name: "a negative load count",
      value: { firstQualifiedAtMs: NOW, qualifiedLoads: -1, established: true },
    },
    {
      name: "a missing cohort flag",
      value: { firstQualifiedAtMs: NOW, qualifiedLoads: 2 },
    },
    {
      name: "a non-finite tombstone",
      value: { firstQualifiedAtMs: NOW, qualifiedLoads: 2, established: true, shownAtMs: null },
    },
    {
      name: "an outcome outside the union",
      value: {
        firstQualifiedAtMs: NOW,
        qualifiedLoads: 2,
        established: true,
        outcome: "ignored",
      },
    },
  ];

  for (const testCase of rejected) {
    it(`drops ${testCase.name}`, () => {
      expect(parseCommunityInviteRecord(testCase.value)).toBeNull();
    });
  }
});

describe("readCommunityInviteRecord", () => {
  afterEach(() => {
    localStorage.clear();
  });

  it("drops text that is not JSON at all", () => {
    localStorage.setItem(COMMUNITY_INVITE_KEY, "{not json");
    expect(readCommunityInviteRecord()).toBeNull();
  });

  it("reads back a tombstone written under the shipped key", () => {
    // The key is a stability contract: bumping it re-arms every browser that has
    // already seen the card, so the tombstone must keep being found under v1.
    expect(COMMUNITY_INVITE_KEY).toBe("openclaw:control-ui:community-invite:v1");
    localStorage.setItem(COMMUNITY_INVITE_KEY, JSON.stringify(record({ shownAtMs: NOW })));
    expect(readCommunityInviteRecord()?.shownAtMs).toBe(NOW);
  });
});
