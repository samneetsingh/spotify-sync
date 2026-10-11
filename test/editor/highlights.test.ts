import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { countingD1 } from "../../src/db/counting";
import { digestComebackTracks, digestGenreShares, digestNewObsession, trackNames, type PeriodPlay } from "../../src/db/queries";
import { migrate } from "../../src/db/schema";
import { computeHighlights, loadHighlights } from "../../src/editor/highlights";
import type { Highlight, HighlightKind } from "../../src/editor/types";
import { lastPeriod, loadDigest, type ArtSource, type DigestData, type Period } from "../../src/jobs/digest";
import { zonedMidnight } from "../../src/utils/time";
import { resetDb } from "../parity/spotify-fixture";

const TZ = "America/Los_Angeles";
const MIN = 60_000;
const HOUR = 3_600_000;
const YEAR = 365 * 86_400_000;
const SEP: Period = { kind: "month", start: { year: 2026, month: 9, day: 1 }, end: { year: 2026, month: 10, day: 1 }, key: "2026-09" };
const WEEK: Period = { kind: "week", start: { year: 2026, month: 9, day: 28 }, end: { year: 2026, month: 10, day: 5 }, key: "2026-W40" };

/** UTC ms of a wall-clock time in Los Angeles ("2026-09-03", "21:30"); not for times inside a DST change. */
function local(date: string, time = "12:00"): number {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const [h, m] = time.split(":").map(Number) as [number, number];
  return zonedMidnight({ year, month, day }, TZ) + h * HOUR + m * MIN;
}
const play = (date: string, time: string, id = "t", ms = 0): PeriodPlay => ({ at: local(date, time), id, ms });
const sorted = (plays: PeriodPlay[]) => plays.sort((a, b) => a.at - b.at);
/** "2026-09-03" .. "2026-09-25" */
const dates = (month: string, from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `${month}-${String(from + i).padStart(2, "0")}`);
const find = (hs: Highlight[], kind: HighlightKind) => hs.find((h) => h.kind === kind);

