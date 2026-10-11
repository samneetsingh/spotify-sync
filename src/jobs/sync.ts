// Port of src/ingestion/sync_recent.py (sync_recent + sync_all_tracks).
//
// Write-mode gating (README, "Write modes"): the SpotifyClient blocks Spotify writes outside
// live mode; this module skips "state" writes (playlist_tracks, state) in dry_run.
// Metadata (tracks, plays, track_artists, artists, sync_runs) is always written.
//
// Settings: Liked Songs and Frequent Plays each run only when switched on (cfg.features). Frequent
// Plays is an owned playlist (owned-playlists.ts, `state` playlist:frequent), created once it has
// songs to add; deleting it in Spotify switches it off (checked daily by hindi-favorites.ts).

import type { Config } from "../config";
import { getState, setState } from "../db/state";
import {
  LIKED_CACHE_ID,
  createSyncRun,
  existingArtistIds,
  finishSyncRun,
  frequentTracksAmong,
  frequentTracksMissingFrom,
  insertPlays,
  knownPlaylistTrackIds,
  markTracksInPlaylist,
  recordActions,
  runAll,
  tracksMissingFrom,
  upsertArtists,
  upsertTrackArtists,
  upsertTracks,
  type ArtistRow,
  type PlayRow,
  type PlaylistTrackRef,
  type TrackArtistRow,
  type TrackRow,
} from "../db/queries";
import { SpotifyError } from "../spotify/errors";
import type { SpotifyClient } from "../spotify/client";
import { genresJson, trackRows } from "../spotify/metadata";
import { isValidTrack } from "../spotify/playlist";
import { ensurePlaylist, PLACEHOLDER_PREFIX, playlistStateKey, type OwnedPlaylist } from "./owned-playlists";
import { backfillPlaylistCache } from "./playlist-cache";
import type { RecentlyPlayedResponse } from "../spotify/types";
import { chunkArray } from "../utils/batch";
import { isoToMs } from "../utils/time";

const PLAYLIST_MAX_ITEMS = 10_000;
const ARTISTS_BATCH_SIZE = 50;

export interface SyncResult {
  playsFetched: number;
  likedAdded: number;
  frequentAdded: number;
  cursorInMs: number;
  cursorOutMs: number | null;
}

const writesState = (cfg: Config) => cfg.writeMode !== "dry_run";
const isPlaceholder = (playlistId: string) => playlistId.startsWith(PLACEHOLDER_PREFIX);

export const FREQUENT_PLAYLIST: OwnedPlaylist = {
  key: "frequent",
  name: "Frequent Plays",
  description: "The songs you play most, added automatically as you listen by spotify-sync. Songs you remove stay removed.",
};

/**
 * Frequent Plays' target: Config's fixed id (parity fixtures), else the owned playlist's id from
 * `state`; null when it isn't created yet; "off" when the setting or the playlist is off.
 */
async function frequentTarget(cfg: Config, db: D1Database): Promise<string | null> {
  if (!cfg.features.frequent) return "off";
  return cfg.frequentPlaylistId ?? (await getState(db, playlistStateKey(FREQUENT_PLAYLIST.key)));
}

/** Creates Frequent Plays (saved outside dry_run, never as a placeholder). The daily follow check lives in hindi-favorites.ts. */
const createFrequent = (cfg: Config, db: D1Database, sp: SpotifyClient) => ensurePlaylist(cfg, db, sp, FREQUENT_PLAYLIST, async () => true);

