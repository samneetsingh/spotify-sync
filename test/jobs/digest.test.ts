import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AlertConfig } from "../../src/alerts";
import { loadConfig, type Config } from "../../src/config";
import type { Env, WriteMode } from "../../src/env";
import { getState, setState } from "../../src/db/state";
import { migrate } from "../../src/db/schema";
import {
  bucket,
  lastPeriod,
  pickImage,
  renderDigest,
  runMonthlyRecap,
  runWeeklyDigest,
  type ArtSource,
  type DigestData,
} from "../../src/jobs/digest";
import { addDays } from "../../src/utils/time";
import { resetDb } from "../parity/spotify-fixture";

const OCT_11 = Date.UTC(2026, 9, 11, 15); // recaps September 2026 (Los Angeles)
const OCT_7 = Date.UTC(2026, 9, 7, 15); // a Wednesday: the last full week is Sep 28 - Oct 4
const TZ = "America/Los_Angeles";

type Sent = { subject: string; text: string; html?: string };

function fakeEmail(opts: { fail?: boolean; publicUrl?: string } = {}) {
  const sent: Sent[] = [];
  const binding = {
    async send(msg: Sent) {
      if (opts.fail) throw new Error("boom");
      sent.push(msg);
      return { messageId: `m${sent.length}` };
    },
  } as unknown as SendEmail;
  return { sent, cfg: { binding, from: "spotify-sync@example.com", to: "me@example.com", timeZone: TZ, publicUrl: opts.publicUrl } as AlertConfig };
}

/** Spotify art lookups: 640/300/64 album covers and 640/320/160 artist photos, or an error. */
function artSource(opts: { fail?: boolean } = {}) {
  const calls: string[] = [];
  const images = (id: string, sizes: number[]) => sizes.map((w) => ({ url: `https://i.test/${id}-${w}`, width: w }));
  const sp = {
    async getTracks(ids: string[]) {
      calls.push(`tracks:${ids.join(",")}`);
      if (opts.fail) throw new Error("Token refresh failed: 400 invalid_grant");
      return { tracks: ids.map((id) => ({ id, album: { images: images(id, [640, 300, 64]) } })) };
    },
    async getArtists(ids: string[]) {
      calls.push(`artists:${ids.join(",")}`);
      if (opts.fail) throw new Error("Token refresh failed: 400 invalid_grant");
      return { artists: ids.map((id) => ({ id, images: images(id, [640, 320, 160]) })) };
    },
  } as unknown as ArtSource;
  return { sp, calls };
}

const config = (mode: WriteMode = "live"): Config =>
  loadConfig({ SPOTIFY_ALL_PLAYLIST_ID: "all1", WRITE_MODE: mode, TIME_ZONE: TZ } as Env);

/** One track per row, credited to one artist, played at the given UTC times. */
async function seed(rows: Array<{ id: string; name: string; artist: [string, string]; at: string[]; durationMs?: number }>) {
  await env.DB.batch(
    rows.flatMap(({ id, name, artist, at, durationMs }) => [
      env.DB.prepare("INSERT INTO tracks(track_id, track_uri, name, artists, duration_ms) VALUES(?1, 'spotify:track:' || ?1, ?2, ?3, ?4)").bind(id, name, artist[1], durationMs ?? null),
      env.DB.prepare("INSERT OR IGNORE INTO track_artists(track_id, artist_id, artist_name, position) VALUES(?1, ?2, ?3, 0)").bind(id, artist[0], artist[1]),
      ...at.map((iso) =>
        env.DB.prepare("INSERT INTO plays(played_at_ms, track_id, track_uri, source) VALUES(?1, ?2, 'spotify:track:' || ?2, 'history_import')").bind(Date.parse(iso), id),
      ),
    ]),
  );
}

const days = (prefix: string, from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => `${prefix}-${String(from + i).padStart(2, "0")}T18:00:00Z`);

