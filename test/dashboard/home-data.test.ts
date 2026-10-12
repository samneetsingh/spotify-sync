// loadHome: one db.batch for everything the Home shows, local days across DST and in a +5:30 zone,
// the previous period at the same elapsed point, and the pure helpers (ranges, bars, streak, best day).
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ART_KEY } from "../../src/dashboard/art";
import { bestDay, dayBars, loadHome, localDays, recentDates, soFarRanges, STREAK_DAYS, streak, trendLines, trendSpans, weekDates, type HomeData } from "../../src/dashboard/home-data";
import { migrate } from "../../src/db/schema";
import { setState } from "../../src/db/state";
import { formatDate } from "../../src/utils/time";
import { resetDb } from "../parity/spotify-fixture";
import { seed } from "../jobs/digest-helpers";

const LA = "America/Los_Angeles";
const KOLKATA = "Asia/Kolkata";
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();
const date = (s: string) => {
  const [year, month, day] = s.split("-").map(Number) as [number, number, number];
  return { year, month, day };
};
const playsOf = (bars: Array<{ plays: number }>) => bars.map((b) => b.plays);
const load = (now: number, timeZone = LA) => loadHome(env.DB, { now, timeZone });

/** One song with plays at the given UTC times. */
const playsAt = (id: string, at: string[]) => seed([{ id, name: `Song ${id}`, artist: [`${id}-artist`, `Artist ${id}`], at }]);

beforeAll(() => migrate(env.DB));
beforeEach(() => resetDb(env.DB));

// Wednesday Oct 14 2026, 10:00 PDT. This week from Mon Oct 12; last week so far: Mon Oct 5 to Wed Oct 7 10:00.
const NOW = Date.parse("2026-10-14T17:00:00Z");

const SCENARIO = [
  // On repeat this week; first heard in September, so not new this month.
  { id: "s", name: "Song A", artist: ["A1", "Alpha"] as [string, string], durationMs: 200_000, at: ["2026-09-02T18:00:00Z", "2026-10-12T18:00:00Z", "2026-10-13T18:00:00Z", "2026-10-14T16:00:00Z"] },
  // New this month, before this week.
  { id: "n", name: "New Song", artist: ["N1", "Newbie"] as [string, string], at: ["2026-10-02T18:00:00Z", "2026-10-03T18:00:00Z"] },
  // Last week: Tuesday, then Wednesday 09:00 PDT (before the same point) and 11:00 PDT (after it).
  { id: "p", name: "Prior", artist: ["P1", "Prior"] as [string, string], at: ["2026-10-06T18:00:00Z", "2026-10-07T16:00:00Z", "2026-10-07T18:00:00Z"] },
  // Throwbacks: October 2025 and October 2021; a September 2025 song isn't one.
  { id: "t1", name: "Last Year", artist: ["T1", "Then"] as [string, string], at: ["2025-10-20T18:00:00Z", "2025-10-21T18:00:00Z"] },
  { id: "t2", name: "Long Ago", artist: ["T1", "Then"] as [string, string], at: ["2021-10-05T18:00:00Z"] },
  { id: "x", name: "Not October", artist: ["T1", "Then"] as [string, string], at: ["2025-09-28T18:00:00Z", "2025-09-29T18:00:00Z", "2025-09-30T18:00:00Z"] },
];

async function seedScenario() {
  await seed(SCENARIO);
  await env.DB.prepare(`INSERT INTO artists(artist_id, name, genres) VALUES('A1', 'Alpha', '["indie"]'), ('N1', 'Newbie', '["pop", "indie"]')`).run();
}

