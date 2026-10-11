// Highlights for the AI editor: optional extra cards code finds in the period (a daily streak,
// late-night listening, one song all day, a long session, comebacks, a genre shift, a new
// obsession). Each passes a per-kind threshold, carries its own pre-formatted facts and default
// copy, and gets a 0..1 score; the model may feature a few of the best.
// Local days and hours are in the digest's time zone, DST included.

import {
  digestComebackTracks,
  digestGenreShares,
  digestNewObsession,
  periodPlayRows,
  recapReturningArtists,
  trackNames,
  type GenreShares,
  type PeriodPlay,
  type RecapArtist,
  type RecapTrack,
} from "../db/queries";
import { fmt, plays } from "../email/layout";
import type { DigestData, Period } from "../jobs/digest";
import { addDays, addMonths, zonedDate, zonedHour, zonedMidnight, type LocalDate } from "../utils/time";
import { dayLabel, hourLabel, monthLabel, share, shortLabel, sinceLabel } from "./facts";
import type { DigestKind, Highlight, HighlightKind } from "./types";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const YEAR_MS = 365 * DAY_MS;
/** A break longer than this between two plays starts a new listening session. */
const SESSION_GAP_MS = 30 * 60_000;
/** Late night: midnight to 3:59 AM. */
const LATE_NIGHT_END_HOUR = 4;
const LATE_NIGHT_MIN_SHARE = 0.08;
const MAX_HIGHLIGHTS = 8;
/** What a genre shift's percentages are of (many artists have no genres on Spotify). */
const GENRE_SHARE_OF = "plays with genre tags (plays whose main artist has genres on Spotify), not all plays";

/** Inclusion thresholds per digest kind. */
const MIN = {
  month: { streakDays: 10, latePlays: 15, dayPlays: 6, sessionMinutes: 150, comebackPlays: 3, obsessionPlays: 6, genrePlays: 20, genrePoints: 5 },
  week: { streakDays: 7, latePlays: 5, dayPlays: 4, sessionMinutes: 120, comebackPlays: 2, obsessionPlays: 4, genrePlays: 10, genrePoints: 8 },
};
const TRACK_COMEBACK = { idleMs: YEAR_MS, minEarlierPlays: 5 };
/** Weeks only; a month reuses the digest's "Welcome back" artists (same idle and earlier-plays rules). */
const WEEK_ARTIST_COMEBACK = { idleMs: YEAR_MS, minEarlierPlays: 10, minPlays: 2, limit: 1 };

type TrackName = Pick<RecapTrack, "name" | "artists">;

/** The SQL-backed inputs. Anything left out yields no highlight of that kind. */
export interface HighlightExtras {
  /** Names of the tracks the plays single out (late-night and one-day favorites). */
  names?: ReadonlyMap<string, TrackName>;
  comebackTracks?: Array<RecapTrack & { last_before_ms: number }>;
  newObsession?: (RecapTrack & { first_ms: number }) | null;
  genreShares?: GenreShares | null;
  comebackArtist?: (RecapArtist & { last_before_ms: number }) | null;
}

/** The highlights of `period` from its plays (`rows`, oldest first) and `extra`; best first, at most 8. */
export function computeHighlights(kind: DigestKind, period: Period, rows: PeriodPlay[], timeZone: string, extra: HighlightExtras = {}): Highlight[] {
  return build(kind, period, measure(period, rows, timeZone), extra, timeZone);
}

