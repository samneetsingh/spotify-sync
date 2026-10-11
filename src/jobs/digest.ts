// Listening digests (Worker-only): a weekly email (Monday to Sunday in TIME_ZONE) and a monthly
// recap, sent through the alert email binding from the daily job. Each sends whenever its period
// hasn't gone out yet (state `recap:last_week` = ISO week, `recap:last_month` = YYYY-MM), so a failed
// send is retried the next day. Only live mode sends; other modes log the text and HTML.
// Sections without data are left out. Cover art comes from Spotify at send time; if that fails the
// email still goes out with placeholder tiles.

import { sendEmail, type AlertConfig, type Email } from "../alerts";
import type { Config } from "../config";
import {
  recapGenres,
  recapNewArtists,
  recapNewTrackCount,
  recapPlayTimes,
  recapRangeCounts,
  recapRepeatPlays,
  recapReturningArtists,
  recapTopArtists,
  recapTopTracks,
  recapTotals,
  type RecapArtist,
  type RecapTotals,
  type RecapTrack,
} from "../db/queries";
import { getState, setState } from "../db/state";
import {
  artistList,
  avatars,
  axis,
  barList,
  captionedTracks,
  cardEnd,
  columns,
  feature,
  heatmap,
  hero,
  playlistPills,
  split,
  tiles,
  trackList,
  type Art,
  type ArtistItem,
  type TrackItem,
} from "../email/components";
import { C, TY, card, fmt, insight, playlistUrl, plays, section, shell, strong } from "../email/layout";
import type { SpotifyImage } from "../spotify/types";
import type { SpotifyClient } from "../spotify/client";
import { PLACEHOLDER_PREFIX, playlistStateKey } from "./owned-playlists";
import { addDays, addMonths, isoWeek, weekdayIndex, zonedDate, zonedHour, zonedMidnight, type LocalDate } from "../utils/time";

const YEAR_MS = 365 * 86_400_000;
const THROWBACK_YEARS = [1, 5];
/** Bumped when public/email/vinyl.png changes, so mail clients don't show a cached old one. */
const VINYL_PATH = "/email/vinyl.png?v=1";
/** The playlists the digest links to (names as the jobs create them). */
const OWNED_PLAYLISTS = [
  { key: "on_this_day", name: "On This Day" },
  { key: "forgotten_favorites", name: "Forgotten Favorites" },
  { key: "holiday", name: "Holiday Favorites" },
];

export type DigestKind = "week" | "month";

export interface Period {
  kind: DigestKind;
  /** First day of the period. */
  start: LocalDate;
  /** First day after it. */
  end: LocalDate;
  /** State value once sent: ISO week ("2026-W40") or month ("2026-09"). */
  key: string;
}

/** The last complete week (Monday to Sunday) or month before `now`, in `timeZone`. */
export function lastPeriod(kind: DigestKind, now: number, timeZone: string): Period {
  const today = zonedDate(now, timeZone);
  if (kind === "month") {
    const start = addMonths(today, -1);
    return { kind, start, end: addMonths(start, 1), key: `${start.year}-${String(start.month).padStart(2, "0")}` };
  }
  const end = addDays(today, -weekdayIndex(today));
  const start = addDays(end, -7);
  return { kind, start, end, key: isoWeek(start) };
}

export interface DigestData {
  period: Period;
  timeZone: string;
  totals: RecapTotals;
  /** The week before (weekly digest only), for the "↓ 48%" deltas. */
  previous: { totals: RecapTotals; newTrackCount: number } | null;
  topTracks: RecapTrack[];
  topArtists: RecapArtist[];
  newTrackCount: number;
  newArtists: RecapArtist[];
  /** Plays of tracks played before the period (the rest are first listens). */
  repeatPlays: number;
  /** Plays per local day of the period. */
  days: number[];
  /** Plays by weekday (Monday first) and local hour. */
  hours: number[][];
  // Monthly only (empty for weeks):
  returning: Array<RecapArtist & { last_before_ms: number }>;
  genres: Array<{ genre: string; plays: number }>;
  /** The 12 months ending with this one, oldest first. */
  year: Array<{ month: LocalDate; plays: number }>;
  throwbacks: Array<{ year: number; track: RecapTrack }>;
  // Presentation:
  art: Art;
  playlists: Array<{ name: string; url: string }>;
  /** The vinyl record image; null when the Worker has no public URL (tests, local runs). */
  discUrl: string | null;
}

