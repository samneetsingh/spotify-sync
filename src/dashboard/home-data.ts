// The dashboard's Home: everything it shows, read in ONE db.batch by loadHome, plus the pure helpers
// that derive the day bars, streak, best day and ranges (exported for tests). Times are epoch ms and
// every range is [from, to); days are local days in the owner's time zone, from the DST-safe
// midnights in src/utils/time.ts. Art comes from the `dashboard:art` cache only; fillArt (./art.ts)
// fetches what's missing. HomeData is the contract with the Home view: change its shapes through the lead.

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
import { bucket, LAST_DIGEST_KEY, THROWBACK_YEARS, type DigestKind } from "../jobs/digest";
import { addDays, addMonths, formatDate, weekdayIndex, zonedDate, zonedMidnight, type LocalDate } from "../utils/time";
import { ART_KEY, cachedArt } from "./art";
import { nextDigestRun, periodLabel } from "./next-digest";
import { parseFailing, SYNC_RUN_COLUMNS, syncRun, type FailingJob, type SyncRun } from "./status";

export interface TrackItem { id: string; name: string; artists: string; plays: number }
export interface ArtistItem { id: string; name: string; plays: number }
export interface SoFar { plays: number; ms: number; newTracks: number; newArtists: number }
/** Period so far vs the same elapsed point of the previous period. */
export interface PeriodSoFar { from: number; current: SoFar; previous: SoFar }
export interface DayBar { date: string /* YYYY-MM-DD, local */; plays: number; future: boolean }
export interface MonthBar { month: string /* YYYY-MM */; plays: number; current: boolean }
export interface DigestInfo { kind: "week" | "month"; subject: string; period: string; sentAt: number }
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
  days: { week: DayBar[] /* Mon-Sun */; month: DayBar[] /* every day of this month */; year: MonthBar[] /* 12, oldest first, current "so far" */ };
  streak: number;                               // consecutive local days with plays, ending today (or yesterday if today has none yet)
  bestDay: { date: string; plays: number } | null; // this calendar year
  hours: { from: string; to: string; grid: number[][] }; // 7x24 (Monday first, local hours), the last 28 local days including today
  newToYou: { plays: number; repeatPlays: number; newTracks: number; newArtists: ArtistItem[] /* <= 3 */ }; // this month so far
  throwbacks: Array<{ year: number; track: TrackItem }>; // top song of this calendar month, THROWBACK_YEARS ago
  digests: { last: DigestInfo | null; next: { week: { at: number; period: string } | null; month: { at: number; period: string } | null } };
  art: Record<string, string>; // spotify id -> image url (absent or "" = placeholder)
}

/** Top tracks, artists and genres. */
const TOP = 5;
const NEW_ARTISTS = 3;
/** The 7x24 grid covers this many local days, today included. */
export const HOURS_DAYS = 28;
/** The year chart: this many months, the current one included. */
export const YEAR_MONTHS = 12;

const TOKEN_KEY = "spotify_refresh_token";
const RECAP_KEYS: Record<DigestKind, string> = { week: "recap:last_week", month: "recap:last_month" };

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

/** Every day of `today`'s month. */
export const monthDates = (today: LocalDate): LocalDate[] => localDays({ ...today, day: 1 }, addDays(addMonths(today, 1), -1));

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

/** Plays per month for the YEAR_MONTHS months ending with `today`'s (oldest first; the current one so far). */
export function monthBars(daily: DayCount[], today: LocalDate): MonthBar[] {
  const month = (d: LocalDate) => formatDate(d).slice(0, 7);
  const sums = new Map<string, number>();
  for (const d of daily) sums.set(month(d.date), (sums.get(month(d.date)) ?? 0) + d.plays);
  return Array.from({ length: YEAR_MONTHS }, (_, i) => {
    const m = month(addMonths(today, i - (YEAR_MONTHS - 1)));
    return { month: m, plays: sums.get(m) ?? 0, current: i === YEAR_MONTHS - 1 };
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

/** A digest:last value (src/jobs/digest.ts), or null when missing or malformed. */
export function parseLastDigest(raw: string | null | undefined): DigestInfo | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<DigestInfo> | null;
    if (v && (v.kind === "week" || v.kind === "month") && typeof v.subject === "string" && typeof v.period === "string" && typeof v.sentAt === "number") {
      return { kind: v.kind, subject: v.subject, period: v.period, sentAt: v.sentAt };
    }
  } catch {
    // malformed: no latest digest
  }
  return null;
}

/** The state rows Home needs, and the last sync run and the last successful one (loadStatus's, minus the rest). */
function statusStatements(db: D1Database): D1PreparedStatement[] {
  // The token's value never leaves D1. ';' sorts right after ':', so the range is the alert_failing: prefix.
  const failingEnd = `${FAILING_PREFIX.slice(0, -1)};`;
  return [
    db
      .prepare(
        `SELECT key, CASE WHEN key = ?1 THEN '' ELSE value END AS value FROM state
         WHERE key IN (?1, ?2, ?3, ?4, ?5) OR (key >= ?6 AND key < ?7)`,
      )
      .bind(TOKEN_KEY, RECAP_KEYS.week, RECAP_KEYS.month, LAST_DIGEST_KEY, ART_KEY, FAILING_PREFIX, failingEnd),
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
  // Daily plays from the 1st of the month YEAR_MONTHS - 1 months ago through today: the day bars,
  // the year chart, the streak and this year's best day all come from these.
  const days = localDays(addMonths(today, 1 - YEAR_MONTHS), today);
  const midnights = [...days, addDays(today, 1)].map(at);
  const throwbackMonths = THROWBACK_YEARS.map((y) => ({ year: today.year - y, month: today.month, day: 1 }));
  const hourDays = days.slice(-HOURS_DAYS);

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

  const values = new Map(stateRows.map((r) => [r.key, r.value]));
  const failing = [...values]
    .filter(([k]) => k.startsWith(FAILING_PREFIX))
    .map(([k, v]) => parseFailing(k.slice(FAILING_PREFIX.length), v))
    .sort((a, b) => a.since - b.since);
  const nextDigest = (kind: DigestKind) => {
    const n = nextDigestRun(kind, now, timeZone, values.get(RECAP_KEYS[kind]) ?? null);
    return n ? { at: n.at, period: periodLabel(n.period) } : null;
  };
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
    days: { week: dayBars(daily, weekDates(today), today), month: dayBars(daily, monthDates(today), today), year: monthBars(daily, today) },
    streak: streak(daily.map((d) => d.plays)),
    bestDay: bestDay(daily, today.year),
    hours: { from: formatDate(hourDays[0]!), to: formatDate(today), grid: bucket(times, hourDays, timeZone).hours },
    newToYou: { plays: monthSoFar.current.plays, repeatPlays, newTracks: monthSoFar.current.newTracks, newArtists },
    throwbacks,
    digests: { last: parseLastDigest(values.get(LAST_DIGEST_KEY)), next: { week: nextDigest("week"), month: nextDigest("month") } },
    art: cachedArt(values.get(ART_KEY) ?? null, now),
  };
}
