import { describe, expect, it } from "vitest";
import { buildFacts, change } from "../../src/editor/facts";
import type { DigestData } from "../../src/jobs/digest";

const TZ = "America/Los_Angeles";
const HOUR = 3_600_000;

/** Every number anywhere in `value`. */
const numbers = (value: unknown): number[] =>
  typeof value === "number" ? [value] : value && typeof value === "object" ? Object.values(value).flatMap(numbers) : [];

function month(): DigestData {
  const hours = Array.from({ length: 7 }, () => Array<number>(24).fill(1));
  hours[6]![11] = 50; // Sundays at 11 AM
  return {
    period: { kind: "month", start: { year: 2026, month: 9, day: 1 }, end: { year: 2026, month: 10, day: 1 }, key: "2026-09" },
    timeZone: TZ,
    totals: { plays: 1564, tracks: 300, artists: 120, ms: 5.4 * HOUR },
    previous: null,
    topTracks: [
      { track_id: "a", name: "Song A", artists: "Alpha", plays: 40 },
      { track_id: "b", name: null, artists: null, plays: 12 },
    ],
    topArtists: [
      { artist_id: "A1", name: "Alpha", plays: 400 },
      { artist_id: "B1", name: "Beta", plays: 39 },
    ],
    newTrackCount: 42,
    newArtists: [{ artist_id: "N1", name: "Newbie", plays: 7 }],
    repeatPlays: 1200,
    days: Array.from({ length: 30 }, (_, i) => (i === 12 ? 99 : 50)),
    hours,
    returning: [{ artist_id: "R1", name: "Returner", plays: 3, last_before_ms: Date.UTC(2024, 5, 1, 3) }], // still May 31 in LA
    genres: [{ genre: "dream pop", plays: 700 }],
    year: Array.from({ length: 12 }, (_, i) => ({ month: { year: 2025 + Math.floor((9 + i) / 12), month: ((9 + i) % 12) + 1, day: 1 }, plays: [10, 0, 5, 5, 5, 5, 5, 5, 5, 3100, 3000, 1564][i]! })),
    throwbacks: [{ year: 2025, track: { track_id: "o", name: "Old Gold", artists: "Alpha", plays: 2 } }],
    art: {},
    playlists: [],
    discUrl: null,
  };
}

function week(previous: DigestData["previous"]): DigestData {
  const hours = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
  hours[0]![22] = 1;
  hours[3]![22] = 1;
  hours[4]![9] = 1;
  return {
    ...month(),
    period: { kind: "week", start: { year: 2026, month: 9, day: 28 }, end: { year: 2026, month: 10, day: 5 }, key: "2026-W40" },
    totals: { plays: 3, tracks: 2, artists: 2, ms: 4.4 * HOUR },
    previous,
    newTrackCount: 1,
    repeatPlays: 2,
    days: [1, 0, 0, 1, 1, 0, 0],
    hours,
    returning: [],
    genres: [],
    year: [],
    throwbacks: [],
  };
}

describe("buildFacts", () => {
  it("labels, rounds and ranks a month", () => {
    const facts = buildFacts(month());
    expect(facts).toEqual({
      period: { kind: "month", label: "September 2026", days: 30, previousLabel: "August" },
      totals: { plays: 1564, hours: 5, tracks: 300, artists: 120, newTracks: 42 },
      change: { plays: { pct: 48, direction: "down" } },
      topTracks: [
        { rank: 1, name: "Song A", artists: "Alpha", plays: 40 },
        { rank: 2, name: "Unknown track", artists: "", plays: 12 },
      ],
      topArtists: [
        { rank: 1, name: "Alpha", plays: 400, sharePct: 26 },
        { rank: 2, name: "Beta", plays: 39, sharePct: 2 },
      ],
      genres: [{ name: "dream pop", plays: 700, sharePct: 45 }],
      busiestDay: { label: "Sunday, September 13", plays: 99 },
      peak: { label: "Sundays around 11 AM" },
      newArtists: [{ name: "Newbie", plays: 7 }],
      returningArtists: [{ name: "Returner", plays: 3, lastHeardLabel: "May 2024" }],
      throwbacks: [{ year: 2025, yearsAgo: 1, name: "Old Gold", artists: "Alpha", plays: 2 }],
      year: { bestMonthLabel: "July", bestMonthPlays: 3100, previousMonthLabel: "August", change: { pct: 48, direction: "down" } },
      split: { oldFavoritesPct: 77, newFindsPct: 23 },
    });
    expect(numbers(facts).every(Number.isInteger)).toBe(true);
  });

  it("leaves out the year when last month had no plays", () => {
    const d = month();
    d.year[10]!.plays = 0;
    const facts = buildFacts(d);
    expect(facts.year).toBeUndefined();
    expect(facts.change).toBeUndefined();
  });

  it("compares a week with the week before and keeps month-only facts out", () => {
    const facts = buildFacts(week({ totals: { plays: 4, tracks: 2, artists: 2, ms: 4 * HOUR }, newTrackCount: 1 }));
    expect(facts.period).toEqual({ kind: "week", label: "Sep 28 to Oct 4", days: 7, previousLabel: "last week" });
    expect(facts.totals.hours).toBe(4);
    expect(facts.change).toEqual({ plays: { pct: 25, direction: "down" }, hours: { pct: 0, direction: "same" }, newTracks: { pct: 0, direction: "same" } });
    expect(facts.busiestDay).toEqual({ label: "Monday, September 28", plays: 1 });
    expect(facts.peak).toEqual({ label: "10 PM" });
    expect(facts.split).toEqual({ oldFavoritesPct: 67, newFindsPct: 33 });
    for (const key of ["genres", "returningArtists", "throwbacks", "year"] as const) expect(facts[key]).toBeUndefined();
    expect(numbers(facts).every(Number.isInteger)).toBe(true);
  });

  it("leaves out changes without a baseline", () => {
    expect(buildFacts(week(null)).change).toBeUndefined();
    expect(buildFacts(week({ totals: { plays: 0, tracks: 0, artists: 0, ms: 0 }, newTrackCount: 2 })).change).toEqual({ newTracks: { pct: 50, direction: "down" } });
  });
});

it("rounds changes like the email does", () => {
  expect(change(3, 4)).toEqual({ pct: 25, direction: "down" });
  expect(change(1003, 1000)).toEqual({ pct: 0, direction: "same" });
  expect(change(1006, 1000)).toEqual({ pct: 1, direction: "up" });
  expect(change(5, 0)).toBeUndefined();
});
