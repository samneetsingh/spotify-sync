// Playlists rebuilt from the whole listening history (Worker-only; no Python original):
// - On This Day, daily: what you played on today's local date in each past year.
// - Forgotten Favorites, weekly: songs you played a lot but not in over a year.
//
// Both are owned playlists (see owned-playlists.ts), rewritten whole with
// replacePlaylistItems. `playlist:<key>:period` holds the day/week last written, so
// reruns are no-ops. Each runs only with its setting on (cfg.features); switching one off
// leaves its playlist and `state` alone, so switching it back on carries on with the same one.

import type { Config } from "../config";
import { forgottenTracks, recordActions, tracksPlayedIn, type PlaylistTrackRef } from "../db/queries";
import { getState, setState } from "../db/state";
import type { SpotifyClient } from "../spotify/client";
import { addDays, formatDate, isoWeek, isValidDate, zonedDate, zonedMidnight, type LocalDate } from "../utils/time";
import { ensurePlaylist, followChecker, PLACEHOLDER_PREFIX, playlistStateKey, type OwnedPlaylist } from "./owned-playlists";

const MAX_ITEMS = 100; // what one replace call accepts
const FIRST_YEAR = 2008; // Spotify launched; no plays before this
const DAY_MS = 86_400_000;

export interface HistoryPlaylistsResult {
  /** Tracks written per playlist; null when skipped (off in settings, deleted in Spotify, or already current). */
  onThisDay: number | null;
  forgottenFavorites: number | null;
}

interface PlaylistSpec extends OwnedPlaylist {
  /** Its setting; off skips it without touching `state`. */
  enabled: boolean;
  /** The day or week this run writes; the playlist is only rewritten when it changes. */
  period: string;
  pick: () => Promise<PlaylistTrackRef[]>;
}

export async function runHistoryPlaylists(
  cfg: Config,
  db: D1Database,
  sp: SpotifyClient,
  now = Date.now(),
): Promise<HistoryPlaylistsResult> {
  const h = cfg.historyPlaylists;
  const today = zonedDate(now, cfg.timeZone);
  const week = isoWeek(today);
  const isFollowed = followChecker(sp); // only consulted when an existing playlist needs writing
  try {
    const onThisDay = await refresh(cfg, db, sp, isFollowed, {
      key: "on_this_day",
      enabled: cfg.features.onThisDay,
      name: "On This Day",
      description: "What you played on this date in years past, oldest first. Refreshed every morning by spotify-sync.",
      period: formatDate(today),
      pick: () => onThisDayTracks(db, today, cfg),
    });
    const forgottenFavorites = await refresh(cfg, db, sp, isFollowed, {
      key: "forgotten_favorites",
      enabled: cfg.features.forgottenFavorites,
      name: "Forgotten Favorites",
      description: `Songs you've played ${h.forgottenMinPlays}+ times but not in over a year. A new set every Monday, by spotify-sync.`,
      period: week,
      pick: () => forgottenFavoriteTracks(db, week, now - h.forgottenIdleDays * DAY_MS, cfg),
    });
    const result = { onThisDay, forgottenFavorites };
    console.log(JSON.stringify({ job: "history-playlists", writeMode: cfg.writeMode, today: formatDate(today), ...result }));
    return result;
  } finally {
    await recordActions(db, "history-playlists", cfg.writeMode, null, sp.drainActions());
  }
}

/** Creates the playlist if needed and replaces its tracks; returns how many, or null if skipped. */
async function refresh(
  cfg: Config,
  db: D1Database,
  sp: SpotifyClient,
  isFollowed: (playlistId: string) => Promise<boolean>,
  spec: PlaylistSpec,
): Promise<number | null> {
  if (!spec.enabled) return null;
  const writeState = cfg.writeMode !== "dry_run";
  const periodKey = `${playlistStateKey(spec.key)}:period`;
  const stored = await getState(db, playlistStateKey(spec.key));
  if (stored === "off") return null;
  if (stored && (await getState(db, periodKey)) === spec.period) return null;

  const tracks = await spec.pick();
  if (!tracks.length) return 0; // keep the previous tracks rather than empty the playlist

  const playlistId = await ensurePlaylist(cfg, db, sp, spec, isFollowed);
  if (!playlistId) return null;
  // Any write error fails the job (and alerts); the next run retries with the same playlist.
  await sp.replacePlaylistItems(playlistId, tracks.slice(0, MAX_ITEMS).map((t) => t.track_uri));
  if (writeState && !playlistId.startsWith(PLACEHOLDER_PREFIX)) await setState(db, periodKey, spec.period);
  return Math.min(tracks.length, MAX_ITEMS);
}

/**
 * Each past year's most played tracks on today's date (local time), oldest year first,
 * each track once. Every year gets the same quota so recent years always fit.
 */
async function onThisDayTracks(db: D1Database, today: LocalDate, cfg: Config): Promise<PlaylistTrackRef[]> {
  const days: LocalDate[] = [];
  for (let year = FIRST_YEAR; year < today.year; year++) {
    const day = { ...today, year };
    if (isValidDate(day)) days.push(day); // Feb 29 only in leap years
  }
  const byDay = await tracksPlayedIn(
    db,
    days.map((d) => [zonedMidnight(d, cfg.timeZone), zonedMidnight(addDays(d, 1), cfg.timeZone)]),
  );
  const perYear = Math.min(cfg.historyPlaylists.onThisDayPerYear, Math.floor(MAX_ITEMS / Math.max(1, byDay.size)));

  const seen = new Set<string>();
  const out: PlaylistTrackRef[] = [];
  for (const [, tracks] of [...byDay].sort(([a], [b]) => a - b)) {
    for (const t of tracks.filter((t) => !seen.has(t.track_id)).slice(0, perYear)) {
      seen.add(t.track_id);
      out.push({ track_id: t.track_id, track_uri: t.track_uri });
    }
  }
  return out;
}

/** This week's sample of forgotten favorites, biggest former favorites first. */
async function forgottenFavoriteTracks(db: D1Database, week: string, idleSinceMs: number, cfg: Config): Promise<PlaylistTrackRef[]> {
  const h = cfg.historyPlaylists;
  const candidates = await forgottenTracks(db, h.forgottenMinPlays, idleSinceMs);
  // Ranking by a hash of week + track gives a stable sample that changes every week.
  return candidates
    .map((t) => ({ t, rank: fnv1a(`${week}:${t.track_id}`) }))
    .sort((a, b) => a.rank - b.rank)
    .slice(0, h.forgottenSize)
    .map(({ t }) => t)
    .sort((a, b) => b.plays - a.plays)
    .map(({ track_id, track_uri }) => ({ track_id, track_uri }));
}

/** 32-bit FNV-1a, a cheap stable string hash. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}
