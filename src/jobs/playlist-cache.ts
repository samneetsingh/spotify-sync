import type { Config } from "../config";
import { markTracksInPlaylist, runAll, upsertTrackArtists, upsertTracks, type PlaylistTrackRef, type TrackArtistRow, type TrackRow } from "../db/queries";
import type { SpotifyClient } from "../spotify/client";
import { trackRows } from "../spotify/metadata";
import { fetchPlaylistTracks } from "../spotify/playlist";

/**
 * Port of backfill_playlist_cache (playlist path): mirror a playlist's current
 * tracks into tracks/track_artists (metadata, always) and playlist_tracks (state,
 * skipped in dry_run). Returns the playlist's track ids.
 */
export async function backfillPlaylistCache(
  cfg: Config,
  db: D1Database,
  sp: SpotifyClient,
  playlistId: string,
): Promise<Set<string>> {
  const tracks: TrackRow[] = [];
  const trackArtists: TrackArtistRow[] = [];
  const seen = new Set<string>();
  for (const track of await fetchPlaylistTracks(sp, playlistId)) {
    if (seen.has(track.id)) continue;
    seen.add(track.id);
    const rows = trackRows(track);
    tracks.push(rows.track);
    trackArtists.push(...rows.artists);
  }

  const refs: PlaylistTrackRef[] = tracks.map(({ track_id, track_uri }) => ({ track_id, track_uri }));
  await runAll(db, [
    ...upsertTracks(db, tracks),
    ...(cfg.writeMode !== "dry_run" ? markTracksInPlaylist(db, playlistId, refs) : []),
    ...upsertTrackArtists(db, trackArtists),
  ]);
  return seen;
}
