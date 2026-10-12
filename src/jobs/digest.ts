// Listening digests (Worker-only): a weekly email (Monday to Sunday in TIME_ZONE) and a monthly
// recap, sent through the alert email binding from the daily job. Each sends whenever its period
// hasn't gone out yet (state `recap:last_week` = ISO week, `recap:last_month` = YYYY-MM), so a failed
// send is retried the next day. Only live mode sends; other modes log the text and HTML.
// Sections without data are left out. Cover art comes from Spotify at send time; if that fails the
// email still goes out with placeholder tiles. The period's seasonal theme (src/email/themes.ts)
// applies either way; the optional AI editor (src/editor) may re-order and re-word the email, and
// any problem with it falls back to the default layout.

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
import { planDigest } from "../editor";
import { buildEditorInput } from "../editor/input";
import type { EditorConfig, ResolvedPlan, ThemeId } from "../editor/types";
import { cardEnd, hero, playlistPills, tiles, type Art } from "../email/components";
import { playlistUrl, shell } from "../email/layout";
import { defaultLayout, digestCopy, renderContext, renderSection, statTiles } from "../email/sections";
import { THEMES, seasonalTheme, tokensFor } from "../email/themes";
import type { SpotifyImage } from "../spotify/types";
import type { SpotifyClient } from "../spotify/client";
import { PLACEHOLDER_PREFIX, playlistStateKey } from "./owned-playlists";
import { addDays, addMonths, isoWeek, weekdayIndex, zonedDate, zonedHour, zonedMidnight, type LocalDate } from "../utils/time";

const YEAR_MS = 365 * 86_400_000;
/** Gmail clips emails over 102 KB; an edited email above this is sent in the default layout. */
const MAX_HTML_BYTES = 100_000;
/** Throwbacks: the top song of the same month this many years ago (the dashboard's Home too). */
export const THROWBACK_YEARS = [1, 5];
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

/** The AI editor stays off unless the caller passes a config (src/index.ts: AI_EDITOR + OPENAI_API_KEY). */
const EDITOR_OFF: EditorConfig = { enabled: false, apiKey: null };

export const runWeeklyDigest = (cfg: Config, db: D1Database, sp: ArtSource, alerts: AlertConfig, now = Date.now(), editor = EDITOR_OFF) =>
  runDigest("week", cfg, db, sp, alerts, now, editor);

export const runMonthlyRecap = (cfg: Config, db: D1Database, sp: ArtSource, alerts: AlertConfig, now = Date.now(), editor = EDITOR_OFF) =>
  runDigest("month", cfg, db, sp, alerts, now, editor);