describe("loadHome", () => {
  it("reads everything the Home shows", async () => {
    await seedScenario();
    const h = await load(NOW);

    expect([h.now, h.timeZone]).toEqual([NOW, LA]);
    expect(iso(h.week.from)).toBe("2026-10-12T07:00:00.000Z");
    expect(h.week.current).toEqual({ plays: 3, ms: 600_000, newTracks: 0, newArtists: 0 });
    expect(h.week.previous).toEqual({ plays: 2, ms: 0, newTracks: 1, newArtists: 1 }); // Wednesday 11:00 is past the same point
    expect(iso(h.month.from)).toBe("2026-10-01T07:00:00.000Z");
    expect(h.month.current).toEqual({ plays: 8, ms: 600_000, newTracks: 2, newArtists: 2 });
    expect(h.month.previous).toEqual({ plays: 1, ms: 200_000, newTracks: 1, newArtists: 1 }); // Sep 1 to Sep 14 10:00

    expect(h.songOfWeek).toEqual({ track: { id: "s", name: "Song A", artists: "Alpha", plays: 3 }, lastWeek: false });
    expect(h.topTracks.map((t) => [t.id, t.plays])).toEqual([["p", 3], ["s", 3], ["n", 2]]); // a tie goes to the one heard first
    expect(h.topArtists).toEqual([
      { id: "P1", name: "Prior", plays: 3 },
      { id: "A1", name: "Alpha", plays: 3 },
      { id: "N1", name: "Newbie", plays: 2 },
    ]);
    expect(h.genres).toEqual([{ genre: "indie", plays: 5 }, { genre: "pop", plays: 2 }]);
    expect(h.newToYou).toEqual({ plays: 8, repeatPlays: 3, newTracks: 2, newArtists: [{ id: "P1", name: "Prior", plays: 3 }, { id: "N1", name: "Newbie", plays: 2 }] });
    expect(h.throwbacks).toEqual([
      { year: 2025, track: { id: "t1", name: "Last Year", artists: "Then", plays: 2 } },
      { year: 2021, track: { id: "t2", name: "Long Ago", artists: "Then", plays: 1 } },
    ]);

    expect(h.days.week.map((b) => b.date)).toEqual(["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17", "2026-10-18"]);
    expect(playsOf(h.days.week)).toEqual([1, 1, 1, 0, 0, 0, 0]);
    expect(h.days.week.map((b) => b.future)).toEqual([false, false, false, true, true, true, true]);
    // The listening lines. Week: only this year (the same weeks in earlier years have no plays), the
    // days after today still to come.
    expect(h.trends.week.x).toEqual(h.days.week.map((b) => b.date));
    expect(h.trends.week.lines).toEqual([{ year: 2026, plays: [1, 1, 1, null, null, null, null] }]);
    // The last 30 days (Sep 15 to Oct 14; the Sep 2 play is before it) and the same dates in 2025.
    expect([h.trends.month.x.length, h.trends.month.x[0], h.trends.month.x.at(-1)]).toEqual([30, "2026-09-15", "2026-10-14"]);
    const monthPlays = (k: number) => h.trends.month.x.flatMap((d, i) => (h.trends.month.lines[k]!.plays[i] ? [[d.slice(5), h.trends.month.lines[k]!.plays[i]]] : []));
    expect(h.trends.month.lines.map((l) => l.year)).toEqual([2026, 2025]);
    expect(monthPlays(0)).toEqual([["10-02", 1], ["10-03", 1], ["10-06", 1], ["10-07", 2], ["10-12", 1], ["10-13", 1], ["10-14", 1]]);
    expect(monthPlays(1)).toEqual([["09-28", 1], ["09-29", 1], ["09-30", 1]]); // 2025's plays on the same dates
    // The calendar year: 2026 so far (November and December to come) and 2025; earlier years have nothing.
    expect(h.trends.year.x).toEqual(["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10", "2026-11", "2026-12"]);
    expect(h.trends.year.lines).toEqual([
      { year: 2026, plays: [0, 0, 0, 0, 0, 0, 0, 0, 1, 8, null, null] },
      { year: 2025, plays: [0, 0, 0, 0, 0, 0, 0, 0, 3, 2, 0, 0] },
    ]);
    expect(h.anyPlays).toBe(true);
    expect(h.streak).toBe(3);
    expect(h.bestDay).toEqual({ date: "2026-10-07", plays: 2 });

    // The last 28 local days: Sep 17 to Oct 14 (the Sep 2 play is outside). 18:00Z is 11 AM PDT.
    expect([h.hours.from, h.hours.to]).toEqual(["2026-09-17", "2026-10-14"]);
    expect(h.hours.grid).toHaveLength(7);
    expect(h.hours.grid.every((row) => row.length === 24)).toBe(true);
    expect(h.hours.grid.flat().reduce((a, b) => a + b, 0)).toBe(8);
    expect(h.hours.grid[0]![11]).toBe(1); // Monday Oct 12, 11 AM
    expect(h.hours.grid[2]![9]).toBe(2); // Wednesdays at 9 AM: Oct 7 and Oct 14
  });

  it("reads the status and the art cache, never the token's value", async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO sync_runs(started_at, finished_at, status, plays_fetched) VALUES('2026-10-14 16:40:00', '2026-10-14 16:40:05', 'success', 4)"),
      env.DB.prepare("INSERT INTO sync_runs(started_at, finished_at, status, error) VALUES('2026-10-14 16:50:00', '2026-10-14 16:50:02', 'fail', 'boom')"),
      env.DB.prepare("INSERT INTO state(key, value) VALUES('alert_failing:sync', ?1), ('alert_failing:weekly-digest', ?2), ('alert_failingX', 'not a failure')")
        .bind(JSON.stringify({ since: NOW - 600_000, failures: 2, lastError: "boom" }), JSON.stringify({ since: NOW - DAY })),
    ]);
    await setState(env.DB, ART_KEY, JSON.stringify({ at: NOW - DAY, art: { s: "https://i.scdn.co/image/s", n: "", bad: "javascript:alert(1)" } }));

    const h = await load(NOW);
    expect(h.status.connected).toBe(true);
    expect(h.status.lastRun).toMatchObject({ status: "fail", error: "boom", startedAt: Date.parse("2026-10-14T16:50:00Z") });
    expect(h.status.lastSuccess).toMatchObject({ status: "success", playsFetched: 4 });
    expect(h.status.failing).toEqual([
      { job: "weekly-digest", since: NOW - DAY, failures: 1, lastError: null },
      { job: "sync", since: NOW - 600_000, failures: 2, lastError: "boom" },
    ]);
    expect(h.art).toEqual({ s: "https://i.scdn.co/image/s", n: "" });
    expect(JSON.stringify(h)).not.toContain("test-refresh");

    // Not connected, a stale art cache.
    await env.DB.batch([
      env.DB.prepare("DELETE FROM state WHERE key = 'spotify_refresh_token'"),
      env.DB.prepare("UPDATE state SET value = ?1 WHERE key = ?2").bind(JSON.stringify({ at: NOW - 8 * DAY, art: { s: "https://i.scdn.co/image/s" } }), ART_KEY),
    ]);
    const after = await load(NOW);
    expect(after.status.connected).toBe(false);
    expect(after.art).toEqual({});
  });

  it("is one db.batch and no other query, with a handful of bound parameters per statement", async () => {
    await seedScenario();
    const batches: number[] = [];
    const binds: number[] = [];
    let single = 0;
    const watch = (stmt: D1PreparedStatement): D1PreparedStatement => {
      const s = stmt as unknown as Record<string, (...args: unknown[]) => unknown>;
      const bind = s.bind!.bind(stmt);
      s.bind = (...args) => (binds.push(args.length), watch(bind(...args) as D1PreparedStatement));
      for (const m of ["first", "all", "run", "raw"]) {
        const f = s[m]!.bind(stmt);
        s[m] = (...args) => (single++, f(...args));
      }
      return stmt;
    };
    const db = {
      prepare: (sql: string) => watch(env.DB.prepare(sql)),
      batch: (stmts: D1PreparedStatement[]) => (batches.push(stmts.length), env.DB.batch(stmts)),
    } as unknown as D1Database;

    const h = await loadHome(db, { now: NOW, timeZone: LA });
    expect(h.month.current.plays).toBe(8);
    expect(batches).toEqual([27]);
    expect(single).toBe(0);
    expect(binds.length).toBe(25); // every statement but the two sync_runs reads
    expect(Math.max(...binds)).toBeLessThanOrEqual(7);
    await db.prepare("SELECT 1").first(); // the watcher does see a query outside the batch
    expect(single).toBe(1);
  });

  it("is all zeros and empty lists on an instance without plays", async () => {
    await env.DB.prepare("DELETE FROM state").run();
    const h: HomeData = await load(NOW);
    const zero = { plays: 0, ms: 0, newTracks: 0, newArtists: 0 };
    expect(h.week).toEqual({ from: Date.parse("2026-10-12T07:00:00Z"), current: zero, previous: zero });
    expect(h.month).toEqual({ from: Date.parse("2026-10-01T07:00:00Z"), current: zero, previous: zero });
    expect(h.status).toEqual({ connected: false, lastRun: null, lastSuccess: null, failing: [] });
    expect(h.songOfWeek).toBeNull();
    expect([h.topTracks, h.topArtists, h.genres, h.throwbacks]).toEqual([[], [], [], []]);
    expect(h.newToYou).toEqual({ plays: 0, repeatPlays: 0, newTracks: 0, newArtists: [] });
    expect(h.streak).toBe(0);
    expect(h.bestDay).toBeNull();
    expect(playsOf(h.days.week)).toEqual(Array(7).fill(0));
    expect(h.trends.month.lines).toEqual([{ year: 2026, plays: Array(30).fill(0) }]);
    expect(h.trends.year.lines).toEqual([{ year: 2026, plays: [...Array(10).fill(0), null, null] }]);
    expect(h.anyPlays).toBe(false);
    expect(h.hours.grid).toEqual(Array.from({ length: 7 }, () => Array(24).fill(0)));
    expect(h.art).toEqual({});
  });

  it("counts a week across the end of DST in local days and hours (Los Angeles)", async () => {
    // Mon Oct 26 to Sun Nov 1 2026; clocks fall back at 2 AM on Sunday. Now: Sunday 23:45 PST.
    await playsAt("w", [
      "2026-10-26T06:30:00Z", // Sun Oct 25 23:30 PDT: last week
      "2026-10-26T07:30:00Z", // Mon Oct 26 00:30 PDT
      "2026-11-01T08:30:00Z", // Sun 01:30 PDT
      "2026-11-01T09:30:00Z", // Sun 01:30 PST, an hour later
      "2026-11-02T07:40:00Z", // Sun 23:40 PST (one fixed PDT offset would make it Monday)
    ]);
    const h = await load(Date.parse("2026-11-02T07:45:00Z"));
    expect(iso(h.week.from)).toBe("2026-10-26T07:00:00.000Z");
    expect(h.week.current.plays).toBe(4);
    expect(h.week.previous.plays).toBe(1); // the whole of last week: 24h45m into Sunday is past its end
    expect(h.days.week.map((b) => [b.date, b.plays, b.future])).toEqual([
      ["2026-10-26", 1, false], ["2026-10-27", 0, false], ["2026-10-28", 0, false], ["2026-10-29", 0, false],
      ["2026-10-30", 0, false], ["2026-10-31", 0, false], ["2026-11-01", 3, false],
    ]);
    expect(h.streak).toBe(1);
    expect(h.hours.grid[0]![0]).toBe(1);
    expect(h.hours.grid[6]![1]).toBe(2); // both 1:30s
    expect(h.hours.grid[6]![23]).toBe(2); // Sunday Oct 25 23:30 PDT and Sunday Nov 1 23:40 PST
  });

  it("uses local days in a +5:30 zone (Kolkata)", async () => {
    await playsAt("k", [
      "2026-09-30T18:29:00Z", // Wed Sep 30 23:59 IST
      "2026-09-30T18:31:00Z", // Thu Oct 1 00:01 IST
      "2026-10-11T18:20:00Z", // Sun Oct 11 23:50 IST: last week
      "2026-10-11T18:40:00Z", // Mon Oct 12 00:10 IST
      "2026-10-13T20:00:00Z", // Wed Oct 14 01:30 IST
    ]);
    const h = await load(Date.parse("2026-10-14T06:00:00Z"), KOLKATA); // Wed Oct 14 11:30 IST
    expect(iso(h.week.from)).toBe("2026-10-11T18:30:00.000Z");
    expect(iso(h.month.from)).toBe("2026-09-30T18:30:00.000Z");
    expect(h.week.current.plays).toBe(2);
    expect(h.month.current.plays).toBe(4);
    expect(playsOf(h.days.week)).toEqual([1, 0, 1, 0, 0, 0, 0]);
    expect(h.days.week.map((b) => b.future)).toEqual([false, false, false, true, true, true, true]);
    expect(h.trends.month.x.filter((_, i) => h.trends.month.lines[0]!.plays[i])).toEqual(["2026-09-30", "2026-10-01", "2026-10-11", "2026-10-12", "2026-10-14"]);
    expect(h.trends.year.lines[0]!.plays.slice(8, 10)).toEqual([1, 4]); // September, October (IST)
    expect(h.streak).toBe(1);
    expect(h.hours.grid[0]![0]).toBe(1); // Monday 00:10
    expect(h.hours.grid[2]![1]).toBe(1); // Wednesday 01:30
    expect(h.hours.grid[2]![23]).toBe(1); // Wednesday Sep 30 23:59
    expect(h.hours.grid[3]![0]).toBe(1); // Thursday Oct 1 00:01
    expect(h.hours.grid[6]![23]).toBe(1); // Sunday 23:50
  });

  it("falls back to last week's top song while this week has no plays (Monday morning)", async () => {
    await playsAt("a", ["2026-10-06T18:00:00Z", "2026-10-08T18:00:00Z"]);
    await playsAt("b", ["2026-10-09T18:00:00Z"]);
    const monday = Date.parse("2026-10-12T16:00:00Z"); // Mon Oct 12 09:00 PDT
    expect((await load(monday)).songOfWeek).toEqual({ track: { id: "a", name: "Song a", artists: "Artist a", plays: 2 }, lastWeek: true });

    await env.DB.prepare("INSERT INTO plays(played_at_ms, track_id, track_uri, source) VALUES(?1, 'b', 'spotify:track:b', 'test')").bind(Date.parse("2026-10-12T15:30:00Z")).run();
    expect((await load(monday)).songOfWeek).toEqual({ track: { id: "b", name: "Song b", artists: "Artist b", plays: 1 }, lastWeek: false });
  });

  it("counts the streak to today, or to yesterday while today has no plays", async () => {
    // NOW is Wed Oct 14 (PDT); 18:00Z is 11 AM.
    await playsAt("y", ["2026-10-10T18:00:00Z", "2026-10-11T18:00:00Z", "2026-10-12T18:00:00Z", "2026-10-13T18:00:00Z"]);
    expect((await load(NOW)).streak).toBe(4); // Oct 10-13, none yet today
    await env.DB.prepare("DELETE FROM plays WHERE played_at_ms = ?1").bind(Date.parse("2026-10-12T18:00:00Z")).run();
    expect((await load(NOW)).streak).toBe(1); // a gap on Oct 12: only yesterday
    await playsAt("z", ["2026-10-14T16:00:00Z"]);
    expect((await load(NOW)).streak).toBe(2); // today and yesterday
    await env.DB.prepare("DELETE FROM plays WHERE played_at_ms = ?1").bind(Date.parse("2026-10-13T18:00:00Z")).run();
    expect((await load(NOW)).streak).toBe(1); // today only
  });

  it("counts a streak longer than the year chart, up to STREAK_DAYS (a rolling window, not month-aligned)", async () => {
    // One play a day at 11 AM PDT/PST for the 420 days up to today (Oct 14): longer than the window.
    const day = (i: number) => new Date(NOW - i * 86_400_000).toISOString();
    await playsAt("long", Array.from({ length: 420 }, (_, i) => day(i)));
    expect((await load(NOW)).streak).toBe(STREAK_DAYS);
    // A gap 380 days ago: the streak (379 days) reaches back past Nov 1, 2025, where the year chart starts.
    await env.DB.prepare("DELETE FROM plays WHERE played_at_ms = ?1").bind(Date.parse(day(379))).run();
    expect((await load(NOW)).streak).toBe(379);
  });

  it("finds the best day of this calendar year only", async () => {
    await playsAt("b", [
      ...Array.from({ length: 5 }, (_, i) => `2025-12-20T${18 + i}:00:00Z`), // last year's busiest day
      ...["18", "19", "20"].map((h) => `2026-01-05T${h}:00:00Z`),
      ...["18", "19", "20"].map((h) => `2026-02-10T${h}:00:00Z`),
    ]);
    const h = await load(Date.parse("2026-03-15T19:00:00Z"));
    expect(h.bestDay).toEqual({ date: "2026-01-05", plays: 3 }); // the earlier of two equal days
    expect(h.trends.year.lines[0]!.plays.slice(0, 2)).toEqual([3, 3]); // Jan, Feb
    expect(h.trends.year.lines[1]!.plays[11]).toBe(5); // last December, on 2025's line
  });

  it("takes throwbacks from the whole calendar month in local time", async () => {
    await playsAt("c", ["2025-11-01T06:30:00Z"]); // Fri Oct 31 2025 23:30 PDT
    await playsAt("e", ["2025-11-01T07:30:00Z", "2025-11-01T08:00:00Z"]); // Nov 1 2025, 00:30 and 01:00 PDT
    await playsAt("f", ["2021-10-01T07:00:00Z"]); // Oct 1 2021 00:00 PDT
    const h = await load(NOW);
    expect(h.throwbacks.map((t) => [t.year, t.track.id, t.track.plays])).toEqual([[2025, "c", 1], [2021, "f", 1]]);
  });

  it("compares with the previous week and month up to the same point", async () => {
    // Wed Nov 4 2026 10:00 PST; last Wednesday 10:00 was still PDT.
    await playsAt("q", ["2026-10-28T16:59:00Z", "2026-10-28T17:00:00Z", "2026-11-02T09:00:00Z"]);
    const h = await load(Date.parse("2026-11-04T18:00:00Z"));
    expect(h.week.previous.plays).toBe(1); // 09:59 PDT counts, 10:00 doesn't
    expect(h.week.current.plays).toBe(1);
  });
});