describe("computeHighlights", () => {
  it("finds the longest daily streak (10+ days a month, all 7 a week)", () => {
    const rows = sorted([play("2026-09-01", "12:00", "a"), ...dates("2026-09", 3, 25).map((d, i) => play(d, "12:00", `s${i}`))]);
    expect(find(computeHighlights("month", SEP, rows, TZ), "streak")).toEqual({
      id: "hl:streak",
      kind: "streak",
      score: 23 / 30,
      stat: { value: 23, unit: "days in a row" },
      facts: { days: 23, startLabel: "Sep 3", endLabel: "Sep 25", everyDay: "no" },
      defaultHeading: "Day after day",
      defaultInsight: "You pressed play **23 days in a row**, Sep 3 to Sep 25.",
    });
    const nine = sorted(dates("2026-09", 3, 11).map((d) => play(d, "12:00")));
    expect(find(computeHighlights("month", SEP, nine, TZ), "streak")).toBeUndefined();
    const ten = sorted(dates("2026-09", 3, 12).map((d) => play(d, "12:00")));
    expect(find(computeHighlights("month", SEP, ten, TZ), "streak")?.stat.value).toBe(10);

    const week = sorted([...dates("2026-09", 28, 30), ...dates("2026-10", 1, 4)].map((d) => play(d, "12:00")));
    const all = find(computeHighlights("week", WEEK, week, TZ), "streak")!;
    expect(all.score).toBe(1);
    expect(all.facts).toMatchObject({ days: 7, everyDay: "yes" });
    expect(all.defaultHeading).toBe("Every single day");
    expect(all.defaultInsight).toBe("You pressed play **every day this week**, Sep 28 to Oct 4.");
    expect(find(computeHighlights("week", WEEK, week.slice(1), TZ), "streak")).toBeUndefined();
  });

  it("counts late-night plays (midnight to 3:59 AM) and their favorite track", () => {
    // 15 late plays out of 100; x and y both have two, x came first.
    const late = dates("2026-09", 1, 15).map((d, i) => play(d, "01:00", ["x", "x", "y", "y"][i] ?? `l${i}`));
    const day = (n: number) => Array.from({ length: n }, (_, i) => play(`2026-09-${String(1 + (i % 28)).padStart(2, "0")}`, `${12 + Math.floor(i / 28)}:00`, `d${i}`));
    const names = new Map([["x", { name: "Night Song", artists: "Owl" }]]);
    const h = find(computeHighlights("month", SEP, sorted([...late, ...day(85)]), TZ, { names }), "lateNight")!;
    expect(h.stat).toEqual({ value: 15, unit: "plays after midnight" });
    expect(h.score).toBeCloseTo(0.3);
    expect(h.facts).toEqual({ plays: 15, sharePct: 15, window: "midnight to 4 AM", track: "Night Song", trackPlays: 2 });
    expect(h.subject).toEqual({ type: "track", id: "x", name: "Night Song", artists: "Owl" });
    expect(h.defaultInsight).toBe("**15 plays** came between midnight and 4 AM, 15% of your plays this month. Your late-night favorite: **Night Song**.");

    expect(find(computeHighlights("month", SEP, sorted([...late.slice(1), ...day(85)]), TZ), "lateNight")).toBeUndefined(); // 14 plays
    expect(find(computeHighlights("month", SEP, sorted([...late, ...day(185)]), TZ), "lateNight")).toBeUndefined(); // 7.5%

    // A week needs 5. 3:59 counts, 4:00 and 11:59 PM don't; no track was played twice.
    const week = sorted([
      play("2026-09-28", "00:00", "a"),
      play("2026-09-29", "03:59", "b"),
      play("2026-09-30", "01:00", "c"),
      play("2026-10-01", "02:00", "d"),
      play("2026-10-02", "03:00", "e"),
      play("2026-10-03", "04:00", "f"),
      play("2026-10-04", "23:59", "g"),
    ]);
    const w = find(computeHighlights("week", WEEK, week, TZ), "lateNight")!;
    expect(w.facts).toEqual({ plays: 5, sharePct: 71, window: "midnight to 4 AM" });
    expect(w.subject).toBeUndefined();
    expect(w.score).toBe(1);
  });

  it("finds the most plays of one song in one local day", () => {
    const six = sorted(["10:00", "11:00", "12:00", "13:00", "14:00", "23:30"].map((t) => play("2026-09-13", t, "r")));
    const h = find(computeHighlights("month", SEP, six, TZ), "repeatDay")!;
    expect(h.stat).toEqual({ value: 6, unit: "plays in one day" });
    expect(h.facts).toEqual({ plays: 6, dayLabel: "Sunday, September 13", track: "Unknown track" });
    expect(h.score).toBeCloseTo(6 / 15);
    expect(find(computeHighlights("month", SEP, six.slice(1), TZ), "repeatDay")).toBeUndefined();
    expect(find(computeHighlights("week", WEEK, sorted(["10:00", "11:00", "12:00", "13:00"].map((t) => play("2026-10-01", t, "r"))), TZ), "repeatDay")?.stat.value).toBe(4);
  });

  it("finds the longest session, split on gaps over 30 minutes", () => {
    // Plays are stamped when they end: 30-minute tracks ending 9:30 to 11:30 PM are one 150-minute session from 9 PM.
    const session = (ends: string[], ms = 30 * MIN) => sorted(ends.map((t, i) => play("2026-09-03", t, `b${i}`, ms)));
    const h = find(computeHighlights("month", SEP, session(["21:30", "22:00", "22:30", "23:00", "23:30"]), TZ), "binge")!;
    expect(h.stat).toEqual({ value: 2.5, unit: "hours straight" });
    expect(h.facts).toEqual({ minutes: 150, hours: 2.5, plays: 5, dayLabel: "Thursday, September 3", startLabel: "9 PM" });
    expect(h.score).toBeCloseTo(150 / 360);
    expect(h.defaultInsight).toBe("On Thursday, September 3 you listened for **2.5 hours straight**, starting around 9 PM.");

    const short = session(["21:30", "22:00", "22:30", "23:00"]);
    short.push({ ...play("2026-09-03", "23:29", "last"), ms: 29 * MIN });
    expect(find(computeHighlights("month", SEP, short, TZ), "binge")).toBeUndefined(); // 149 minutes
    // A 30-minute break keeps the session going, 31 minutes ends it.
    expect(find(computeHighlights("month", SEP, session(["21:30", "22:00", "23:00", "23:30", "24:00"]), TZ), "binge")?.facts.minutes).toBe(150);
    expect(find(computeHighlights("month", SEP, session(["21:30", "22:00", "23:01", "23:31", "24:01"]), TZ), "binge")).toBeUndefined();
    expect(find(computeHighlights("week", WEEK, sorted([1, 2, 3, 4].map((i) => play("2026-10-03", `1${i}:00`, `w${i}`, HOUR / 2))), TZ), "binge")?.facts).toMatchObject({
      minutes: 120,
      hours: 2,
      startLabel: "10 AM",
    });
  });

  it("buckets local days and hours across both DST changes", () => {
    // March 2026 (clocks spring forward on the 8th): a play at 12:30 AM every day is a 31-day streak.
    const march: Period = { kind: "month", start: { year: 2026, month: 3, day: 1 }, end: { year: 2026, month: 4, day: 1 }, key: "2026-03" };
    const nightly = dates("2026-03", 1, 31).map((d) => ({ at: zonedMidnight({ year: 2026, month: 3, day: Number(d.slice(-2)) }, TZ) + 30 * MIN, id: d, ms: 0 }));
    expect(find(computeHighlights("month", march, nightly, TZ), "streak")?.facts).toMatchObject({ days: 31, everyDay: "yes", endLabel: "Mar 31" });

    // Sunday Nov 1 falls back at 2 AM: 0:30 and 1:30 PDT, then 1:30, 2:30, 3:30 and 11:30 PM PST.
    const fall: Period = { kind: "week", start: { year: 2026, month: 10, day: 26 }, end: { year: 2026, month: 11, day: 2 }, key: "2026-W44" };
    const rows = ["2026-11-01T07:30:00Z", "2026-11-01T08:30:00Z", "2026-11-01T09:30:00Z", "2026-11-01T10:30:00Z", "2026-11-01T11:30:00Z", "2026-11-02T07:30:00Z"].map(
      (iso) => ({ at: Date.parse(iso), id: "fb", ms: 0 }),
    );
    const hs = computeHighlights("week", fall, rows, TZ);
    expect(find(hs, "lateNight")?.facts).toMatchObject({ plays: 5, sharePct: 83, trackPlays: 5 });
    expect(find(hs, "repeatDay")?.facts).toMatchObject({ plays: 6, dayLabel: "Sunday, November 1" });
  });

  it("builds the SQL-backed highlights from their rows, with thresholds per kind", () => {
    const comebackTracks = [{ track_id: "c", name: "Comeback", artists: "Returner", plays: 3, last_before_ms: local("2024-05-10") }];
    const comebackArtist = { artist_id: "R1", name: "Returner", plays: 4, last_before_ms: local("2025-08-20") };
    const newObsession = { track_id: "n", name: "Fresh", artists: null, plays: 6, first_ms: local("2026-09-05", "00:30") };
    const genreShares = {
      genres: [
        { genre: "indie", now: 10, before: 3 },
        { genre: "pop", now: 5, before: 10 },
      ],
      tagged: { now: 20, before: 20 },
    };
    const hs = computeHighlights("month", SEP, [], TZ, { comebackTracks, comebackArtist, newObsession, genreShares });
    expect(hs.map((h) => h.kind)).toEqual(["genreShift", "comebackTrack", "comebackArtist", "newObsession"]);

    expect(find(hs, "comebackTrack")).toMatchObject({
      stat: { value: 2, unit: "years away" },
      subject: { type: "track", id: "c", name: "Comeback", artists: "Returner" },
      facts: { plays: 3, lastHeardLabel: "May 2024", yearsAway: 2, track: "Comeback" },
      defaultInsight: "**Comeback** is back: 3 plays this month, your first since May 2024.",
    });
    expect(find(hs, "comebackArtist")).toMatchObject({
      stat: { value: 1, unit: "year away" },
      subject: { type: "artist", id: "R1", name: "Returner" },
      facts: { plays: 4, lastHeardLabel: "Aug 2025", yearsAway: 1, artist: "Returner" },
    });
    expect(find(hs, "newObsession")).toMatchObject({
      score: 0.3,
      subject: { type: "track", id: "n", name: "Fresh" },
      facts: { plays: 6, firstHeardLabel: "Sep 5", track: "Fresh" },
    });
    expect(find(hs, "genreShift")).toMatchObject({
      score: 1,
      stat: { value: 50, unit: "percent indie" },
      facts: { genre: "indie", nowPct: 50, beforePct: 15, deltaPts: 35, previousLabel: "August" },
      defaultHeading: "More indie",
      defaultInsight: "**indie** made up 50% of your plays, up from 15% in August.",
    });

    expect(computeHighlights("month", SEP, [], TZ, { newObsession: { ...newObsession, plays: 5 } })).toEqual([]);
    expect(find(computeHighlights("week", WEEK, [], TZ, { newObsession: { ...newObsession, plays: 4 } }), "newObsession")).toBeDefined();
  });

  it("needs enough tagged plays in both periods and a big enough gain for a genre shift", () => {
    const shift = (kind: "month" | "week", now: number, before: number, tagged: [number, number]) =>
      find(
        computeHighlights(kind, kind === "month" ? SEP : WEEK, [], TZ, {
          genreShares: { genres: [{ genre: "indie", now, before }], tagged: { now: tagged[0], before: tagged[1] } },
        }),
        "genreShift",
      );
    expect(shift("month", 7, 6, [20, 20])?.facts).toMatchObject({ nowPct: 35, beforePct: 30, deltaPts: 5 }); // exactly 5 points
    expect(shift("month", 7, 6, [19, 20])).toBeUndefined();
    expect(shift("month", 7, 6, [20, 19])).toBeUndefined();
    expect(shift("month", 6, 6, [20, 21])).toBeUndefined(); // 1.4 points
    expect(shift("week", 7, 6, [20, 20])).toBeUndefined(); // a week needs 8
    expect(shift("week", 5, 2, [10, 10])?.facts).toMatchObject({ deltaPts: 30, previousLabel: "last week" });
    expect(shift("month", 2, 8, [20, 20])).toBeUndefined(); // a drop isn't a shift
  });

  it("returns nothing for a period without plays", () => {
    expect(computeHighlights("month", SEP, [], TZ)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------- D1

/** One track per row, credited to one primary artist (with genres JSON when given), played at the given times. */
async function seed(rows: Array<{ id: string; name: string; artist: [string, string]; genres?: string | null; at: number[]; durationMs?: number }>) {
  await env.DB.batch(
    rows.flatMap(({ id, name, artist, genres, at, durationMs }) => [
      env.DB.prepare("INSERT INTO tracks(track_id, track_uri, name, artists, duration_ms) VALUES(?1, 'spotify:track:' || ?1, ?2, ?3, ?4)").bind(id, name, artist[1], durationMs ?? null),
      env.DB.prepare("INSERT OR IGNORE INTO track_artists(track_id, artist_id, artist_name, position) VALUES(?1, ?2, ?3, 0)").bind(id, artist[0], artist[1]),
      ...(genres === undefined ? [] : [env.DB.prepare("INSERT OR IGNORE INTO artists(artist_id, name, genres) VALUES(?1, ?2, ?3)").bind(artist[0], artist[1], genres)]),
      ...at.map((ms) => env.DB.prepare("INSERT INTO plays(played_at_ms, track_id, track_uri, source) VALUES(?1, ?2, 'spotify:track:' || ?2, 'history_import')").bind(ms, id)),
    ]),
  );
}

const noArt = { getTracks: async () => ({ tracks: [] }), getArtists: async () => ({ artists: [] }) } as unknown as ArtSource;

beforeAll(() => migrate(env.DB));
beforeEach(() => resetDb(env.DB));

describe("highlight queries", () => {
  const from = local("2026-09-01", "00:00");
  const to = local("2026-10-01", "00:00");

  it("finds comeback tracks only after a break of more than the idle time", async () => {
    const inSep = [local("2026-09-02"), local("2026-09-03"), local("2026-09-04")];
    const earlier = (last: number) => [last - 4 * HOUR, last - 3 * HOUR, last - 2 * HOUR, last - HOUR, last];
    await seed([
      { id: "a", name: "Away", artist: ["A1", "A"], at: [...earlier(from - YEAR - MIN), ...inSep] },
      { id: "b", name: "Boundary", artist: ["B1", "B"], at: [...earlier(from - YEAR), ...inSep] },
      { id: "f", name: "Few Before", artist: ["F1", "F"], at: [...earlier(from - 2 * YEAR).slice(1), ...inSep] },
      { id: "o", name: "Once Now", artist: ["O1", "O"], at: [...earlier(from - 2 * YEAR), inSep[0]!] },
    ]);
    const rows = await digestComebackTracks(env.DB, from, to, { idleMs: YEAR, minEarlierPlays: 5, minPlays: 3 });
    expect(rows).toEqual([{ track_id: "a", name: "Away", artists: "A", plays: 3, earlier: 5, last_before_ms: from - YEAR - MIN }]);
  });

  it("finds the new obsession among tracks never played before the period", async () => {
    await seed([
      { id: "old", name: "Old", artist: ["O1", "O"], at: [local("2026-08-31", "23:59"), ...dates("2026-09", 1, 9).map((d) => local(d))] },
      { id: "new", name: "New", artist: ["N1", "N"], at: dates("2026-09", 10, 15).map((d) => local(d)) },
      { id: "tie", name: "Tie", artist: ["T1", "T"], at: dates("2026-09", 11, 16).map((d) => local(d)) },
      { id: "next", name: "Next Month", artist: ["X1", "X"], at: dates("2026-10", 1, 9).map((d) => local(d)) },
    ]);
    expect(await digestNewObsession(env.DB, from, to)).toEqual({ track_id: "new", name: "New", artists: "N", plays: 6, first_ms: local("2026-09-10") });
    expect(await digestNewObsession(env.DB, local("2026-12-01"), local("2027-01-01"))).toBeNull();
  });

  it("counts genre shares under the primary artist, treating bad or empty genres as untagged", async () => {
    const aug = local("2026-08-01", "00:00");
    await seed([
      { id: "i", name: "Indie", artist: ["I1", "I"], genres: '["indie", "dream pop"]', at: [local("2026-08-10"), local("2026-09-10"), local("2026-09-11")] },
      { id: "b", name: "Bad", artist: ["B1", "B"], genres: "not json", at: [local("2026-09-12")] },
      { id: "e", name: "Empty", artist: ["E1", "E"], genres: "[]", at: [local("2026-09-13")] },
      { id: "n", name: "Null", artist: ["N1", "N"], genres: null, at: [local("2026-09-14")] },
      { id: "u", name: "Unknown Artist", artist: ["U1", "U"], at: [local("2026-09-15")] },
      { id: "p", name: "Pop", artist: ["P1", "P"], genres: '["pop"]', at: [local("2026-08-11"), local("2026-07-31")] },
    ]);
    const shares = await digestGenreShares(env.DB, aug, from, to);
    expect(shares.tagged).toEqual({ now: 2, before: 2 });
    expect(shares.genres.sort((a, b) => a.genre.localeCompare(b.genre))).toEqual([
      { genre: "dream pop", now: 2, before: 1 },
      { genre: "indie", now: 2, before: 1 },
      { genre: "pop", now: 0, before: 1 },
    ]);
    expect(await digestGenreShares(env.DB, local("2025-01-01"), local("2025-02-01"), local("2025-03-01"))).toEqual({ genres: [], tagged: { now: 0, before: 0 } });
  });

  it("names tracks, skipping the query when there are none", async () => {
    await seed([{ id: "t", name: "Known", artist: ["K1", "Known Artist"], at: [] }]);
    const { db, queries } = countingD1(env.DB);
    expect(await trackNames(db, [])).toEqual(new Map());
    expect(queries()).toBe(0);
    expect(await trackNames(db, ["t", "missing"])).toEqual(new Map([["t", { name: "Known", artists: "Known Artist" }]]));
  });
});

describe("loadHighlights", () => {
  it("finds every kind in a busy week, best first, in at most 6 queries", async () => {
    const week = [...dates("2026-09", 28, 30), ...dates("2026-10", 1, 4)];
    await seed([
      // New this week, every evening.
      { id: "n", name: "New Love", artist: ["N1", "Newbie"], genres: '["hyperpop"]', at: week.map((d) => local(d, "21:00")) },
      // Last heard in January 2025; back after midnight on Thursday, five times.
      {
        id: "c",
        name: "Comeback",
        artist: ["C1", "Classic"],
        genres: '["indie"]',
        at: [...dates("2025-01", 1, 12).map((d) => local(d, "18:00")), ...["00:30", "01:00", "01:30", "02:00", "02:30"].map((t) => local("2026-10-01", t))],
      },
      // Three 50-minute mixes back to back on Saturday afternoon.
      { id: "b", name: "Long Mix", artist: ["B1", "Beats"], genres: '["indie"]', durationMs: 50 * MIN, at: ["15:50", "16:40", "17:30"].map((t) => local("2026-10-03", t)) },
      // The week before: all indie.
      { id: "p", name: "Prior", artist: ["P1", "Prior"], genres: '["indie"]', at: dates("2026-09", 21, 27).flatMap((d) => [local(d, "09:00"), local(d, "10:00")]).slice(0, 10) },
    ]);
    const data = { returning: [] } as unknown as DigestData; // weeks look up comeback artists themselves
    const { db, queries } = countingD1(env.DB);
    const hs = await loadHighlights(db, "week", WEEK, TZ, data);
    expect(queries()).toBeLessThanOrEqual(6);

    expect(hs.map((h) => h.kind)).toEqual(["streak", "genreShift", "lateNight", "comebackTrack", "comebackArtist", "binge", "newObsession", "repeatDay"]);
    expect(hs.map((h) => h.score)).toEqual([...hs.map((h) => h.score)].sort((a, b) => b - a));
    expect(find(hs, "lateNight")).toMatchObject({ facts: { plays: 5, sharePct: 33, track: "Comeback", trackPlays: 5 }, subject: { id: "c", artists: "Classic" } });
    expect(find(hs, "repeatDay")?.facts).toEqual({ plays: 5, dayLabel: "Thursday, October 1", track: "Comeback" });
    expect(find(hs, "binge")?.facts).toEqual({ minutes: 150, hours: 2.5, plays: 3, dayLabel: "Saturday, October 3", startLabel: "3 PM" });
    expect(find(hs, "comebackTrack")?.facts).toEqual({ plays: 5, lastHeardLabel: "Jan 2025", yearsAway: 1, track: "Comeback" });
    expect(find(hs, "comebackArtist")?.facts).toEqual({ plays: 5, lastHeardLabel: "Jan 2025", yearsAway: 1, artist: "Classic" });
    expect(find(hs, "genreShift")?.facts).toEqual({ genre: "hyperpop", nowPct: 47, beforePct: 0, deltaPts: 47, previousLabel: "last week" });
    expect(find(hs, "newObsession")?.facts).toEqual({ plays: 7, firstHeardLabel: "Sep 28", track: "New Love" });
    expect(find(hs, "streak")?.facts).toEqual({ days: 7, startLabel: "Sep 28", endLabel: "Oct 4", everyDay: "yes" });
  });

  it("uses the digest's returning artists for a month", async () => {
    await seed([
      { id: "r", name: "Comeback", artist: ["R1", "Returner"], at: [...dates("2024-05", 1, 10).map((d) => local(d, "11:00")), ...dates("2026-09", 2, 4).map((d) => local(d, "11:00"))] },
    ]);
    const period = lastPeriod("month", Date.UTC(2026, 9, 11, 15), TZ);
    const data = (await loadDigest(env.DB, noArt, period, TZ))!;
    const { db, queries } = countingD1(env.DB);
    const hs = await loadHighlights(db, "month", period, TZ, data);
    expect(queries()).toBe(4); // plays, comeback tracks, new obsession, genres; no names needed, artists from data
    expect(hs.map((h) => h.kind)).toEqual(["comebackTrack", "comebackArtist"]);
    expect(find(hs, "comebackArtist")).toMatchObject({ subject: { type: "artist", id: "R1", name: "Returner" }, facts: { plays: 3, lastHeardLabel: "May 2024", yearsAway: 2 } });
  });
});