export interface DigestResult {
  period: string;
  sent: boolean;
}

export const runWeeklyDigest = (cfg: Config, db: D1Database, sp: ArtSource, alerts: AlertConfig, now = Date.now()) =>
  runDigest("week", cfg, db, sp, alerts, now);

export const runMonthlyRecap = (cfg: Config, db: D1Database, sp: ArtSource, alerts: AlertConfig, now = Date.now()) =>
  runDigest("month", cfg, db, sp, alerts, now);

async function runDigest(
  kind: DigestKind,
  cfg: Config,
  db: D1Database,
  sp: ArtSource,
  alerts: AlertConfig,
  now: number,
): Promise<DigestResult | null> {
  const job = kind === "month" ? "monthly-recap" : "weekly-digest";
  const stateKey = kind === "month" ? "recap:last_month" : "recap:last_week";
  const period = lastPeriod(kind, now, cfg.timeZone);
  if ((await getState(db, stateKey)) === period.key) return null;

  const data = await loadDigest(db, sp, period, cfg.timeZone, alerts.publicUrl);
  if (!data) {
    console.log(JSON.stringify({ job, period: period.key, skipped: "no plays" }));
    return null;
  }
  const email = renderDigest(data);
  if (cfg.writeMode !== "live") {
    console.log(JSON.stringify({ job, writeMode: cfg.writeMode, period: period.key, would_send: email.subject, html_kb: Math.round(email.html!.length / 1024) }));
    console.log(email.text);
    console.log(email.html); // for previewing the email from a dry run
    return { period: period.key, sent: false };
  }
  const sent = await sendEmail(alerts, email);
  if (sent) await setState(db, stateKey, period.key);
  console.log(JSON.stringify({ job, period: period.key, sent }));
  // Email is set up but this send failed: fail the job so withJob alerts (a plain alert can get
  // through where the digest didn't). It is retried tomorrow.
  if (!sent && alerts.binding && alerts.from && alerts.to) {
    throw new Error(`The ${period.key} ${kind === "month" ? "recap" : "digest"} email could not be sent; retrying tomorrow`);
  }
  return { period: period.key, sent };
}

// ---------------------------------------------------------------------------- data

/** What the digest needs from Spotify: cover art and artist photos. */
export type ArtSource = Pick<SpotifyClient, "getTracks" | "getArtists">;