describe("soFarRanges", () => {
  const ranges = (isoNow: string, tz = LA) => {
    const r = soFarRanges(Date.parse(isoNow), tz);
    return { week: [r.week.from, r.week.to, r.week.prevFrom, r.week.prevTo].map(iso), month: [r.month.from, r.month.to, r.month.prevFrom, r.month.prevTo].map(iso) };
  };

  it("ends the previous week at the same weekday and local time, across DST", () => {
    // Wed Nov 4 10:00 PST vs Wed Oct 28 10:00 PDT.
    expect(ranges("2026-11-04T18:00:00Z").week).toEqual(["2026-11-02T08:00:00.000Z", "2026-11-04T18:00:00.000Z", "2026-10-26T07:00:00.000Z", "2026-10-28T17:00:00.000Z"]);
    // Monday 00:00 exactly: nothing yet, and nothing of last week either.
    const monday = ranges("2026-10-12T07:00:00Z").week;
    expect(monday[0]).toBe(monday[1]);
    expect(monday[2]).toBe(monday[3]);
  });

  it("ends the previous month on the same day of the month, or at its end", () => {
    // Oct 10 10:00 PDT vs Sep 10 10:00 PDT.
    expect(ranges("2026-10-10T17:00:00Z").month).toEqual(["2026-10-01T07:00:00.000Z", "2026-10-10T17:00:00.000Z", "2026-09-01T07:00:00.000Z", "2026-09-10T17:00:00.000Z"]);
    // Mar 31 10:00 PDT: February has no 31st, so all of it (Feb 1 PST to Mar 1 PST).
    expect(ranges("2026-03-31T17:00:00Z").month).toEqual(["2026-03-01T08:00:00.000Z", "2026-03-31T17:00:00.000Z", "2026-02-01T08:00:00.000Z", "2026-03-01T08:00:00.000Z"]);
    // Oct 31: all of September.
    expect(ranges("2026-10-31T17:00:00Z").month.slice(2)).toEqual(["2026-09-01T07:00:00.000Z", "2026-10-01T07:00:00.000Z"]);
    // Mar 1 10:00 PST vs Feb 1 10:00 PST.
    expect(ranges("2026-03-01T18:00:00Z").month.slice(2)).toEqual(["2026-02-01T08:00:00.000Z", "2026-02-01T18:00:00.000Z"]);
  });

  it("uses local midnights in a +5:30 zone", () => {
    expect(ranges("2026-10-14T06:00:00Z", KOLKATA).week).toEqual(["2026-10-11T18:30:00.000Z", "2026-10-14T06:00:00.000Z", "2026-10-04T18:30:00.000Z", "2026-10-07T06:00:00.000Z"]);
  });
});

