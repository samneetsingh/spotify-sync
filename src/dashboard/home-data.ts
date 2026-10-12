// The dashboard's Home: everything it shows, read in ONE db.batch by loadHome, plus the pure helpers
// that derive the day bars, streak, best day and ranges (exported for tests). Times are epoch ms and
// every range is [from, to); days are local days in the owner's time zone, from the DST-safe
// midnights in src/utils/time.ts. Art comes from the `dashboard:art` cache only; fillArt (./art.ts)
// fetches what's missing. HomeData is the contract with the Home view (home-view.tsx).

import { FAILING_PREFIX } from "../alerts";
import {
  readRecapGenres,
  readRecapNewArtistCount,
  readRecapNewArtists,
  readRecapNewTrackCount,
  readRecapPlayTimes,
  readRecapRangeCounts,
  readRecapRepeatPlays,
  readRecapTopArtists,
  readRecapTopTracks,
  readRecapTotals,
  recapGenresStmt,
  recapNewArtistCountStmt,
  recapNewArtistsStmt,
  recapNewTrackCountStmt,
  recapPlayTimesStmt,
  recapRangeCountsStmt,
  recapRepeatPlaysStmt,
  recapTopArtistsStmt,
  recapTopTracksStmt,
  recapTotalsStmt,
  type RecapArtist,
  type RecapTrack,
} from "../db/queries";
import { bucket, THROWBACK_YEARS } from "../jobs/digest";
import { addDays, addMonths, formatDate, weekdayIndex, zonedDate, zonedMidnight, type LocalDate } from "../utils/time";
import { ART_KEY, cachedArt } from "./art";
import { parseFailing, SYNC_RUN_COLUMNS, syncRun, type FailingJob, type SyncRun } from "./status";

export interface TrackItem { id: string; name: string; artists: string; plays: number }
export interface ArtistItem { id: string; name: string; plays: number }
export interface SoFar { plays: number; ms: number; newTracks: number; newArtists: number }
/** Period so far vs the same elapsed point of the previous period. */
export interface PeriodSoFar { from: number; current: SoFar; previous: SoFar }
export interface DayBar { date: string /* YYYY-MM-DD, local */; plays: number; future: boolean }
/** One year's line in a listening chart: plays per x point (null = still to come, this year only). */
export interface YearLine { year: number; plays: Array<number | null> }
/**
 * A listening chart's x points and one line per year, this year first, then up to TREND_YEARS - 1
 * earlier years (years without a play in the span are left out).
 */
export interface Trend { x: string[]; lines: YearLine[] }
export interface HomeStatus { connected: boolean; lastRun: SyncRun | null; lastSuccess: SyncRun | null; failing: FailingJob[] }
export interface HomeData {
  now: number;
  timeZone: string;
  status: HomeStatus;
  week: PeriodSoFar;   // Monday 00:00 local -> now
  month: PeriodSoFar;  // the 1st 00:00 local -> now
  songOfWeek: { track: TrackItem; lastWeek: boolean } | null; // falls back to last week's top when this week has no plays
  topTracks: TrackItem[];   // this month so far, <= 5
  topArtists: ArtistItem[]; // this month so far, <= 5
  genres: Array<{ genre: string; plays: number }>; // this month so far, <= 5
  days: { week: DayBar[] /* Mon-Sun */ };
  /**
   * The "Listening by day" lines. week: x = this week's dates (Mon-Sun), earlier years the same
   * weekdays 52 weeks per year back; month: x = the last MONTH_DAYS dates, earlier years the same
   * calendar dates; year: x = this year's months ("YYYY-MM", Jan-Dec), earlier years the same months.
   */
  trends: { week: Trend; month: Trend; year: Trend };
  /** Any play in the last STREAK_DAYS days (a brand-new instance has none). */
  anyPlays: boolean;
  streak: number;                               // consecutive local days with plays, ending today (or yesterday if today has none yet)
  bestDay: { date: string; plays: number } | null; // this calendar year
  hours: { from: string; to: string; grid: number[][] }; // 7x24 (Monday first, local hours), the last 28 local days including today
  newToYou: { plays: number; repeatPlays: number; newTracks: number; newArtists: ArtistItem[] /* <= 3 */ }; // this month so far
  throwbacks: Array<{ year: number; track: TrackItem }>; // top song of this calendar month, THROWBACK_YEARS ago
  art: Record<string, string>; // spotify id -> image url (absent or "" = placeholder)
}

