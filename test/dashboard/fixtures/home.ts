// Realistic HomeData for the Home view's tests and screenshots: a full instance, a brand-new one, one
// that isn't connected, one whose Spotify login expired, a quiet week, and missing art or artist
// details. "Now" is Thursday, Oct 8 2026, 3:30 PM in Los Angeles; this week's days and the listening
// lines come from the same helpers loadHome uses, so their shapes match the real thing.

import { dayBars, localDays, trendLines, trendSpans, TREND_YEARS, weekDates, type DayCount, type HomeData, type TrackItem } from "../../../src/dashboard/home-data";
import { addDays, formatDate, zonedDate, type LocalDate } from "../../../src/utils/time";

export const TZ = "America/Los_Angeles";
export const NOW = Date.parse("2026-10-08T22:30:00Z");
const MIN = 60_000;
const today = zonedDate(NOW, TZ);

/** A small deterministic PRNG (mulberry32), so fixtures are stable. */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TRACKS: TrackItem[] = [
  { id: "4uLU6hMCjMI75M1A2tKUQC", name: "Midnight City", artists: "M83", plays: 23 },
  { id: "0VjIjW4GlUZAMYd2vXMi3b", name: "Blinding Lights", artists: "The Weeknd", plays: 19 },
  { id: "6UelLqGlWMcVH1E5c4H7lY", name: "Kesariya", artists: "Pritam, Arijit Singh, Amitabh Bhattacharya", plays: 16 },
  { id: "3n3Ppam7vgaVa1iaRUc9Lp", name: "Mr. Brightside", artists: "The Killers", plays: 11 },
  { id: "7qiZfU4dY1lWllzX7mPBI3", name: "A Very Long Song Title That Keeps Going (Extended Night Drive Remix)", artists: "Somebody & The Long Names", plays: 8 },
];

const ARTISTS = [
  { id: "63MQldklfxkjYDoUE4Tppz", name: "M83", plays: 41 },
  { id: "1Xyo4u8uXC1ZmMpatF05PJ", name: "The Weeknd", plays: 33 },
  { id: "4YRxDV8wJFPHPTeXepOstw", name: "Arijit Singh", plays: 29 },
  { id: "0C0XlULifJtAgn6ZNCW2eu", name: "The Killers", plays: 17 },
  { id: "5K4W6rqBFWDnAN6FQUkS6x", name: "Kanye West", plays: 9 },
];

/** Album and artist art URLs (fake ids on Spotify's image host). */
const ART: Record<string, string> = Object.fromEntries(
  [...TRACKS.slice(0, 4), ...ARTISTS.slice(0, 4), { id: "throwback-1" }, { id: "newartist-1" }].map((x, i) => [x.id, `https://i.scdn.co/image/ab67616d0000b273${String(i).padStart(24, "0")}`]),
);

/** Plays per local day since Jan 1 of the earliest year the listening lines show, ending today (today partial). */
function daily(seed: number, quietFrom?: string): DayCount[] {
  const r = rng(seed);
  return localDays({ year: today.year - (TREND_YEARS - 1), month: 1, day: 1 }, today).map((date) => {
    const key = formatDate(date);
    const weekend = [0, 6].includes(new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay());
    const season = 1 + 0.35 * Math.sin((date.month / 12) * Math.PI * 2);
    let plays = r() < 0.07 ? 0 : Math.round((weekend ? 48 : 34) * season * (0.4 + r()));
    if (key === formatDate(today)) plays = Math.round(plays * 0.6);
    if (quietFrom && key >= quietFrom) plays = 0;
    return { date, plays };
  });
}