/** The period's highlights from D1 (at most 6 queries); `data` is the loaded digest. */
export async function loadHighlights(db: D1Database, kind: DigestKind, period: Period, timeZone: string, data: DigestData): Promise<Highlight[]> {
  const from = zonedMidnight(period.start, timeZone);
  const to = zonedMidnight(period.end, timeZone);
  const prevFrom = zonedMidnight(kind === "month" ? addMonths(period.start, -1) : addDays(period.start, -7), timeZone);
  const [rows, comebackTracks, newObsession, genreShares, returning] = await Promise.all([
    periodPlayRows(db, from, to),
    digestComebackTracks(db, from, to, { ...TRACK_COMEBACK, minPlays: MIN[kind].comebackPlays }),
    digestNewObsession(db, from, to),
    digestGenreShares(db, prevFrom, from, to),
    kind === "month" ? data.returning : recapReturningArtists(db, from, to, WEEK_ARTIST_COMEBACK),
  ]);
  const stats = measure(period, rows, timeZone);
  // Only the play-based highlights that qualify (late night, one song all day) need names looked up.
  const ids = build(kind, period, stats, {}, timeZone).flatMap((h) => (h.subject ? [h.subject.id] : []));
  const names = await trackNames(db, [...new Set(ids)]);
  return build(kind, period, stats, { names, comebackTracks, newObsession, genreShares, comebackArtist: returning[0] ?? null }, timeZone);
}

// ---------------------------------------------------------------------------- measuring the plays

interface PlayStats {
  days: LocalDate[];
  total: number;
  /** Longest run of consecutive local days with a play: length and first day's index. */
  streak: { days: number; start: number };
  lateNight: { plays: number; top: { id: string; plays: number } | null };
  repeatDay: { id: string; day: number; plays: number } | null;
  /** Longest session by listening time; `start` is when its first play began. */
  session: { ms: number; plays: number; start: number } | null;
}

function measure(period: Period, rows: PeriodPlay[], timeZone: string): PlayStats {
  const days = Array.from({ length: Math.round((dayMs(period.end) - dayMs(period.start)) / DAY_MS) }, (_, i) => addDays(period.start, i));
  const clock = localClock(days, timeZone);
  const played = days.map(() => false);
  const late = new Map<string, { id: string; plays: number }>();
  const perDay = new Map<string, { id: string; day: number; plays: number }>();
  let latePlays = 0;
  let session: PlayStats["session"] = null;
  let current: PlayStats["session"] = null;

  for (const [i, r] of rows.entries()) {
    const { day, hour } = clock(r.at);
    played[day] = true;
    if (hour < LATE_NIGHT_END_HOUR) {
      latePlays++;
      tally(late, r.id, { id: r.id });
    }
    tally(perDay, `${day} ${r.id}`, { id: r.id, day });
    // played_at is when a play ended (the API and the export alike), so a gap runs from one
    // play's end to the next one's start.
    if (!current || r.at - r.ms - rows[i - 1]!.at > SESSION_GAP_MS) current = { ms: 0, plays: 0, start: r.at - r.ms };
    current.ms += r.ms;
    current.plays++;
    if (!session || current.ms > session.ms) session = current;
  }

  let streak = { days: 0, start: 0 };
  let run = 0;
  for (const [i, p] of played.entries()) {
    run = p ? run + 1 : 0;
    if (run > streak.days) streak = { days: run, start: i - run + 1 };
  }
  const top = most(late);
  return {
    days,
    total: rows.length,
    streak,
    lateNight: { plays: latePlays, top: top && top.plays >= 2 ? top : null },
    repeatDay: most(perDay),
    session,
  };
}

const dayMs = (d: LocalDate) => Date.UTC(d.year, d.month - 1, d.day);

/** Counts a play under `key`; Map order is first-play order, which `most` uses to break ties. */
function tally<T extends object>(counts: Map<string, T & { plays: number }>, key: string, init: T) {
  const c = counts.get(key);
  if (c) c.plays++;
  else counts.set(key, { ...init, plays: 1 });
}

/** The most played entry; ties go to the one played first. */
function most<T extends { plays: number }>(counts: Map<string, T>): T | null {
  let best: T | null = null;
  for (const c of counts.values()) if (!best || c.plays > best.plays) best = c;
  return best;
}

/**
 * Local day (index into `days`) and hour of a time, like `bucket()` in the digest: plain arithmetic
 * on 24-hour days, the time zone's own clock on the two DST days a year. Fastest on ascending times.
 */
