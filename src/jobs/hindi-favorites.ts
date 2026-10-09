// Port of src/features/hindi_favorites.py (build_hindi_favorites).

import type { Config } from "../config";
import { hindiFavorites, knownPlaylistTrackIds, markTracksInPlaylist, recordActions, runAll } from "../db/queries";
import type { SpotifyClient } from "../spotify/client";
import { chunkArray } from "../utils/batch";
import { backfillPlaylistCache } from "./playlist-cache";

export interface HindiFavoritesResult {
  tracksAdded: number;
  tracksConsidered: number;
}

export async function runHindiFavorites(cfg: Config, db: D1Database, sp: SpotifyClient): Promise<HindiFavoritesResult | null> {
  const playlistId = cfg.hindiFavoritesPlaylistId;
  if (!playlistId) {
    console.log("hindi-favorites: SPOTIFY_HINDI_FAVORITES_PLAYLIST_ID not set; skipping");
    return null;
  }
  try {
    // Refresh from Spotify first so manual edits are respected (no 24h gate, as in Python).
    await backfillPlaylistCache(cfg, db, sp, playlistId);

    const rows = await hindiFavorites(db, cfg.hindiFavoritesMinPlays);
    const known = await knownPlaylistTrackIds(db, playlistId, rows.map((r) => r.track_id));
    const toAdd = rows.filter((r) => !known.has(r.track_id));

    let tracksAdded = 0;
    for (const batch of chunkArray(toAdd, cfg.addBatchSize)) {
      await sp.addToPlaylist(playlistId, batch.map((t) => t.track_uri));
      tracksAdded += batch.length;
    }
    if (toAdd.length && cfg.writeMode !== "dry_run") await runAll(db, markTracksInPlaylist(db, playlistId, toAdd));

    const result = { tracksAdded, tracksConsidered: rows.length };
    console.log(JSON.stringify({ job: "hindi-favorites", writeMode: cfg.writeMode, ...result }));
    return result;
  } finally {
    await recordActions(db, "hindi-favorites", cfg.writeMode, null, sp.drainActions());
  }
}
