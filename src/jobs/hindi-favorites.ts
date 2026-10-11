// Port of src/features/hindi_favorites.py (build_hindi_favorites).
//
// Hindi Favorites is an owned playlist (owned-playlists.ts, `state` playlist:hindi), created on the
// first run with the setting on; deleting it in Spotify switches it off. This daily run also checks
// that Frequent Plays is still in the library (the 10-minute sync doesn't), with the same rule.

import { DISABLED, type Config, type Disabled } from "../config";
import { hindiFavorites, knownPlaylistTrackIds, markTracksInPlaylist, recordActions, runAll } from "../db/queries";
import { getState, setState } from "../db/state";
import type { SpotifyClient } from "../spotify/client";
import { chunkArray } from "../utils/batch";
import { ensurePlaylist, followChecker, PLACEHOLDER_PREFIX, playlistStateKey, type OwnedPlaylist } from "./owned-playlists";
import { backfillPlaylistCache } from "./playlist-cache";
import { FREQUENT_PLAYLIST } from "./sync";

export interface HindiFavoritesResult {
  tracksAdded: number;
  tracksConsidered: number;
}

export const HINDI_PLAYLIST: OwnedPlaylist = {
  key: "hindi",
  name: "Hindi Favorites",
  description: "Your most-played Hindi and Desi songs, added automatically by spotify-sync. Songs you remove stay removed.",
};

export async function runHindiFavorites(cfg: Config, db: D1Database, sp: SpotifyClient): Promise<HindiFavoritesResult | Disabled> {
  const isFollowed = followChecker(sp); // one library fetch for both checks
  try {
    await checkFrequentFollowed(cfg, db, isFollowed);
    if (!cfg.features.hindiFavorites) {
      console.log(JSON.stringify({ job: "hindi-favorites", skipped: "switched off in settings" }));
      return DISABLED;
    }
    const playlistId = cfg.hindiFavoritesPlaylistId ?? (await ensurePlaylist(cfg, db, sp, HINDI_PLAYLIST, isFollowed));
    if (!playlistId) return DISABLED; // deleted in Spotify: switched off for good
    const placeholder = playlistId.startsWith(PLACEHOLDER_PREFIX);

    // Refresh from Spotify first so manual edits are respected (no 24h gate, as in Python).
    // A placeholder (outside live mode, before the playlist exists) has nothing to read.
    if (!placeholder) await backfillPlaylistCache(cfg, db, sp, playlistId);

    const rows = await hindiFavorites(db, cfg.hindiFavoritesMinPlays);
    const known = await knownPlaylistTrackIds(db, playlistId, rows.map((r) => r.track_id));
    const toAdd = rows.filter((r) => !known.has(r.track_id));

    let tracksAdded = 0;
    for (const batch of chunkArray(toAdd, cfg.addBatchSize)) {
      await sp.addToPlaylist(playlistId, batch.map((t) => t.track_uri));
      tracksAdded += batch.length;
    }
    if (toAdd.length && cfg.writeMode !== "dry_run" && !placeholder) await runAll(db, markTracksInPlaylist(db, playlistId, toAdd));

    const result = { tracksAdded, tracksConsidered: rows.length };
    console.log(JSON.stringify({ job: "hindi-favorites", writeMode: cfg.writeMode, ...result }));
    return result;
  } finally {
    await recordActions(db, "hindi-favorites", cfg.writeMode, null, sp.drainActions());
  }
}

/**
 * Switches the owned Frequent Plays off for good once it's gone from the library (deleted in
 * Spotify), like ensurePlaylist does for the other owned playlists. Best effort: a failed library
 * read is logged and retried tomorrow. Skipped in dry_run, which can't record it.
 */
export async function checkFrequentFollowed(cfg: Config, db: D1Database, isFollowed: (playlistId: string) => Promise<boolean>): Promise<void> {
  if (!cfg.features.frequent || cfg.frequentPlaylistId || cfg.writeMode === "dry_run") return;
  const key = playlistStateKey(FREQUENT_PLAYLIST.key);
  const id = await getState(db, key);
  if (!id || id === "off") return;
  try {
    if (await isFollowed(id)) return;
  } catch (err) {
    console.warn(JSON.stringify({ job: "hindi-favorites", frequentCheck: "failed", error: err instanceof Error ? err.message : String(err) }));
    return;
  }
  await setState(db, key, "off");
  console.log(JSON.stringify({ playlist: FREQUENT_PLAYLIST.key, switchedOff: id }));
}