function localClock(days: LocalDate[], timeZone: string): (t: number) => { day: number; hour: number } {
  const starts = [...days, addDays(days.at(-1)!, 1)].map((d) => zonedMidnight(d, timeZone));
  let day = 0;
  return (t) => {
    if (t < starts[day]!) day = 0;
    while (day < days.length - 1 && t >= starts[day + 1]!) day++;
    const hour = starts[day + 1]! - starts[day]! === DAY_MS ? Math.floor((t - starts[day]!) / HOUR_MS) : zonedHour(t, timeZone);
    return { day, hour };
  };
}

// ---------------------------------------------------------------------------- the highlights

function build(kind: DigestKind, period: Period, s: PlayStats, x: HighlightExtras, timeZone: string): Highlight[] {
  const min = MIN[kind];
  const out: Highlight[] = [];
  const add = (k: HighlightKind, score: number, h: Omit<Highlight, "id" | "kind" | "score">) => {
    out.push({ id: `hl:${k}`, kind: k, score: Math.min(1, Math.max(0, score)), ...h });
  };
  const from = zonedMidnight(period.start, timeZone);
  const away = (lastMs: number) => (from - lastMs) / YEAR_MS;
  const yearsAway = (n: number) => ({ value: n, unit: n === 1 ? "year away" : "years away" });

  if (s.streak.days >= min.streakDays) {
    const { days, start } = s.streak;
    const everyDay = days === s.days.length;
    const startLabel = shortLabel(s.days[start]!);
    const endLabel = shortLabel(s.days[start + days - 1]!);
    add("streak", days / s.days.length, {
      stat: { value: days, unit: "days in a row" },
      facts: { days, startLabel, endLabel, everyDay: everyDay ? "yes" : "no" },
      defaultHeading: everyDay ? "Every single day" : "Day after day",
      defaultInsight: `You pressed play **${everyDay ? `every day this ${kind}` : `${days} days in a row`}**, ${startLabel} to ${endLabel}.`,
    });
  }

  const late = s.lateNight;
  const lateShare = late.plays / Math.max(1, s.total);
  if (late.plays >= min.latePlays && lateShare >= LATE_NIGHT_MIN_SHARE) {
    const sharePct = Math.round(lateShare * 100);
    const t = late.top && trackFacts(late.top.id, x.names?.get(late.top.id));
    add("lateNight", 2 * lateShare, {
      stat: { value: late.plays, unit: "plays after midnight" },
      ...(t && { subject: t.subject }),
      facts: { plays: late.plays, sharePct, window: "midnight to 4 AM", ...(t && { track: t.name, trackPlays: late.top!.plays }) },
      defaultHeading: "After midnight",
      defaultInsight:
        `**${plays(late.plays)}** came between midnight and 4 AM, ${sharePct}% of your plays this ${kind}.` + (t ? ` Your late-night favorite: **${t.name}**.` : ""),
    });
  }

  const rep = s.repeatDay;
  if (rep && rep.plays >= min.dayPlays) {
    const t = trackFacts(rep.id, x.names?.get(rep.id));
    const label = dayLabel(s.days[rep.day]!);
    add("repeatDay", rep.plays / 15, {
      stat: { value: rep.plays, unit: "plays in one day" },
      subject: t.subject,
      facts: { plays: rep.plays, dayLabel: label, track: t.name },
      defaultHeading: "One song, all day",
      defaultInsight: `On ${label} you played **${t.name}** ${fmt(rep.plays)} times.`,
    });
  }

  const minutes = s.session ? Math.round(s.session.ms / 60_000) : 0;
  if (s.session && minutes >= min.sessionMinutes) {
    const hours = Math.round(minutes / 6) / 10; // one decimal
    const startLabel = hourLabel(zonedHour(s.session.start, timeZone));
    const label = dayLabel(zonedDate(s.session.start, timeZone));
    add("binge", minutes / 360, {
      stat: { value: hours, unit: "hours straight" },
      facts: { minutes, hours, plays: s.session.plays, dayLabel: label, startLabel },
      defaultHeading: "The long session",
      defaultInsight: `On ${label} you listened for **${hours} hours straight**, starting around ${startLabel}.`,
    });
  }

  const back = x.comebackTracks?.[0];
  if (back) {
    const t = trackFacts(back.track_id, back);
    const years = Math.floor(away(back.last_before_ms));
    const lastHeardLabel = sinceLabel(back.last_before_ms, timeZone);
    add("comebackTrack", away(back.last_before_ms) / 3, {
      stat: yearsAway(years),
      subject: t.subject,
      facts: { plays: back.plays, lastHeardLabel, yearsAway: years, track: t.name },
      defaultHeading: "Back on repeat",
      defaultInsight: `**${t.name}** is back: ${plays(back.plays)} this ${kind}, your first since ${lastHeardLabel}.`,
    });
  }

  const artist = x.comebackArtist;
  if (artist) {
    const years = Math.floor(away(artist.last_before_ms));
    const lastHeardLabel = sinceLabel(artist.last_before_ms, timeZone);
    add("comebackArtist", away(artist.last_before_ms) / 3, {
      stat: yearsAway(years),
      subject: { type: "artist", id: artist.artist_id, name: artist.name },
      facts: { plays: artist.plays, lastHeardLabel, yearsAway: years, artist: artist.name },
      defaultHeading: "Look who's back",
      defaultInsight: `**${artist.name}** is back: ${plays(artist.plays)} this ${kind}, your first since ${lastHeardLabel}.`,
    });
  }

  // Shares are of plays whose primary artist has genres; both periods need enough of them.
  const g = x.genreShares;
  if (g && g.tagged.now >= min.genrePlays && g.tagged.before >= min.genrePlays) {
    const { now: tn, before: tb } = g.tagged;
    let best: { genre: string; now: number; before: number; points: number } | null = null;
    for (const r of g.genres) {
      const points = (r.now / tn - r.before / tb) * 100;
      // The threshold in integers: float shares miss it by a hair (35% - 30% is 4.99... points).
      const enough = 100 * (r.now * tb - r.before * tn) >= min.genrePoints * tn * tb;
      if (enough && (!best || points > best.points || (points === best.points && r.genre < best.genre))) best = { ...r, points };
    }
    if (best) {
      const nowPct = share(best.now, g.tagged.now);
      const beforePct = share(best.before, g.tagged.before);
      const previousLabel = kind === "month" ? monthLabel(addMonths(period.start, -1)) : "last week";
      add("genreShift", best.points / 20, {
        stat: { value: nowPct, unit: `of your plays with genre tags were ${best.genre}`, percent: true },
        facts: { genre: best.genre, nowPct, beforePct, deltaPts: nowPct - beforePct, previousLabel, shareOf: GENRE_SHARE_OF },
        defaultHeading: `More ${best.genre}`,
        defaultInsight: `**${best.genre}** made up ${nowPct}% of your plays with genre tags, up from ${beforePct}% ${kind === "month" ? `in ${previousLabel}` : previousLabel}.`,
      });
    }
  }

  const found = x.newObsession;
  if (found && found.plays >= min.obsessionPlays) {
    const t = trackFacts(found.track_id, found);
    const firstHeardLabel = shortLabel(zonedDate(found.first_ms, timeZone));
    add("newObsession", found.plays / 20, {
      stat: { value: found.plays, unit: "plays since you found it" },
      subject: t.subject,
      facts: { plays: found.plays, firstHeardLabel, track: t.name },
      defaultHeading: "New obsession",
      defaultInsight: `You found **${t.name}** on ${firstHeardLabel} and played it ${fmt(found.plays)} times.`,
    });
  }

  // Stable sort: equal scores keep the order above.
  return out.sort((a, b) => b.score - a.score).slice(0, MAX_HIGHLIGHTS);
}

function trackFacts(id: string, t: TrackName | undefined) {
  const name = t?.name ?? "Unknown track";
  return { name, subject: { type: "track" as const, id, name, ...(t?.artists ? { artists: t.artists } : {}) } };
}