/** Everything the digest shows, or null when the period has no plays. */
export async function loadDigest(
  db: D1Database,
  sp: ArtSource,
  period: Period,
  timeZone: string,
  publicUrl?: string,
): Promise<DigestData | null> {
  const range = (start: LocalDate, end: LocalDate) => [zonedMidnight(start, timeZone), zonedMidnight(end, timeZone)] as const;
  const [from, to] = range(period.start, period.end);
  const totals = await recapTotals(db, from, to);
  if (!totals.plays) return null;

  const month = period.kind === "month";
  const days: LocalDate[] = [];
  for (let d = period.start; zonedMidnight(d, timeZone) < to; d = addDays(d, 1)) days.push(d);
  const prevStart = addDays(period.start, -7);
  const yearMonths = month ? Array.from({ length: 12 }, (_, i) => addMonths(period.start, i - 11)) : [];

  const [topTracks, topArtists, newTrackCount, newArtists, repeatPlays, times, previous, returning, genres, yearCounts, pastTops, playlists] =
    await Promise.all([
      recapTopTracks(db, from, to, 5),
      recapTopArtists(db, from, to, 5),
      recapNewTrackCount(db, from, to),
      recapNewArtists(db, from, to, 3),
      recapRepeatPlays(db, from, to),
      recapPlayTimes(db, from, to),
      month
        ? null
        : Promise.all([recapTotals(db, ...range(prevStart, period.start)), recapNewTrackCount(db, ...range(prevStart, period.start))]).then(
            ([t, n]) => ({ totals: t, newTrackCount: n }),
          ),
      month ? recapReturningArtists(db, from, to, { idleMs: YEAR_MS, minEarlierPlays: 10, minPlays: 3, limit: 3 }) : [],
      month ? recapGenres(db, from, to, 5) : [],
      recapRangeCounts(db, yearMonths.map((m) => [...range(m, addMonths(m, 1))] as [number, number])),
      month
        ? Promise.all(THROWBACK_YEARS.map((y) => recapTopTracks(db, ...range({ ...period.start, year: period.start.year - y }, { ...period.end, year: period.end.year - y }), 1)))
        : [],
      ownedPlaylistLinks(db),
    ]);

  const throwbacks = THROWBACK_YEARS.flatMap((y, i) => {
    const track = pastTops[i]?.[0];
    return track ? [{ year: period.start.year - y, track }] : [];
  });
  const art = await loadArt(sp, [...topTracks, ...throwbacks.map((t) => t.track)].map((t) => t.track_id), [...topArtists, ...newArtists, ...returning].map((a) => a.artist_id));

  return {
    period,
    timeZone,
    totals,
    previous,
    topTracks,
    topArtists,
    newTrackCount,
    newArtists,
    repeatPlays,
    ...bucket(times, days, timeZone),
    returning,
    genres,
    year: yearMonths.map((m, i) => ({ month: m, plays: yearCounts[i] ?? 0 })),
    throwbacks,
    art,
    playlists,
    discUrl: publicUrl ? `${publicUrl.replace(/\/$/, "")}${VINYL_PATH}` : null,
  };
}

/** Plays per local day and per weekday x local hour. `times` must be sorted ascending. */
export function bucket(times: number[], days: LocalDate[], timeZone: string): { days: number[]; hours: number[][] } {
  const starts = [...days, addDays(days.at(-1)!, 1)].map((d) => zonedMidnight(d, timeZone));
  const perDay = days.map(() => 0);
  const hours = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
  let i = 0;
  for (const t of times) {
    while (i < days.length - 1 && t >= starts[i + 1]!) i++;
    perDay[i]!++;
    // Plain arithmetic on 24-hour days; ask the zone on the two DST days a year.
    const hour = starts[i + 1]! - starts[i]! === 86_400_000 ? Math.floor((t - starts[i]!) / 3_600_000) : zonedHour(t, timeZone);
    hours[weekdayIndex(days[i]!)]![hour]!++;
  }
  return { days: perDay, hours };
}

/** Image URLs for the tracks' albums and the artists. Never throws: a failure means no art. */
export async function loadArt(sp: ArtSource, trackIds: string[], artistIds: string[]): Promise<Art> {
  const art: Art = {};
  const uniq = (ids: string[]) => [...new Set(ids)].slice(0, 50); // one batch request each
  try {
    const [tracks, artists] = await Promise.all([
      trackIds.length ? sp.getTracks(uniq(trackIds)) : { tracks: [] },
      artistIds.length ? sp.getArtists(uniq(artistIds)) : { artists: [] },
    ]);
    for (const t of tracks.tracks ?? []) if (t?.id) art[t.id] = pickImage(t.album?.images);
    for (const a of artists.artists ?? []) if (a?.id) art[a.id] = pickImage(a.images);
  } catch (err) {
    console.warn(JSON.stringify({ digest: "art unavailable", error: err instanceof Error ? err.message : String(err) }));
  }
  return art;
}

