// What the AI editor is told about the period: the digest's numbers, rounded and labelled the way
// the email shows them. The model may only cite numbers found here (or in a highlight), so every
// percentage, hour count and date label is computed in code.

import type { DigestData } from "../jobs/digest";
import { addDays, addMonths, type LocalDate } from "../utils/time";
import type { DigestFacts, Pct } from "./types";

// Calendar dates are formatted in UTC so the label is the date itself, whatever the zone.
const utc = (opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-US", { ...opts, timeZone: "UTC" });
const dateMs = (d: LocalDate) => Date.UTC(d.year, d.month - 1, d.day);
const MONTH = utc({ month: "long" });
const SHORT = utc({ month: "short", day: "numeric" });
const LONG_DAY = utc({ weekday: "long", month: "long", day: "numeric" });
const WEEKDAYS = ["Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays", "Sundays"];

/** "September" */
export const monthLabel = (d: LocalDate) => MONTH.format(dateMs(d));
/** "Sep 3" */
export const shortLabel = (d: LocalDate) => SHORT.format(dateMs(d));
/** "Tuesday, September 1" */
export const dayLabel = (d: LocalDate) => LONG_DAY.format(dateMs(d));
/** "11 PM" */
export const hourLabel = (h: number) => `${h % 12 || 12} ${h < 12 ? "AM" : "PM"}`;
/** "May 2024": the month of `ms` in `timeZone` (the email's "first since"). */
export const sinceLabel = (ms: number, timeZone: string) =>
  new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric", timeZone }).format(ms);

/** Whole-number percentage of `total`. */
export const share = (part: number, total: number) => Math.round((part / Math.max(1, total)) * 100);

/** Rounded change from `before` to `now` (as the email's "↓ 48%"), or undefined without a baseline. */
export function change(now: number, before: number): Pct | undefined {
  if (!before) return undefined;
  const p = Math.round(((now - before) / before) * 100);
  return { pct: Math.abs(p), direction: p > 0 ? "up" : p < 0 ? "down" : "same" };
}

const indexOfMax = (xs: number[]) => xs.reduce((best, x, i) => (x > xs[best]! ? i : best), 0);
const hoursOf = (ms: number) => Math.round(ms / 3_600_000);

/** The facts for `d`, in the shape the editor's prompt sends. Optional parts are left out when empty. */
export function buildFacts(d: DigestData): DigestFacts {
  const { period } = d;
  const month = period.kind === "month";
  const hours = hoursOf(d.totals.ms);
  const facts: DigestFacts = {
    period: {
      kind: period.kind,
      label: month ? `${monthLabel(period.start)} ${period.start.year}` : `${shortLabel(period.start)} to ${shortLabel(addDays(period.end, -1))}`,
      days: d.days.length,
      previousLabel: month ? monthLabel(addMonths(period.start, -1)) : "last week",
    },
    totals: { plays: d.totals.plays, hours, tracks: d.totals.tracks, artists: d.totals.artists, newTracks: d.newTrackCount },
    topTracks: d.topTracks.map((t, i) => ({ rank: i + 1, name: t.name ?? "Unknown track", artists: t.artists ?? "", plays: t.plays })),
    topArtists: d.topArtists.map((a, i) => ({ rank: i + 1, name: a.name, plays: a.plays, sharePct: share(a.plays, d.totals.plays) })),
  };

  // Weeks compare with the week before; months only know last month's play count (from the year chart).
  const prevMonth = month ? d.year.at(-2) : undefined;
  const changes = d.previous
    ? {
        plays: change(d.totals.plays, d.previous.totals.plays),
        hours: change(hours, hoursOf(d.previous.totals.ms)),
        newTracks: change(d.newTrackCount, d.previous.newTrackCount),
      }
    : { plays: prevMonth && change(d.totals.plays, prevMonth.plays) };
  const defined = Object.entries(changes).filter(([, v]) => v);
  if (defined.length) facts.change = Object.fromEntries(defined);

  if (d.genres.length) facts.genres = d.genres.map((g) => ({ name: g.genre, plays: g.plays, sharePct: share(g.plays, d.totals.plays) }));

  const busiest = indexOfMax(d.days);
  if (d.days[busiest]) facts.busiestDay = { label: dayLabel(addDays(period.start, busiest)), plays: d.days[busiest]! };
  if (d.totals.plays) {
    if (month) {
      const peak = indexOfMax(d.hours.flat());
      facts.peak = { label: `${WEEKDAYS[Math.floor(peak / 24)]} around ${hourLabel(peak % 24)}` };
    } else {
      facts.peak = { label: hourLabel(indexOfMax(Array.from({ length: 24 }, (_, h) => d.hours.reduce((sum, row) => sum + row[h]!, 0)))) };
    }
  }

  if (d.newArtists.length) facts.newArtists = d.newArtists.map((a) => ({ name: a.name, plays: a.plays }));
  if (d.returning.length) {
    facts.returningArtists = d.returning.map((a) => ({ name: a.name, plays: a.plays, lastHeardLabel: sinceLabel(a.last_before_ms, d.timeZone) }));
  }
  if (d.throwbacks.length) {
    facts.throwbacks = d.throwbacks.map((tb) => ({
      year: tb.year,
      yearsAgo: period.start.year - tb.year,
      name: tb.track.name ?? "Unknown track",
      artists: tb.track.artists ?? "",
      plays: tb.track.plays,
    }));
  }

  // The year chart shows when two or more months have plays; its change needs last month's plays.
  const yearChange = prevMonth && change(d.totals.plays, prevMonth.plays);
  if (month && yearChange && d.year.filter((m) => m.plays).length >= 2) {
    const best = d.year[indexOfMax(d.year.map((m) => m.plays))]!;
    facts.year = { bestMonthLabel: monthLabel(best.month), bestMonthPlays: best.plays, previousMonthLabel: monthLabel(prevMonth.month), change: yearChange };
  }

  // Same rounding as the email's split bar.
  const old = share(d.repeatPlays, d.totals.plays);
  facts.split = { oldFavoritesPct: old, newFindsPct: 100 - old };
  return facts;
}