const SEPTEMBER = [
  {
    id: "a",
    name: "Tom & Jerry <Live>",
    artist: ["A1", "Alpha"] as [string, string],
    durationMs: 3_600_000,
    at: ["2026-08-20T18:00:00Z", "2026-09-13T18:00:00Z", "2026-09-13T19:00:00Z", "2026-09-13T20:00:00Z", "2026-09-20T18:00:00Z"],
  },
  { id: "n", name: "Fresh Song", artist: ["N1", "Newbie"] as [string, string], at: ["2026-09-05T18:00:00Z", "2026-09-06T18:00:00Z"] },
  { id: "r", name: "Comeback", artist: ["R1", "Returner"] as [string, string], at: [...days("2024-05", 1, 10), ...days("2026-09", 2, 4)] },
  { id: "o", name: "Old Gold", artist: ["A1", "Alpha"] as [string, string], at: ["2025-09-10T18:00:00Z", "2025-09-10T19:00:00Z"] },
];

beforeAll(() => migrate(env.DB));
beforeEach(() => resetDb(env.DB));

describe("monthly recap", () => {
  it("emails last month's recap once", async () => {
    await seed(SEPTEMBER);
    await env.DB.prepare("INSERT INTO artists(artist_id, name, genres) VALUES('A1', 'Alpha', '[\"dream pop\", \"shoegaze\"]')").run();
    const { sent, cfg } = fakeEmail();
    const { sp, calls } = artSource();
    expect(await runMonthlyRecap(config(), env.DB, sp, cfg, OCT_11)).toEqual({ period: "2026-09", sent: true });
    expect(await getState(env.DB, "recap:last_month")).toBe("2026-09");

    const [email] = sent;
    expect(email!.subject).toBe("Your September 2026 in music: 9 plays");
    const text = email!.text;
    expect(text).toContain("4 hours · 3 tracks · 3 artists");
    expect(text).toContain("Song of the month: Tom & Jerry <Live> by Alpha (4 plays)");
    expect(text).toContain("2. Comeback — Returner (3 plays)");
    expect(text).toContain("1. Alpha (4 plays)");
    expect(text).toContain("dream pop (4 plays)");
    expect(text).toContain("Your biggest day was Sunday, September 13, with 3 plays.");
    expect(text).toContain("You listen most on Sundays around 11 AM."); // 18:00Z = 11 AM PDT
    expect(text).toContain("1 track you'd never played before");
    expect(text).toContain("Newbie (first listen, 2 plays)");
    expect(text).toContain("Returner (3 plays, first since May 2024)");
    expect(text).toContain("September 2025: Old Gold — Alpha (your top song that month, 2 plays)");

    const html = email!.html!;
    expect(html).toContain('<a href="https://open.spotify.com/track/a"');
    expect(html).toContain("Tom &amp; Jerry &lt;Live&gt;");
    expect(html).not.toContain("<Live>");
    expect(html).toContain("https://i.test/a-300"); // the 300px cover, not 640 or 64
    expect(html).toContain("https://i.test/A1-320");
    expect(html).toContain("78% old favorites"); // 7 of 9 plays were tracks heard before
    expect(html.length).toBeLessThan(100_000); // Gmail clips at 102 KB
    expect(calls).toEqual(["tracks:a,r,n,o", "artists:A1,R1,N1"]);

    expect(await runMonthlyRecap(config(), env.DB, sp, cfg, OCT_11)).toBeNull();
    expect(sent).toHaveLength(1);
  });

  it("still sends, with placeholder art, when Spotify is unreachable", async () => {
    await seed(SEPTEMBER);
    const { sent, cfg } = fakeEmail();
    expect(await runMonthlyRecap(config(), env.DB, artSource({ fail: true }).sp, cfg, OCT_11)).toEqual({ period: "2026-09", sent: true });
    expect(sent[0]!.html).toContain("&#9834;");
    expect(sent[0]!.html).not.toContain("i.test");
  });

  it("fails the job when sending fails (so it alerts), and retries the next day", async () => {
    await seed(SEPTEMBER);
    const { sp } = artSource();
    const broken = fakeEmail({ fail: true });
    await expect(runMonthlyRecap(config(), env.DB, sp, broken.cfg, OCT_11)).rejects.toThrow(/2026-09 recap email could not be sent/);
    expect(await getState(env.DB, "recap:last_month")).toBeNull();

    const ok = fakeEmail();
    expect(await runMonthlyRecap(config(), env.DB, sp, ok.cfg, OCT_11 + 86_400_000)).toEqual({ period: "2026-09", sent: true });
  });

  it("quietly skips sending when email isn't configured", async () => {
    await seed(SEPTEMBER);
    expect(await runMonthlyRecap(config(), env.DB, artSource().sp, {}, OCT_11)).toEqual({ period: "2026-09", sent: false });
  });

  it("counts the busiest day in local time across a DST change", async () => {
    // Nov 30 23:30 PST is Dec 1 07:30 UTC; one fixed November offset (PDT) would call it Dec 1.
    await seed([{ id: "x", name: "Late", artist: ["X1", "Night Owl"], at: ["2026-12-01T07:30:00Z", "2026-12-01T07:40:00Z", "2026-11-15T20:00:00Z"] }]);
    const { sent, cfg } = fakeEmail();
    await runMonthlyRecap(config(), env.DB, artSource().sp, cfg, Date.UTC(2026, 11, 2, 15));
    expect(sent[0]!.text).toContain("Your biggest day was Monday, November 30, with 2 plays.");
  });

  it("only sends in live mode", async () => {
    await seed(SEPTEMBER);
    const { sent, cfg } = fakeEmail();
    expect(await runMonthlyRecap(config("dry_run"), env.DB, artSource().sp, cfg, OCT_11)).toEqual({ period: "2026-09", sent: false });
    expect(sent).toEqual([]);
    expect(await getState(env.DB, "recap:last_month")).toBeNull();
  });

  it("skips a month without plays (and doesn't ask Spotify for art)", async () => {
    const { sent, cfg } = fakeEmail();
    const { sp, calls } = artSource();
    expect(await runMonthlyRecap(config(), env.DB, sp, cfg, OCT_11)).toBeNull();
    expect(sent).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("shows the record on phones when the Worker has a public URL, and links the owned playlists", async () => {
    await seed(SEPTEMBER);
    await setState(env.DB, "playlist:on_this_day", "otd1");
    await setState(env.DB, "playlist:forgotten_favorites", "off");
    await setState(env.DB, "playlist:holiday", "would-create:Holiday Favorites");
    const { sent, cfg } = fakeEmail({ publicUrl: "https://sync.test/" });
    await runMonthlyRecap(config(), env.DB, artSource().sp, cfg, OCT_11);
    const html = sent[0]!.html!;
    expect(html).toContain('src="https://sync.test/email/vinyl.png?v=1"');
    expect(html).toContain("url('https://i.test/a-300')");
    expect(html).toContain('href="https://open.spotify.com/playlist/otd1"');
    expect(html).not.toContain("Forgotten Favorites");
    expect(html).not.toContain("Holiday Favorites");
    expect(sent[0]!.text).toContain("Still updating in your library: On This Day.");
  });
});

describe("weekly digest", () => {
  // Week of Sep 28 (Mon) - Oct 4 (Sun), Los Angeles; the week before has 4 plays.
  const WEEK = [
    { id: "w", name: "This Week", artist: ["W1", "Weekly"] as [string, string], at: ["2026-09-28T18:00:00Z", "2026-10-02T18:00:00Z", "2026-10-03T04:30:00Z"] },
    { id: "p", name: "Last Week", artist: ["P1", "Prior"] as [string, string], at: ["2026-09-21T18:00:00Z", "2026-09-22T18:00:00Z", "2026-09-23T18:00:00Z", "2026-09-24T18:00:00Z"] },
    { id: "l", name: "Too Late", artist: ["L1", "Later"] as [string, string], at: ["2026-10-05T08:00:00Z"] }, // Oct 5 01:00 PDT: next week
  ];

  it("emails last week's digest once, with changes from the week before", async () => {
    await seed(WEEK);
    const { sent, cfg } = fakeEmail();
    expect(await runWeeklyDigest(config(), env.DB, artSource().sp, cfg, OCT_7)).toEqual({ period: "2026-W40", sent: true });
    expect(await getState(env.DB, "recap:last_week")).toBe("2026-W40");

    const { subject, text } = sent[0]!;
    expect(subject).toBe("Your week in music, Sep 28 to Oct 4: 3 plays");
    expect(text).toContain("3 plays, 25% less than last week.");
    expect(text).toContain("3 plays (-25%)");
    expect(text).toContain("1 new tracks (+0%)");
    expect(text).toContain("Friday was your biggest day, with 2 plays."); // Oct 3 04:30Z is Friday 9:30 PM PDT
    expect(text).toContain("Your peak hour was 11 AM.");
    expect(text).not.toContain("Too Late");
    expect(text).not.toContain("Your year");

    expect(await runWeeklyDigest(config(), env.DB, artSource().sp, cfg, OCT_7 + 86_400_000)).toBeNull();
    expect(sent).toHaveLength(1);
  });

  it("sends the next week once it is over", async () => {
    await seed(WEEK);
    await setState(env.DB, "recap:last_week", "2026-W40");
    const { sent, cfg } = fakeEmail();
    expect(await runWeeklyDigest(config(), env.DB, artSource().sp, cfg, Date.UTC(2026, 9, 12, 15))).toEqual({ period: "2026-W41", sent: true });
    expect(sent[0]!.subject).toBe("Your week in music, Oct 5 to Oct 11: 1 play");
  });

  it("skips a week without plays", async () => {
    const { sent, cfg } = fakeEmail();
    expect(await runWeeklyDigest(config(), env.DB, artSource().sp, cfg, OCT_7)).toBeNull();
    expect(sent).toEqual([]);
  });
});

describe("periods and buckets", () => {
  it("finds the last full week and month in local time", () => {
    // Monday Oct 12 06:00 UTC is still Sunday Oct 11 in Los Angeles.
    expect(lastPeriod("week", Date.UTC(2026, 9, 12, 6), TZ)).toMatchObject({ start: { year: 2026, month: 9, day: 28 }, key: "2026-W40" });
    expect(lastPeriod("week", Date.UTC(2026, 9, 12, 8), TZ)).toMatchObject({ start: { year: 2026, month: 10, day: 5 }, key: "2026-W41" });
    expect(lastPeriod("month", Date.UTC(2027, 0, 1, 9), TZ)).toMatchObject({ start: { year: 2026, month: 12, day: 1 }, end: { year: 2027, month: 1, day: 1 }, key: "2026-12" });
  });

  it("puts plays in their local hour on a 25-hour DST day", () => {
    const start = { year: 2026, month: 11, day: 1 }; // Sunday; clocks fall back at 2 AM
    const times = ["2026-11-01T08:30:00Z", "2026-11-01T09:30:00Z", "2026-11-01T20:00:00Z", "2026-11-02T20:00:00Z"].map(Date.parse);
    const { days, hours } = bucket(times, [start, addDays(start, 1)], TZ);
    expect(days).toEqual([3, 1]);
    expect(hours[6]![1]).toBe(2); // 1:30 PDT and 1:30 PST
    expect(hours[6]![12]).toBe(1); // 20:00Z = noon PST
    expect(hours[0]![12]).toBe(1); // Monday
  });

  it("picks the smallest image that is at least 300px", () => {
    expect(pickImage([{ url: "big", width: 640 }, { url: "mid", width: 300 }, { url: "small", width: 64 }])).toBe("mid");
    expect(pickImage([{ url: "small", width: 64 }])).toBe("small");
    expect(pickImage([])).toBeUndefined();
  });
});

it("renderDigest leaves out sections without data", () => {
  const start = { year: 2026, month: 9, day: 1 };
  const data: DigestData = {
    period: { kind: "month", start, end: { year: 2026, month: 10, day: 1 }, key: "2026-09" },
    timeZone: "UTC",
    totals: { plays: 1, tracks: 1, artists: 1, ms: 0 },
    previous: null,
    topTracks: [{ track_id: "t", name: "Only", artists: "Solo", plays: 1 }],
    topArtists: [{ artist_id: "s", name: "Solo", plays: 1 }],
    newTrackCount: 0,
    newArtists: [],
    repeatPlays: 1,
    days: Array.from({ length: 30 }, (_, i) => (i === 0 ? 1 : 0)),
    hours: Array.from({ length: 7 }, () => Array(24).fill(0)),
    returning: [],
    genres: [],
    year: Array.from({ length: 12 }, (_, i) => ({ month: { year: 2025, month: 10 + i, day: 1 }, plays: i === 11 ? 1 : 0 })),
    throwbacks: [],
    art: {},
    playlists: [],
    discUrl: null,
  };
  const { text, html } = renderDigest(data);
  expect(text).toContain("Song of the month: Only by Solo (1 play)");
  for (const absent of ["Also on repeat", "Your sound", "Your year", "New to you", "Welcome back", "Throwback", "Still updating"]) {
    expect(text).not.toContain(absent);
    expect(html).not.toContain(absent);
  }
  expect(html).not.toContain("vinyl.png");
});