async function runDigest(
  kind: DigestKind,
  cfg: Config,
  db: D1Database,
  sp: ArtSource,
  alerts: AlertConfig,
  now: number,
  editorCfg: EditorConfig,
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
  const email = await composeDigest(job, db, sp, data, editorCfg, now);
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

/**
 * The dashboard's "Send me a preview": the last complete week's or month's digest, built exactly
 * like the real one (same data, editor and theme) but with "[Preview] " before the subject. It never
 * reads or writes `recap:*`, so the real send still happens. An editor call counts toward the
 * monthly cap like any other. Only live mode sends; other modes log it like runDigest. Null when
 * the period has no plays.
 */
export async function previewDigest(
  kind: DigestKind,
  cfg: Config,
  db: D1Database,
  sp: ArtSource,
  email: AlertConfig,
  now = Date.now(),
  editorCfg = EDITOR_OFF,
): Promise<DigestResult | null> {
  const job = kind === "month" ? "monthly-recap-preview" : "weekly-digest-preview";
  const period = lastPeriod(kind, now, cfg.timeZone);
  const data = await loadDigest(db, sp, period, cfg.timeZone, email.publicUrl);
  if (!data) return null;
  const composed = await composeDigest(job, db, sp, data, editorCfg, now);
  const preview: Email = { ...composed, subject: `[Preview] ${composed.subject}` };
  if (cfg.writeMode !== "live") {
    console.log(JSON.stringify({ job, writeMode: cfg.writeMode, period: period.key, would_send: preview.subject, html_kb: Math.round(preview.html!.length / 1024) }));
    console.log(preview.text);
    console.log(preview.html);
    return { period: period.key, sent: false };
  }
  const sent = await sendEmail(email, preview);
  console.log(JSON.stringify({ job, period: period.key, sent }));
  return { period: period.key, sent };
}

/**
 * The email for `data`: the editor's plan when it returns a valid one that fits under Gmail's clip
 * size, else the default layout. The theme is the plan's, or the period's seasonal one.
 */
async function composeDigest(job: string, db: D1Database, sp: ArtSource, data: DigestData, editorCfg: EditorConfig, now: number): Promise<Email> {
  const { plan } = await planDigest(db, editorCfg, { job, now, load: () => buildEditorInput(db, data, data.timeZone) });
  const theme = plan?.theme ?? seasonalTheme(addDays(data.period.end, -1));
  if (!plan) return renderDigest(data, { theme });

  // Highlight cards show a song or artist the loader may not have fetched art for.
  const subjects = plan.sections.flatMap((s) => (s.highlight?.subject && !(s.highlight.subject.id in data.art) ? [s.highlight.subject] : []));
  const ids = (type: "track" | "artist") => subjects.filter((s) => s.type === type).map((s) => s.id);
  const art = subjects.length ? { ...data.art, ...(await loadArt(sp, ids("track"), ids("artist"))) } : data.art;

  const email = renderDigest({ ...data, art }, { plan, theme });
  const bytes = new TextEncoder().encode(email.html ?? "").length;
  if (bytes <= MAX_HTML_BYTES) return email;
  console.warn(JSON.stringify({ job, editor: "fallback", reason: "size", bytes }));
  return renderDigest(data, { theme });
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

/**
 * The digest as an email: subject, preheader, HTML and a plain-text version from the same data.
 * An editor `plan` replaces the headline, lead, preheader and the middle sections (code still renders
 * every number and chart); `theme` recolours the accents and the hero. Without either this is the
 * default email. The subject never changes.
 */
export function renderDigest(d: DigestData, opts: { plan?: ResolvedPlan | null; theme?: ThemeId } = {}): Email {
  const { plan = null, theme = "default" } = opts;
  const c = renderContext(d, tokensFor(theme));
  const copy = digestCopy(d);
  const text: string[] = [];
  const html: string[] = [];

  // Hero and tiles
  const { kicker, ornament } = THEMES[theme];
  const lead = plan?.lead ?? copy.lead;
  html.push(hero(`${ornament ? `${ornament} ` : ""}${kicker ?? `Your ${c.unit} in music`}`, plan?.headline ?? copy.title, plan ? copy.label : copy.sub, lead, c.t));
  text.push(`Your ${c.unit} in music: ${copy.label}`, ...(plan ? [plan.headline] : []), lead);
  const stats = statTiles(d);
  html.push(tiles(stats));
  text.push(stats.map((s) => `${s.value} ${s.label}${s.delta == null ? "" : ` (${s.delta < 0 ? "" : "+"}${s.delta}%)`}`).join(" · "));

  // The middle: the plan's sections, else every section with data
  for (const s of plan?.sections ?? defaultLayout(d.period.kind, d)) {
    const block = renderSection(c, s);
    if (!block) continue;
    html.push(block.html);
    text.push("", ...block.text);
  }

  html.push(playlistPills(d.playlists), cardEnd);
  if (d.playlists.length) text.push("", `Still updating in your library: ${d.playlists.map((l) => l.name).join(", ")}.`);
  text.push("", "Sent by spotify-sync.");

  const preheader = plan?.preheader ?? copy.preheader;
  return { subject: copy.subject, text: text.join("\n").trim(), html: shell({ title: copy.subject, preheader, body: html.join("\n") }) };
}