describe("day helpers", () => {
  it("lists days, weeks and months", () => {
    expect(localDays(date("2025-12-30"), date("2026-01-02")).map((d) => d.day)).toEqual([30, 31, 1, 2]);
    expect(localDays(date("2026-01-02"), date("2026-01-01"))).toEqual([]);
    expect(weekDates(date("2026-11-01")).map((d) => `${d.month}/${d.day}`)).toEqual(["10/26", "10/27", "10/28", "10/29", "10/30", "10/31", "11/1"]); // a Sunday
    expect(weekDates(date("2026-10-12"))[0]).toEqual(date("2026-10-12")); // a Monday
    const recent = recentDates(date("2028-03-10")).map((d) => `${d.month}/${d.day}`);
    expect([recent.length, recent[0], recent.at(-1)]).toEqual([30, "2/10", "3/10"]); // across a leap February
  });

  it("flags future days and fills missing ones with zero", () => {
    const daily = [{ date: date("2026-10-13"), plays: 4 }, { date: date("2026-10-14"), plays: 1 }];
    expect(dayBars(daily, localDays(date("2026-10-13"), date("2026-10-16")), date("2026-10-14"))).toEqual([
      { date: "2026-10-13", plays: 4, future: false },
      { date: "2026-10-14", plays: 1, future: false },
      { date: "2026-10-15", plays: 0, future: true },
      { date: "2026-10-16", plays: 0, future: true },
    ]);
  });

  it("lines the listening charts up by weekday (week), by date (month) and by month (year), five years deep", () => {
    const spans = trendSpans(date("2028-03-01")); // a Wednesday in a leap year
    const first = (k: number, chart: keyof typeof spans) => formatDate(spans[chart].spans[k]![0]![0]);
    expect(spans.week.spans).toHaveLength(5);
    expect([first(0, "week"), first(1, "week"), first(4, "week")]).toEqual(["2028-02-28", "2027-03-01", "2024-03-04"]); // Mondays, 364 days apart
    expect(spans.month.x[0]).toBe("2028-02-01");
    const feb29 = spans.month.x.indexOf("2028-02-29");
    expect(formatDate(spans.month.spans[1]![feb29]![0])).toBe("2027-02-28"); // no Feb 29 in 2027
    expect(formatDate(spans.month.spans[4]![feb29]![0])).toBe("2024-02-29"); // 2024 has one
    expect(spans.year.spans[4]!.map(([from]) => formatDate(from).slice(0, 7))[0]).toBe("2024-01");
    expect(formatDate(spans.year.spans[0]![11]![1])).toBe("2029-01-01"); // December ends on Jan 1
  });

  it("makes lines from counts: this year's later points are null, an earlier year without plays is left out", () => {
    const today = date("2026-10-14");
    const spans = trendSpans(today).year.spans;
    const counts = spans.flatMap((year, k) => year.map((_, m) => (k === 2 ? 0 : m + 1)));
    const lines = trendLines(spans, counts, today);
    expect(lines.map((l) => l.year)).toEqual([2026, 2025, 2023, 2022]); // 2024 had nothing
    expect(lines[0]!.plays).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, null, null]);
    expect(lines[1]!.plays.at(-1)).toBe(12);
    expect(trendLines(spans, spans.flat().map(() => 0), today)).toEqual([{ year: 2026, plays: [...Array(10).fill(0), null, null] }]); // this year always shows
  });

  it("counts streaks ending today or yesterday", () => {
    expect(streak([])).toBe(0);
    expect(streak([0])).toBe(0);
    expect(streak([1])).toBe(1);
    expect(streak([3, 1, 2])).toBe(3); // today has plays
    expect(streak([1, 1, 0])).toBe(2); // only yesterday so far
    expect(streak([1, 0, 1])).toBe(1); // a gap
    expect(streak([1, 0, 0])).toBe(0);
    expect(streak([0, 2, 0, 3, 4, 0])).toBe(2);
  });

  it("finds the best day of a year: the earliest of equals, none without plays", () => {
    const daily = [
      { date: date("2025-12-31"), plays: 9 },
      { date: date("2026-01-01"), plays: 2 },
      { date: date("2026-03-01"), plays: 4 },
      { date: date("2026-04-01"), plays: 4 },
    ];
    expect(bestDay(daily, 2026)).toEqual({ date: "2026-03-01", plays: 4 });
    expect(bestDay(daily, 2025)).toEqual({ date: "2025-12-31", plays: 9 });
    expect(bestDay([{ date: date("2026-01-01"), plays: 0 }], 2026)).toBeNull();
  });
});