/** Top tracks, artists and genres. */
const TOP = 5;
const NEW_ARTISTS = 3;
/** The 7x24 grid covers this many local days, today included. */
export const HOURS_DAYS = 28;
/** The month chart: this many local days, today included. */
export const MONTH_DAYS = 30;
/** The listening lines: this year and the years before it, this many in all. */
export const TREND_YEARS = 5;
/** How many local days back the streak can count (Home shows "400+ days" at the cap). */
export const STREAK_DAYS = 400;

const TOKEN_KEY = "spotify_refresh_token";

// ---------------------------------------------------------------------------- ranges

export interface SoFarRange {
  /** The period's start (local midnight) and now. */
  from: number;
  to: number;
  /** The previous period's start and the same point in it. */
  prevFrom: number;
  prevTo: number;
}

/**
 * This week (from Monday) and this month (from the 1st) so far, and the previous week and month up
 * to the same point: the same local day (the same weekday; the same day of the month, or all of last
 * month when it has no such day) and the same time since local midnight, never past the period's start.
 */
export function soFarRanges(now: number, timeZone: string): { week: SoFarRange; month: SoFarRange } {
  const at = (d: LocalDate) => zonedMidnight(d, timeZone);
  const today = zonedDate(now, timeZone);
  const intoToday = now - at(today);
  const sameTime = (day: LocalDate, end: number) => Math.min(at(day) + intoToday, end);

  const monday = addDays(today, -weekdayIndex(today));
  const weekFrom = at(monday);
  const monthFrom = at({ ...today, day: 1 });
  const lastMonth = addMonths(today, -1);
  const sameDayLastMonth = addDays(lastMonth, today.day - 1);
  return {
    week: { from: weekFrom, to: now, prevFrom: at(addDays(monday, -7)), prevTo: sameTime(addDays(today, -7), weekFrom) },
    month: {
      from: monthFrom,
      to: now,
      prevFrom: at(lastMonth),
      prevTo: sameDayLastMonth.month === lastMonth.month ? sameTime(sameDayLastMonth, monthFrom) : monthFrom,
    },
  };
}

/** Every local day from `first` through `last`, oldest first. */
export function localDays(first: LocalDate, last: LocalDate): LocalDate[] {
  const out: LocalDate[] = [];
  const end = formatDate(last);
  for (let d = first; formatDate(d) <= end; d = addDays(d, 1)) out.push(d);
  return out;
}

/** Monday to Sunday of `today`'s week. */
export const weekDates = (today: LocalDate): LocalDate[] => localDays(addDays(today, -weekdayIndex(today)), addDays(today, 6 - weekdayIndex(today)));

/** The MONTH_DAYS local days ending with `today`. */
export const recentDates = (today: LocalDate): LocalDate[] => localDays(addDays(today, 1 - MONTH_DAYS), today);

// ---------------------------------------------------------------------------- derived from daily plays

/** Plays on one local day. */
export interface DayCount {
  date: LocalDate;
  plays: number;
}

/** A bar per date; days after `today` are `future` (and have no plays yet). */
export function dayBars(daily: DayCount[], dates: LocalDate[], today: LocalDate): DayBar[] {
  const plays = new Map(daily.map((d) => [formatDate(d.date), d.plays]));
  const todayKey = formatDate(today);
  return dates.map((d) => {
    const date = formatDate(d);
    return { date, plays: plays.get(date) ?? 0, future: date > todayKey };
  });
}

/** A local day N years earlier (Feb 29 becomes Feb 28). */
const yearsBack = (d: LocalDate, years: number): LocalDate => (d.month === 2 && d.day === 29 && years % 4 ? { year: d.year - years, month: 2, day: 28 } : { ...d, year: d.year - years });

/**
 * The listening lines' spans: per chart, per year (this year first), the x points as [start, end)
 * local days. Week: this Monday-Sunday and the same weekdays 364 days per year back; month: the last
 * MONTH_DAYS days and the same dates in earlier years; year: each month of this calendar year and
 * of the years before.
 */
export function trendSpans(today: LocalDate): Record<keyof HomeData["trends"], { x: string[]; spans: Array<Array<[LocalDate, LocalDate]>> }> {
  const years = Array.from({ length: TREND_YEARS }, (_, k) => k);
  const days = (dates: LocalDate[], shift: (d: LocalDate, k: number) => LocalDate) =>
    years.map((k) => dates.map((d): [LocalDate, LocalDate] => [shift(d, k), addDays(shift(d, k), 1)]));
  const week = weekDates(today);
  const recent = recentDates(today);
  const months = Array.from({ length: 12 }, (_, m) => ({ year: today.year, month: m + 1, day: 1 }));
  return {
    week: { x: week.map(formatDate), spans: days(week, (d, k) => addDays(d, -364 * k)) },
    month: { x: recent.map(formatDate), spans: days(recent, yearsBack) },
    year: {
      x: months.map((m) => formatDate(m).slice(0, 7)),
      spans: years.map((k) => months.map((m): [LocalDate, LocalDate] => [{ ...m, year: m.year - k }, addMonths({ ...m, year: m.year - k }, 1)])),
    },
  };
}