function parseRecentlyPlayed(resp: RecentlyPlayedResponse) {
  const plays: PlayRow[] = [];
  const tracks: TrackRow[] = [];
  const trackArtists: TrackArtistRow[] = [];
  const seen = new Set<string>();
  let newestMs = 0;

  for (const item of resp.items ?? []) {
    const track = item?.track;
    if (!item?.played_at || !isValidTrack(track)) continue;

    const playedAtMs = isoToMs(item.played_at);
    newestMs = Math.max(newestMs, playedAtMs);
    plays.push({
      played_at_ms: playedAtMs,
      track_id: track.id,
      track_uri: track.uri,
      context_type: item.context?.type ?? null,
      context_uri: item.context?.uri ?? null,
      source: "recently_played",
    });

    if (seen.has(track.id)) continue;
    seen.add(track.id);
    const rows = trackRows(track);
    tracks.push(rows.track);
    trackArtists.push(...rows.artists);
  }
  return { plays, tracks, trackArtists, newestMs };
}

export async function runSync(
  cfg: Config,
  db: D1Database,
  sp: SpotifyClient,
  now: () => number = Date.now,
): Promise<SyncResult> {
  const stored = await getState(db, cfg.cursorKey);
  const cursorIn = stored !== null ? parseInt(stored, 10) : now() - cfg.bootstrapHours * 3_600_000;
  const runId = await createSyncRun(db, cursorIn);

  let playsFetched = 0;
  let likedAdded = 0;
  let frequentAdded = 0;
  let cursorOut: number | null = null;
  let tracksAddedTotal = 0;

  try {
    const frequent = await frequentTarget(cfg, db);
    if (frequent && frequent !== "off") {
      await maybeRefreshPlaylistCache(cfg, db, sp, frequent, now);
    }

    // Page until exhausted so bursts of > limit plays are not dropped.
    const plays: PlayRow[] = [];
    const tracks = new Map<string, TrackRow>();
    const trackArtists: TrackArtistRow[] = [];
    let marker = cursorIn;
    let newestMs = 0;
    for (;;) {
      const resp = await sp.getRecentlyPlayed({ limit: cfg.recentlyPlayedLimit, after: marker });
      const page = parseRecentlyPlayed(resp ?? {});
      if (!page.plays.length) break;
      plays.push(...page.plays);
      for (const t of page.tracks) tracks.set(t.track_id, t);
      trackArtists.push(...page.trackArtists);
      newestMs = Math.max(newestMs, page.newestMs);
      if ((resp?.items ?? []).length < cfg.recentlyPlayedLimit) break;
      if (page.newestMs <= marker) break; // API repeated the last item
      marker = page.newestMs;
    }

    const trackList = [...tracks.values()];
    playsFetched = plays.length;
    await runAll(db, [
      ...upsertTracks(db, trackList),
      ...insertPlays(db, plays),
      ...upsertTrackArtists(db, trackArtists),
    ]);

    await enrichArtists(db, sp, [...new Set(trackArtists.map((ta) => ta.artist_id))]);

    if (cfg.features.liked) {
      const likedKnown = await knownPlaylistTrackIds(db, LIKED_CACHE_ID, trackList.map((t) => t.track_id));
      const likedMissing = trackList.filter((t) => !likedKnown.has(t.track_id));
      if (likedMissing.length) {
        likedAdded = await addToLiked(sp, likedMissing.map((t) => t.track_id), cfg.likeBatchSize);
        if (writesState(cfg)) await runAll(db, markTracksInPlaylist(db, LIKED_CACHE_ID, refs(likedMissing)));
        tracksAddedTotal += likedAdded;
      }
    }

    if (frequent !== "off") {
      const candidates = trackList.length
        ? await frequentTracksAmong(db, trackList.map((t) => t.track_id), cfg.frequentMinPlays)
        : [];
      // A new owner's playlist appears with its first songs, not as an empty playlist.
      const playlistId = frequent ?? (candidates.length ? await createFrequent(cfg, db, sp) : null);
      if (playlistId) frequentAdded = await addToFrequent(cfg, db, sp, playlistId, candidates);
      tracksAddedTotal += frequentAdded;
    }

    if (newestMs > 0) {
      cursorOut = newestMs + 1;
      if (writesState(cfg)) await setState(db, cfg.cursorKey, String(cursorOut));
    }

    await finishSyncRun(db, runId, { cursorOutMs: cursorOut, playsFetched, tracksAdded: tracksAddedTotal, status: "success" });
    console.log(JSON.stringify({ job: "sync", writeMode: cfg.writeMode, playsFetched, likedAdded, frequentAdded, cursorIn, cursorOut }));
    return { playsFetched, likedAdded, frequentAdded, cursorInMs: cursorIn, cursorOutMs: cursorOut };
  } catch (err) {
    await finishSyncRun(db, runId, {
      cursorOutMs: cursorOut,
      playsFetched,
      tracksAdded: tracksAddedTotal,
      status: "fail",
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  } finally {
    await recordActions(db, "sync", cfg.writeMode, runId, sp.drainActions());
  }
}

export interface SyncFullResult {
  likedAdded: number;
  frequentAdded: number;
  /** Tracks still to add after this call (0 when done); call again while it's above 0. */
  remaining: number;
}

export interface SyncFullOptions {
  /** At most this many tracks per call (Liked Songs first), e.g. per import Workflow step; default all. */
  limit?: number;
  /**
   * Backfill Liked Songs: only with this explicit opt-in (the import's checkbox, off by default)
   * and the Liked Songs setting on. It can add thousands of songs to the owner's library.
   */
  liked?: boolean;
  /** Backfill Frequent Plays (default true) when its setting is on; creates the playlist if needed. */
  frequent?: boolean;
}

/**
 * Port of sync_all_tracks (`spotify sync --full`): backfill Liked Songs and Frequent Plays from the
 * whole DB. Only tracks this call could add next time count as `remaining`: in dry_run nothing is
 * recorded (and a placeholder playlist outside live mode can't be filled), so another call can't
 * progress and `remaining` is 0.
 */
export async function runSyncFull(cfg: Config, db: D1Database, sp: SpotifyClient, opts: SyncFullOptions = {}): Promise<SyncFullResult> {
  if (opts.limit !== undefined && !(Number.isInteger(opts.limit) && opts.limit > 0)) throw new RangeError("runSyncFull: limit must be a positive integer");
  let budget = opts.limit ?? Infinity;
  let remaining = 0;
  try {
    let likedAdded = 0;
    if (cfg.features.liked && opts.liked === true) {
      const missing = await tracksMissingFrom(db, LIKED_CACHE_ID);
      const batch = missing.slice(0, budget);
      if (batch.length) {
        likedAdded = await addToLiked(sp, batch.map((t) => t.track_id), cfg.likeBatchSize);
        if (likedAdded && writesState(cfg)) await runAll(db, markTracksInPlaylist(db, LIKED_CACHE_ID, batch));
      }
      budget -= batch.length;
      if (writesState(cfg)) remaining += missing.length - batch.length;
    }

    let frequentAdded = 0;
    const frequent = opts.frequent === false ? "off" : await frequentTarget(cfg, db);
    if (frequent !== "off") {
      // Not created yet: every frequent track is missing from it ("" matches no cached playlist).
      const candidates = await frequentTracksMissingFrom(db, frequent ?? "", cfg.frequentMinPlays);
      const batch = candidates.slice(0, budget);
      const playlistId = frequent ?? (batch.length ? await createFrequent(cfg, db, sp) : null);
      if (playlistId) frequentAdded = await addToFrequent(cfg, db, sp, playlistId, batch);
      if (writesState(cfg) && !(playlistId && isPlaceholder(playlistId))) remaining += candidates.length - batch.length;
    }

    console.log(JSON.stringify({ job: "sync-full", writeMode: cfg.writeMode, likedAdded, frequentAdded, remaining }));
    return { likedAdded, frequentAdded, remaining };
  } finally {
    await recordActions(db, "sync-full", cfg.writeMode, null, sp.drainActions());
  }
}

const refs = (rows: TrackRow[]): PlaylistTrackRef[] => rows.map(({ track_id, track_uri }) => ({ track_id, track_uri }));

async function addToLiked(sp: SpotifyClient, trackIds: string[], batchSize: number): Promise<number> {
  let added = 0;
  for (const batch of chunkArray(trackIds, batchSize)) {
    await sp.addToLikedSongs(batch);
    added += batch.length;
  }
  return added;
}

/** Port of _sync_frequent_playlist after candidate selection: skip cached, respect the 10k cap, add and mark each batch. */
async function addToFrequent(
  cfg: Config,
  db: D1Database,
  sp: SpotifyClient,
  playlistId: string,
  rows: PlaylistTrackRef[],
): Promise<number> {
  if (!rows.length) return 0;
  const known = await knownPlaylistTrackIds(db, playlistId, rows.map((r) => r.track_id));
  let candidates = rows.filter((r) => !known.has(r.track_id));
  if (!candidates.length) return 0;

  const placeholder = isPlaceholder(playlistId); // outside live mode, before the playlist exists
  const capacity = placeholder ? null : await remainingCapacity(sp, playlistId);
  if (capacity !== null && capacity <= 0) {
    console.warn("Frequent playlist at capacity; skipping additions.");
    return 0;
  }
  if (capacity !== null && candidates.length > capacity) {
    console.warn(`Frequent playlist near capacity; truncating to ${capacity} items`);
    candidates = candidates.slice(0, capacity);
  }

  let added = 0;
  for (const batch of chunkArray(candidates, cfg.addBatchSize)) {
    await sp.addToPlaylist(playlistId, batch.map((c) => c.track_uri));
    added += batch.length;
    // Recorded as soon as Spotify took it: if a later batch fails, a retried step (the import's
    // backfill) or the next sync skips these instead of adding duplicates.
    if (writesState(cfg) && !placeholder) await runAll(db, markTracksInPlaylist(db, playlistId, batch));
  }
  return added;
}

async function remainingCapacity(sp: SpotifyClient, playlistId: string): Promise<number | null> {
  try {
    const total = (await sp.getPlaylist(playlistId, "tracks.total"))?.tracks?.total;
    if (total == null) return null;
    return Math.max(PLAYLIST_MAX_ITEMS - Number(total), 0);
  } catch (err) {
    if (err instanceof SpotifyError) return null;
    throw err;
  }
}

/** Port of enrich_artists_for_ids: fetch metadata for artists not yet in the artists table. */
async function enrichArtists(db: D1Database, sp: SpotifyClient, artistIds: string[]): Promise<void> {
  if (!artistIds.length) return;
  const known = await existingArtistIds(db, artistIds);
  const missing = artistIds.filter((id) => !known.has(id));

  for (const batch of chunkArray(missing, ARTISTS_BATCH_SIZE)) {
    const resp = await sp.getArtists(batch);
    const rows: ArtistRow[] = [];
    for (const a of resp?.artists ?? []) {
      if (!a?.id || !a?.name) continue;
      rows.push({
        artist_id: a.id,
        name: a.name,
        genres: a.genres?.length ? genresJson(a.genres) : null,
        popularity: a.popularity ?? null,
        followers: a.followers?.total ?? null,
      });
    }
    await runAll(db, upsertArtists(db, rows));
  }
}

/** Port of _maybe_refresh_playlist_cache: refresh the cache at most every cacheRefreshHours. */
async function maybeRefreshPlaylistCache(
  cfg: Config,
  db: D1Database,
  sp: SpotifyClient,
  playlistId: string,
  now: () => number,
): Promise<void> {
  const key = `playlist_cache_refreshed_ms:${playlistId}`;
  const last = await getState(db, key);
  const nowMs = now();
  if (last !== null && /^-?\d+$/.test(last) && nowMs - parseInt(last, 10) < cfg.cacheRefreshHours * 3_600_000) {
    return;
  }
  await backfillPlaylistCache(cfg, db, sp, playlistId);
  if (writesState(cfg)) await setState(db, key, String(nowMs));
}
