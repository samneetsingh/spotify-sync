// Port of src/features/artist_playlists.py (run_artist_playlists, non-dry-run path).
//
// Python issues ~5 queries per artist; this loads all state up front (~6 queries),
// then writes one batch per changed artist. Membership counts for pruning are kept
// in memory so dry_run (no D1 state writes) prunes exactly as live would.

import type { Config } from "../config";
import {
  artistTracksOverThreshold,
  deletePlaylist,
  discoverArtists,
  excludeArtist,
  loadArtistPlaylistState,
  markTracksInPlaylist,
  recordActions,
  recordPlaylistRemovals,
  registerPlaylist,
  removeFromPlaylistTracks,
  runAll,
  insertMissingTracks,
  type PlaylistTrackRef,
} from "../db/queries";
import type { SpotifyClient } from "../spotify/client";
import { SpotifyError } from "../spotify/errors";
import { trackRows } from "../spotify/metadata";
import { fetchPlaylistTracks, type ValidTrack } from "../spotify/playlist";
import { chunkArray } from "../utils/batch";

export interface ArtistPlaylistsResult {
  artistsProcessed: number;
  playlistsCreated: number;
  totalTracksAdded: number;
  pruned: number;
}

/** createPlaylist returns this prefix outside live mode; such playlists have no Spotify state to read. */
const PLACEHOLDER_PREFIX = "would-create:";

export async function runArtistPlaylists(cfg: Config, db: D1Database, sp: SpotifyClient): Promise<ArtistPlaylistsResult> {
  const writeState = cfg.writeMode !== "dry_run";
  const d = cfg.artistDiscovery;
  try {
    const artists = (await discoverArtists(db, d)).map((a) => a.artist).filter(Boolean);
    const [tracksByArtist, state] = await Promise.all([
      artistTracksOverThreshold(db, artists, d.minPlaysPerTrack),
      loadArtistPlaylistState(db),
    ]);

    let artistsProcessed = 0;
    let playlistsCreated = 0;
    let totalTracksAdded = 0;

    for (const artist of artists) {
      if (state.excludedArtists.has(artist)) continue;
      const tracks = tracksByArtist.get(artist) ?? [];
      // Skip before creating, so we never create a playlist only to prune it.
      if (tracks.length < d.minTracksPerPlaylist) continue;

      const stmts: D1PreparedStatement[] = [];
      let playlistId = state.playlistByArtist.get(artist);
      let members: Map<string, string>;

      if (playlistId === undefined) {
        playlistId = (
          await sp.createPlaylist({ name: artist, public: false, description: `Auto-generated playlist for ${artist}` })
        ).id;
        playlistsCreated++;
        members = new Map();
        state.playlistByArtist.set(artist, playlistId);
        state.members.set(playlistId, members);
        if (writeState) stmts.push(registerPlaylist(db, playlistId, artist, artist));
      } else {
        members = state.members.get(playlistId) ?? new Map();
        if (!playlistId.startsWith(PLACEHOLDER_PREFIX)) {
          const remote = await remotePlaylistTracks(sp, playlistId);
          if (remote === null) {
            // Deleted/unfollowed by the user on Spotify: never recreate it.
            if (writeState) await runAll(db, [excludeArtist(db, artist, playlistId), ...deletePlaylist(db, playlistId)]);
            state.excludedArtists.add(artist);
            state.members.delete(playlistId);
            continue;
          }
          stmts.push(...reconcile(db, playlistId, members, remote, state.removals, writeState));
        }
      }

      const removed = state.removals.get(playlistId) ?? new Set();
      const toAdd = tracks.filter((t) => !members.has(t.track_id) && !removed.has(t.track_id));
      for (const batch of chunkArray(toAdd, cfg.addBatchSize)) {
        await sp.addToPlaylist(playlistId, batch.map((t) => t.track_uri));
      }
      for (const t of toAdd) members.set(t.track_id, t.track_uri);
      if (toAdd.length && writeState) stmts.push(...markTracksInPlaylist(db, playlistId, toAdd));

      await runAll(db, stmts);
      totalTracksAdded += toAdd.length;
      artistsProcessed++;
      console.log(JSON.stringify({ job: "artist-playlists", artist, playlistId, considered: tracks.length, added: toAdd.length }));
    }

    // Prune artist playlists below the minimum, in playlist_id order like Python's GROUP BY.
    let pruned = 0;
    for (const [playlistId, members] of [...state.members].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      if (members.size >= d.minTracksPerPlaylist) continue;
      await sp.unfollowPlaylist(playlistId);
      if (writeState) await runAll(db, deletePlaylist(db, playlistId));
      pruned++;
    }

    const result = { artistsProcessed, playlistsCreated, totalTracksAdded, pruned };
    console.log(JSON.stringify({ job: "artist-playlists", writeMode: cfg.writeMode, ...result }));
    return result;
  } finally {
    await recordActions(db, "artist-playlists", cfg.writeMode, null, sp.drainActions());
  }
}

/** Current tracks on Spotify by id, or null if the playlist is gone (404/403). */
async function remotePlaylistTracks(sp: SpotifyClient, playlistId: string): Promise<Map<string, ValidTrack> | null> {
  try {
    return new Map((await fetchPlaylistTracks(sp, playlistId)).map((t) => [t.id, t]));
  } catch (err) {
    if (err instanceof SpotifyError && (err.status === 404 || err.status === 403)) return null;
    throw err;
  }
}

/**
 * Port of _sync_playlist_state: tracks the user removed on Spotify are recorded as
 * removals (never re-added); tracks they added manually join the cache. Mutates the
 * in-memory members/removals and returns the D1 writes.
 *
 * Unlike Python, manually added tracks missing from `tracks` are inserted first:
 * Python fails the whole run on the playlist_tracks foreign key when one was never played.
 */
function reconcile(
  db: D1Database,
  playlistId: string,
  members: Map<string, string>,
  remote: Map<string, ValidTrack>,
  removals: Map<string, Set<string>>,
  writeState: boolean,
): D1PreparedStatement[] {
  const removedByUser: PlaylistTrackRef[] = [...members]
    .filter(([id]) => !remote.has(id))
    .map(([track_id, track_uri]) => ({ track_id, track_uri }));
  const addedTracks = [...remote.values()].filter((t) => !members.has(t.id));
  const addedByUser: PlaylistTrackRef[] = addedTracks.map((t) => ({ track_id: t.id, track_uri: t.uri }));


  if (!removals.has(playlistId)) removals.set(playlistId, new Set());
  for (const r of removedByUser) {
    members.delete(r.track_id);
    removals.get(playlistId)!.add(r.track_id);
  }
  for (const a of addedByUser) members.set(a.track_id, a.track_uri);

  const metadata = insertMissingTracks(db, addedTracks.map((t) => trackRows(t).track));
  if (!writeState) return metadata;
  return [
    ...metadata,
    ...recordPlaylistRemovals(db, playlistId, removedByUser),
    ...removeFromPlaylistTracks(db, playlistId, removedByUser.map((r) => r.track_id)),
    ...markTracksInPlaylist(db, playlistId, addedByUser),
  ];
}
