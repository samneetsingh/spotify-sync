// Port of src/ingestion/sync_recent.py (sync_recent + sync_all_tracks).
//
// Write-mode gating (PLAN.md 3.2): the SpotifyClient blocks Spotify writes outside
// live mode; this module skips "state" writes (playlist_tracks, state) in dry_run.
// Metadata (tracks, plays, track_artists, artists, sync_runs) is always written.

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
const cursorKey = (playlistId: string) => `cursor_after_ms:${playlistId}`;

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
  const stored = await getState(db, cursorKey(cfg.allPlaylistId));
  const cursorIn = stored !== null ? parseInt(stored, 10) : now() - cfg.bootstrapHours * 3_600_000;
  const runId = await createSyncRun(db, cursorIn);

  let playsFetched = 0;
  let likedAdded = 0;
  let frequentAdded = 0;
  let cursorOut: number | null = null;
  let tracksAddedTotal = 0;

  try {
    if (cfg.frequentPlaylistId) {
      await maybeRefreshPlaylistCache(cfg, db, sp, cfg.frequentPlaylistId, now);
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

    const likedKnown = await knownPlaylistTrackIds(db, LIKED_CACHE_ID, trackList.map((t) => t.track_id));
    const likedMissing = trackList.filter((t) => !likedKnown.has(t.track_id));
    if (likedMissing.length) {
      likedAdded = await addToLiked(sp, likedMissing.map((t) => t.track_id), cfg.likeBatchSize);
      if (writesState(cfg)) await runAll(db, markTracksInPlaylist(db, LIKED_CACHE_ID, refs(likedMissing)));
      tracksAddedTotal += likedAdded;
    }

    if (cfg.frequentPlaylistId) {
      const candidates = trackList.length
        ? await frequentTracksAmong(db, trackList.map((t) => t.track_id), cfg.frequentMinPlays)
        : [];
      frequentAdded = await addToFrequent(cfg, db, sp, cfg.frequentPlaylistId, candidates);
      tracksAddedTotal += frequentAdded;
    }

    if (newestMs > 0) {
      cursorOut = newestMs + 1;
      if (writesState(cfg)) await setState(db, cursorKey(cfg.allPlaylistId), String(cursorOut));
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

/** Port of sync_all_tracks (`spotify sync --full`): backfill Liked Songs and the frequent playlist from the whole DB. */
export async function runSyncFull(cfg: Config, db: D1Database, sp: SpotifyClient): Promise<{ likedAdded: number; frequentAdded: number }> {
  try {
    const likedMissing = await tracksMissingFrom(db, LIKED_CACHE_ID);
    let likedAdded = 0;
    if (likedMissing.length) {
      likedAdded = await addToLiked(sp, likedMissing.map((t) => t.track_id), cfg.likeBatchSize);
      if (likedAdded && writesState(cfg)) await runAll(db, markTracksInPlaylist(db, LIKED_CACHE_ID, likedMissing));
    }

    let frequentAdded = 0;
    if (cfg.frequentPlaylistId) {
      const candidates = await frequentTracksMissingFrom(db, cfg.frequentPlaylistId, cfg.frequentMinPlays);
      frequentAdded = await addToFrequent(cfg, db, sp, cfg.frequentPlaylistId, candidates);
    }

    console.log(JSON.stringify({ job: "sync-full", writeMode: cfg.writeMode, likedAdded, frequentAdded }));
    return { likedAdded, frequentAdded };
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

/** Port of _sync_frequent_playlist after candidate selection: skip cached, respect the 10k cap, add, mark. */
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

  const capacity = await remainingCapacity(sp, playlistId);
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
  }
  if (added && writesState(cfg)) await runAll(db, markTracksInPlaylist(db, playlistId, candidates));
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