/**
 * Lines from the spans' counts: this year's points after today are null (to come); an earlier year
 * with no plays in the span is left out.
 */
export function trendLines(spans: Array<Array<[LocalDate, LocalDate]>>, counts: number[], today: LocalDate): YearLine[] {
  const todayKey = formatDate(today);
  let i = 0;
  return spans.flatMap((points, k) => {
    const plays = points.map(([from]) => {
      const n = counts[i++] ?? 0;
      return k === 0 && formatDate(from) > todayKey ? null : n;
    });
    return k === 0 || plays.some((n) => n) ? [{ year: today.year - k, plays }] : [];
  });
}

/**
 * Consecutive days with plays ending today, or ending yesterday while today has none yet. `plays` is
 * per local day, oldest first, ending with today (so a streak is at most its length).
 */
export function streak(plays: number[]): number {
  let i = plays.length - 1;
  if (i >= 0 && !plays[i]) i--;
  let n = 0;
  for (; i >= 0 && plays[i]! > 0; i--) n++;
  return n;
}

/** The day of `year` with the most plays (the earliest on a tie), or null when it has none. */
export function bestDay(daily: DayCount[], year: number): { date: string; plays: number } | null {
  let best: DayCount | null = null;
  for (const d of daily) if (d.date.year === year && d.plays > (best?.plays ?? 0)) best = d;
  return best ? { date: formatDate(best.date), plays: best.plays } : null;
}

// ---------------------------------------------------------------------------- loadHome

const trackItem = (t: RecapTrack): TrackItem => ({ id: t.track_id, name: t.name ?? "Unknown track", artists: t.artists ?? "", plays: t.plays });
const artistItem = (a: RecapArtist): ArtistItem => ({ id: a.artist_id, name: a.name, plays: a.plays });

/** The state rows Home needs, and the last sync run and the last successful one (loadStatus's, minus the rest). */
function statusStatements(db: D1Database): D1PreparedStatement[] {
  // The token's value never leaves D1. ';' sorts right after ':', so the range is the alert_failing: prefix.
  const failingEnd = `${FAILING_PREFIX.slice(0, -1)};`;
  return [
    db
      .prepare(
        `SELECT key, CASE WHEN key = ?1 THEN '' ELSE value END AS value FROM state
         WHERE key IN (?1, ?2) OR (key >= ?3 AND key < ?4)`,
      )
      .bind(TOKEN_KEY, ART_KEY, FAILING_PREFIX, failingEnd),
    db.prepare(`SELECT ${SYNC_RUN_COLUMNS} FROM sync_runs ORDER BY id DESC LIMIT 1`),
    db.prepare(`SELECT ${SYNC_RUN_COLUMNS} FROM sync_runs WHERE status = 'success' ORDER BY id DESC LIMIT 1`),
  ];
}

/**
 * Everything the Home shows, in one db.batch (no other D1 query). Every statement binds a handful of
 * values (the day ranges go in as one JSON array), far under D1's 100 bound parameters.
 * `art` is the cache's entries only (none when it is stale); fillArt adds what's missing.
 */