/** Evenings and weekend afternoons are busiest. */
function hourGrid(seed: number, scale = 1): number[][] {
  const r = rng(seed);
  return Array.from({ length: 7 }, (_, d) =>
    Array.from({ length: 24 }, (_, h) => {
      const evening = Math.exp(-((h - 21) ** 2) / 8);
      const commute = Math.exp(-((h - 8.5) ** 2) / 2) * (d < 5 ? 0.8 : 0.1);
      const afternoon = Math.exp(-((h - 15) ** 2) / 10) * (d >= 5 ? 0.9 : 0.3);
      const v = (evening * 9 + commute * 6 + afternoon * 6) * (0.6 + r() * 0.8) * scale;
      return h >= 2 && h <= 6 ? 0 : Math.round(v);
    }),
  );
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/** This week's days and the listening lines (each span summed from `days`), as loadHome builds them. */
function withDays(days: DayCount[]): Pick<HomeData, "days" | "trends" | "anyPlays"> {
  const plays = new Map(days.map((d) => [formatDate(d.date), d.plays]));
  const count = ([from, to]: [LocalDate, LocalDate]) => sum(localDays(from, addDays(to, -1)).map((d) => plays.get(formatDate(d)) ?? 0));
  const spans = trendSpans(today);
  const trend = (c: (typeof spans)["week"]) => ({ x: c.x, lines: trendLines(c.spans, c.spans.flat().map(count), today) });
  return {
    days: { week: dayBars(days, weekDates(today), today) },
    trends: { week: trend(spans.week), month: trend(spans.month), year: trend(spans.year) },
    anyPlays: days.some((d) => d.plays > 0),
  };
}

const syncRun = (id: number, minutesAgo: number) => ({
  id,
  startedAt: NOW - minutesAgo * MIN - 20_000,
  finishedAt: NOW - minutesAgo * MIN,
  status: "success",
  playsFetched: 3,
  tracksAdded: 1,
  error: null,
});

/** Everything present: a busy instance with art. */
export function fullHome(): HomeData {
  const days = daily(7);
  const bars = withDays(days);
  const weekPlays = sum(bars.days.week.map((b) => b.plays));
  const monthPlays = sum(days.filter((d) => d.date.year === today.year && d.date.month === today.month).map((d) => d.plays));
  return {
    now: NOW,
    timeZone: TZ,
    status: { connected: true, lastRun: syncRun(812, 4), lastSuccess: syncRun(812, 4), failing: [] },
    week: {
      from: Date.parse("2026-10-05T07:00:00Z"),
      current: { plays: weekPlays, ms: weekPlays * 3.4 * MIN, newTracks: 41, newArtists: 9 },
      previous: { plays: Math.round(weekPlays * 0.86), ms: weekPlays * 0.86 * 3.6 * MIN, newTracks: 52, newArtists: 9 },
    },
    month: {
      from: Date.parse("2026-10-01T07:00:00Z"),
      current: { plays: monthPlays, ms: monthPlays * 3.4 * MIN, newTracks: 64, newArtists: 12 },
      previous: { plays: Math.round(monthPlays * 1.12), ms: monthPlays * 1.12 * 3.5 * MIN, newTracks: 58, newArtists: 14 },
    },
    songOfWeek: { track: TRACKS[0]!, lastWeek: false },
    topTracks: TRACKS,
    topArtists: ARTISTS,
    genres: [
      { genre: "indietronica", plays: 88 },
      { genre: "synthwave", plays: 61 },
      { genre: "filmi", plays: 47 },
      { genre: "modern rock", plays: 30 },
      { genre: "canadian contemporary r&b", plays: 22 },
    ],
    ...bars,
    streak: 12,
    bestDay: { date: "2026-03-14", plays: 212 },
    hours: { from: formatDate(addDays(today, -27)), to: formatDate(today), grid: hourGrid(11) },
    newToYou: {
      plays: monthPlays,
      repeatPlays: Math.round(monthPlays * 0.71),
      newTracks: 64,
      newArtists: [
        { id: "newartist-1", name: "Khruangbin", plays: 14 },
        { id: "newartist-2", name: "Nilüfer Yanya", plays: 9 },
        { id: "newartist-3", name: "Prateek Kuhad", plays: 6 },
      ],
    },
    throwbacks: [
      { year: 2025, track: { id: "throwback-1", name: "Tum Hi Ho", artists: "Arijit Singh", plays: 31 } },
      { year: 2021, track: { id: "throwback-5", name: "Levitating", artists: "Dua Lipa", plays: 24 } },
    ],
    art: ART,
  };
}

/** A brand-new instance: connected, no sync has run yet, nothing played. */
export function emptyHome(): HomeData {
  const days = daily(1).map((d) => ({ ...d, plays: 0 }));
  const zero = { plays: 0, ms: 0, newTracks: 0, newArtists: 0 };
  return {
    now: NOW,
    timeZone: TZ,
    status: { connected: true, lastRun: null, lastSuccess: null, failing: [] },
    week: { from: Date.parse("2026-10-05T07:00:00Z"), current: zero, previous: zero },
    month: { from: Date.parse("2026-10-01T07:00:00Z"), current: zero, previous: zero },
    songOfWeek: null,
    topTracks: [],
    topArtists: [],
    genres: [],
    ...withDays(days),
    streak: 0,
    bestDay: null,
    hours: { from: formatDate(addDays(today, -27)), to: formatDate(today), grid: Array.from({ length: 7 }, () => Array<number>(24).fill(0)) },
    newToYou: { plays: 0, repeatPlays: 0, newTracks: 0, newArtists: [] },
    throwbacks: [],
    art: {},
  };
}

/** No Spotify refresh token stored. */
export function notConnectedHome(): HomeData {
  const data = emptyHome();
  return { ...data, status: { ...data.status, connected: false } };
}

/** Plays exist, but the sync fails on Spotify's login. */
export function loginErrorHome(): HomeData {
  const data = fullHome();
  return {
    ...data,
    status: {
      ...data.status,
      lastRun: { ...syncRun(830, 6), status: "error", error: "invalid_grant: Refresh token revoked" },
      lastSuccess: syncRun(790, 26 * 60),
      failing: [{ job: "sync", since: NOW - 26 * 60 * MIN, failures: 140, lastError: "invalid_grant: Refresh token revoked" }],
    },
  };
}

/** Nothing played since Monday: the week's charts show zeros and the song of the week is last week's. */
export function quietWeekHome(): HomeData {
  const data = fullHome();
  const monday = formatDate(addDays(today, -3));
  const days = daily(7, monday);
  const bars = withDays(days);
  const zero = { plays: 0, ms: 0, newTracks: 0, newArtists: 0 };
  return {
    ...data,
    ...bars,
    week: { ...data.week, current: zero },
    songOfWeek: { track: TRACKS[1]!, lastWeek: true },
    streak: 0,
    hours: { ...data.hours, grid: hourGrid(11, 0.6) },
  };
}

/** Plays, but no cached art at all (every cover and photo is the placeholder). */
export function noArtHome(): HomeData {
  return { ...fullHome(), art: {} };
}

/** Plays, but no artist details yet (no artists, genres or new artists). */
export function noMetadataHome(): HomeData {
  const data = fullHome();
  return { ...data, topArtists: [], genres: [], newToYou: { ...data.newToYou, newArtists: [] } };
}

/** A failing job other than the sync. */
export function failingJobHome(): HomeData {
  const data = fullHome();
  return { ...data, status: { ...data.status, failing: [{ job: "artist-playlists", since: NOW - 3 * 86_400_000, failures: 3, lastError: "Spotify 502" }] } };
}

export const FIXTURES = {
  full: fullHome,
  empty: emptyHome,
  "not-connected": notConnectedHome,
  "login-error": loginErrorHome,
  "quiet-week": quietWeekHome,
  "no-art": noArtHome,
  "no-metadata": noMetadataHome,
  "failing-job": failingJobHome,
} as const;