/** The smallest image at least 300px wide (sharp at the sizes the email uses), else the largest. */
export function pickImage(images: SpotifyImage[] | null | undefined): string | undefined {
  const sized = (images ?? []).filter((i) => i.url).sort((a, b) => (a.width ?? 0) - (b.width ?? 0));
  return (sized.find((i) => (i.width ?? 0) >= 300) ?? sized.at(-1))?.url ?? undefined;
}

async function ownedPlaylistLinks(db: D1Database): Promise<Array<{ name: string; url: string }>> {
  const ids = await Promise.all(OWNED_PLAYLISTS.map((p) => getState(db, playlistStateKey(p.key))));
  return OWNED_PLAYLISTS.flatMap((p, i) => {
    const id = ids[i];
    return id && id !== "off" && !id.startsWith(PLACEHOLDER_PREFIX) ? [{ name: p.name, url: playlistUrl(id) }] : [];
  });
}

// ---------------------------------------------------------------------------- rendering

const utc = (opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-US", { ...opts, timeZone: "UTC" });
const dateMs = (d: LocalDate) => Date.UTC(d.year, d.month - 1, d.day);
const MONTH = utc({ month: "long" });
const MONTH_NARROW = utc({ month: "narrow" });
const SHORT = utc({ month: "short", day: "numeric" });
const LONG_DAY = utc({ weekday: "long", month: "long", day: "numeric" });
const WEEKDAY = utc({ weekday: "long" });
const WEEKDAYS = ["Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays", "Sundays"];
const hourLabel = (h: number) => `${h % 12 || 12} ${h < 12 ? "AM" : "PM"}`;
const pct = (now: number, before: number) => (before ? Math.round(((now - before) / before) * 100) : null);
const indexOfMax = (xs: number[]) => xs.reduce((best, x, i) => (x > xs[best]! ? i : best), 0);

const trackItem = (t: RecapTrack): TrackItem => ({ id: t.track_id, name: t.name ?? "Unknown track", artists: t.artists ?? "", plays: t.plays });
const artistItem = (a: RecapArtist): ArtistItem => ({ id: a.artist_id, name: a.name, plays: a.plays });

/** The digest as an email: subject, preheader, HTML and a plain-text version from the same data. */
export function renderDigest(d: DigestData): Email {
  const month = d.period.kind === "month";
  const last = addDays(d.period.end, -1);
  const monthName = MONTH.format(dateMs(d.period.start));
  const [title, sub] = month ? [monthName, String(d.period.start.year)] : [`${SHORT.format(dateMs(d.period.start))} to`, SHORT.format(dateMs(last))];
  const label = month ? `${monthName} ${d.period.start.year}` : `${title} ${sub}`;
  const hours = Math.round(d.totals.ms / 3_600_000);
  const top = d.topTracks[0] ? trackItem(d.topTracks[0]) : null;
  const topArtist = d.topArtists[0]?.name;
  const unit = month ? "month" : "week";
  const text: string[] = [];
  const html: string[] = [];
  const add = (h: string, t: string[]) => {
    html.push(h);
    text.push("", ...t);
  };

  // Hero and tiles
  const change = d.previous ? pct(d.totals.plays, d.previous.totals.plays) : null;
  const vsLast =
    change === null ? "" : Math.abs(change) < 5 ? ", about the same as last week" : `, ${Math.abs(change)}% ${change < 0 ? "less" : "more"} than last week`;
  const lead = [
    `${plays(d.totals.plays)}${vsLast}.`,
    top ? `${top.name} on repeat${topArtist ? `, ${topArtist} all ${unit}` : ""}.` : "",
  ].join(" ").trim();
  html.push(hero(`Your ${unit} in music`, title, sub, lead));
  text.push(`Your ${unit} in music: ${label}`, lead);
  const stat = (value: number, label: string, before?: number) => ({ value: fmt(value), label, delta: before === undefined ? undefined : pct(value, before) });
  const p = d.previous;
  const statTiles = month
    ? [stat(hours, "hours"), stat(d.totals.tracks, "tracks"), stat(d.totals.artists, "artists")]
    : [stat(d.totals.plays, "plays", p?.totals.plays), stat(hours, "hours", p ? Math.round(p.totals.ms / 3_600_000) : undefined), stat(d.newTrackCount, "new tracks", p?.newTrackCount)];
  html.push(tiles(statTiles));
  text.push(statTiles.map((s) => `${s.value} ${s.label}${s.delta == null ? "" : ` (${s.delta < 0 ? "" : "+"}${s.delta}%)`}`).join(" · "));

  // Top tracks and artists
  if (top) {
    add(feature(`Song of the ${unit}`, top, d.art[top.id], d.discUrl ?? undefined), [`Song of the ${unit}: ${top.name}${top.artists ? ` by ${top.artists}` : ""} (${plays(top.plays)})`]);
  }
  const rest = d.topTracks.slice(1).map(trackItem);
  if (rest.length) {
    add(trackList("Also on repeat", rest, d.art, 2, top!.plays), ["Also on repeat", ...rest.map((t, i) => `  ${i + 2}. ${t.name}${t.artists ? ` — ${t.artists}` : ""} (${plays(t.plays)})`)]);
  }
  if (d.topArtists.length) {
    const artists = d.topArtists.map(artistItem);
    add(avatars("Top artists", artists, d.art), ["Top artists", ...artists.map((a, i) => `  ${i + 1}. ${a.name} (${plays(a.plays)})`)]);
  }
  if (d.genres.length) {
    add(section("Your sound", card(barList(d.genres.map((g) => ({ label: g.genre, value: g.plays }))))), ["Your sound", ...d.genres.map((g) => `  ${g.genre} (${plays(g.plays)})`)]);
  }

  // When you listened
  const busiest = indexOfMax(d.days);
  const busiestDay = addDays(d.period.start, busiest);
  if (month) {
    const sentence = `Your biggest day was ${LONG_DAY.format(dateMs(busiestDay))}, with ${plays(d.days[busiest]!)}.`;
    const ends = [d.period.start, addDays(d.period.start, 14), last].map((x) => SHORT.format(dateMs(x)));
    add(
      section("Day by day", card(insight(`Your biggest day was ${strong(LONG_DAY.format(dateMs(busiestDay)))}, with ${plays(d.days[busiest]!)}.`) + columns(d.days, { highlight: busiest }) + axis(ends))),
      ["Day by day", `  ${sentence}`],
    );
    const flat = d.hours.flat();
    const peak = indexOfMax(flat);
    const when = `${WEEKDAYS[Math.floor(peak / 24)]} around ${hourLabel(peak % 24)}`;
    add(section("When you listen", card(insight(`You listen most on ${strong(when)}.`) + heatmap(d.hours))), ["When you listen", `  You listen most on ${when}.`]);
  } else {
    const day = WEEKDAY.format(dateMs(busiestDay));
    add(
      section("Your week", card(insight(`${strong(day)} was your biggest day, with ${plays(d.days[busiest]!)}.`) + columns(d.days, { height: 80, highlight: busiest, gap: 6 }) + axis(["M", "T", "W", "T", "F", "S", "S"]))),
      ["Your week", `  ${day} was your biggest day, with ${plays(d.days[busiest]!)}.`],
    );
    const byHour = Array.from({ length: 24 }, (_, h) => d.hours.reduce((sum, row) => sum + row[h]!, 0));
    const peak = indexOfMax(byHour);
    add(
      section("Time of day", card(insight(`Your peak hour was ${strong(hourLabel(peak))}.`) + columns(byHour, { height: 64, highlight: peak }) + axis(["12 AM", "12 PM", "11 PM"]))),
      ["Time of day", `  Your peak hour was ${hourLabel(peak)}.`],
    );
  }
  if (month && d.year.filter((m) => m.plays).length >= 2) {
    const prev = d.year.at(-2)!;
    const best = d.year[indexOfMax(d.year.map((m) => m.plays))]!;
    const diff = pct(d.totals.plays, prev.plays);
    const prevName = MONTH.format(dateMs(prev.month));
    const bestName = MONTH.format(dateMs(best.month));
    const trend = diff === null ? "" : `, ${diff < 0 ? "down" : "up"} ${Math.abs(diff)}% from ${prevName}`;
    add(
      section(
        "Your year",
        card(
          insight(`${strong(plays(d.totals.plays))}${trend}. Your biggest month was ${strong(bestName)}.`) +
            columns(d.year.map((m) => m.plays), { height: 72, highlight: 11, gap: 3 }) +
            axis(d.year.map((m) => MONTH_NARROW.format(dateMs(m.month)))),
        ),
      ),
      ["Your year", `  ${plays(d.totals.plays)}${trend}. Your biggest month was ${bestName}.`],
    );
  }

  // Discoveries and comebacks
  if (d.newTrackCount || d.newArtists.length) {
    const newTracks = `track${d.newTrackCount === 1 ? "" : "s"} you'd never played before`;
    const artists = d.newArtists.map(artistItem);
    add(
      section(
        "New to you",
        card(
          `<div style="${TY.number};color:${C.green}">${fmt(d.newTrackCount)}</div><div style="${TY.body};color:${C.soft};margin-top:4px">${newTracks}</div>` +
            `<div style="margin:16px 0 ${artists.length ? 24 : 0}px">${split({ label: "old favorites", value: d.repeatPlays }, { label: "new finds", value: d.totals.plays - d.repeatPlays })}</div>` +
            (artists.length ? `<div style="${TY.meta};color:${C.mute};margin-bottom:4px">First listens</div>${artistList(artists, d.art)}` : ""),
        ),
      ),
      ["New to you", `  ${fmt(d.newTrackCount)} ${newTracks}`, ...artists.map((a) => `  - ${a.name} (first listen, ${plays(a.plays)})`)],
    );
  }
  if (d.returning.length) {
    const since = new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric", timeZone: d.timeZone });
    const note = (a: RecapArtist & { last_before_ms: number }) => `${plays(a.plays)}, first since ${since.format(a.last_before_ms)}`;
    add(
      section("Welcome back", card(artistList(d.returning.map(artistItem), d.art, (a) => note(d.returning.find((r) => r.artist_id === a.id)!)))),
      ["Welcome back", ...d.returning.map((a) => `  - ${a.name} (${note(a)})`)],
    );
  }
  if (d.throwbacks.length) {
    const items = d.throwbacks.map((tb) => ({ caption: `${monthName} ${tb.year}`, track: trackItem(tb.track), note: `Your top song that month, ${plays(tb.track.plays)}` }));
    add(section("Throwback", card(captionedTracks(items, d.art))), ["Throwback", ...items.map((i) => `  - ${i.caption}: ${i.track.name}${i.track.artists ? ` — ${i.track.artists}` : ""} (${i.note.toLowerCase()})`)]);
  }

  html.push(playlistPills(d.playlists), cardEnd);
  if (d.playlists.length) text.push("", `Still updating in your library: ${d.playlists.map((l) => l.name).join(", ")}.`);
  text.push("", "Sent by spotify-sync.");

  const subject = month ? `Your ${label} in music: ${plays(d.totals.plays)}` : `Your week in music, ${label}: ${plays(d.totals.plays)}`;
  const preheader = `${plays(d.totals.plays)} and ${fmt(hours)} hour${hours === 1 ? "" : "s"}.${top ? ` Song of the ${unit}: ${top.name}${top.artists ? ` by ${top.artists}` : ""}.` : ""}`;
  return { subject, text: text.join("\n").trim(), html: shell({ title: subject, preheader, body: html.join("\n") }) };
}