export async function loadHome(db: D1Database, { now, timeZone }: { now: number; timeZone: string }): Promise<HomeData> {
  const at = (d: LocalDate) => zonedMidnight(d, timeZone);
  const today = zonedDate(now, timeZone);
  const { week, month } = soFarRanges(now, timeZone);
  // Daily plays from STREAK_DAYS days ago through today: this week's days, the streak and this year's
  // best day come from these. A rolling window, so the streak never drops on the 1st of a month while
  // it continues. The listening lines are one more range count (trendSpans).
  const days = localDays(addDays(today, 1 - STREAK_DAYS), today);
  const midnights = [...days, addDays(today, 1)].map(at);
  const throwbackMonths = THROWBACK_YEARS.map((y) => ({ year: today.year - y, month: today.month, day: 1 }));
  const hourDays = days.slice(-HOURS_DAYS);
  const trend = trendSpans(today);
  const charts = [trend.week, trend.month, trend.year];
  const trendRanges = charts.flatMap((c) => c.spans.flat().map(([from, to]): [number, number] => [at(from), at(to)]));

  const soFarStatements = (from: number, to: number) => [recapTotalsStmt(db, from, to), recapNewTrackCountStmt(db, from, to), recapNewArtistCountStmt(db, from, to)];
  const results = await db.batch([
    ...statusStatements(db),
    ...soFarStatements(week.from, week.to),
    ...soFarStatements(week.prevFrom, week.prevTo),
    ...soFarStatements(month.from, month.to),
    ...soFarStatements(month.prevFrom, month.prevTo),
    recapTopTracksStmt(db, week.from, week.to, 1),
    recapTopTracksStmt(db, week.prevFrom, week.from, 1), // all of last week: the fallback song of the week
    recapTopTracksStmt(db, month.from, month.to, TOP),
    recapTopArtistsStmt(db, month.from, month.to, TOP),
    recapGenresStmt(db, month.from, month.to, TOP),
    recapRepeatPlaysStmt(db, month.from, month.to),
    recapNewArtistsStmt(db, month.from, month.to, NEW_ARTISTS),
    ...throwbackMonths.map((m) => recapTopTracksStmt(db, at(m), at(addMonths(m, 1)), 1)),
    recapRangeCountsStmt(db, days.map((_, i) => [midnights[i]!, midnights[i + 1]!])),
    recapPlayTimesStmt(db, midnights[days.length - hourDays.length]!, midnights.at(-1)!),
    recapRangeCountsStmt(db, trendRanges),
  ]);

  // Read the results in the order the statements went in.
  let i = 0;
  const next = (): D1Result => results[i++]!;
  const stateRows = next().results as Array<{ key: string; value: string }>;
  const run = (r: D1Result): SyncRun | null => {
    const row = r.results[0] as Parameters<typeof syncRun>[0] | undefined;
    return row ? syncRun(row) : null;
  };
  const lastRun = run(next());
  const lastSuccess = run(next());
  const soFar = (): SoFar => {
    const totals = readRecapTotals(next());
    return { plays: totals.plays, ms: totals.ms, newTracks: readRecapNewTrackCount(next()), newArtists: readRecapNewArtistCount(next()) };
  };
  const weekSoFar: PeriodSoFar = { from: week.from, current: soFar(), previous: soFar() };
  const monthSoFar: PeriodSoFar = { from: month.from, current: soFar(), previous: soFar() };
  const [thisWeekTop] = readRecapTopTracks(next());
  const [lastWeekTop] = readRecapTopTracks(next());
  const topTracks = readRecapTopTracks(next()).map(trackItem);
  const topArtists = readRecapTopArtists(next()).map(artistItem);
  const genres = readRecapGenres(next());
  const repeatPlays = readRecapRepeatPlays(next());
  const newArtists = readRecapNewArtists(next()).map(artistItem);
  const throwbacks = THROWBACK_YEARS.flatMap((y) => {
    const [top] = readRecapTopTracks(next());
    return top ? [{ year: today.year - y, track: trackItem(top) }] : [];
  });
  const counts = readRecapRangeCounts(next());
  const times = readRecapPlayTimes(next());
  const trendCounts = readRecapRangeCounts(next());
  let offset = 0;
  const [weekLines, monthLines, yearLines] = charts.map((c) => {
    const n = c.spans.flat().length;
    const lines = trendLines(c.spans, trendCounts.slice(offset, offset + n), today);
    offset += n;
    return lines;
  });

  const values = new Map(stateRows.map((r) => [r.key, r.value]));
  const failing = [...values]
    .filter(([k]) => k.startsWith(FAILING_PREFIX))
    .map(([k, v]) => parseFailing(k.slice(FAILING_PREFIX.length), v))
    .sort((a, b) => a.since - b.since);
  const daily = days.map((date, d) => ({ date, plays: counts[d] ?? 0 }));

  return {
    now,
    timeZone,
    status: { connected: values.has(TOKEN_KEY), lastRun, lastSuccess, failing },
    week: weekSoFar,
    month: monthSoFar,
    songOfWeek: thisWeekTop ? { track: trackItem(thisWeekTop), lastWeek: false } : lastWeekTop ? { track: trackItem(lastWeekTop), lastWeek: true } : null,
    topTracks,
    topArtists,
    genres,
    days: { week: dayBars(daily, weekDates(today), today) },
    trends: { week: { x: trend.week.x, lines: weekLines! }, month: { x: trend.month.x, lines: monthLines! }, year: { x: trend.year.x, lines: yearLines! } },
    anyPlays: daily.some((d) => d.plays > 0),
    streak: streak(daily.map((d) => d.plays)),
    bestDay: bestDay(daily, today.year),
    hours: { from: formatDate(hourDays[0]!), to: formatDate(today), grid: bucket(times, hourDays, timeZone).hours },
    newToYou: { plays: monthSoFar.current.plays, repeatPlays, newTracks: monthSoFar.current.newTracks, newArtists },
    throwbacks,
    art: cachedArt(values.get(ART_KEY) ?? null, now),
  };
}
