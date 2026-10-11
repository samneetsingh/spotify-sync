// Playlists this Worker creates and owns (On This Day, Forgotten Favorites, Holiday
// Favorites). Each id lives in `state` (`playlist:<key>`). The value "off" stops a
// playlist for good; deleting it in Spotify (it leaves the user's library) switches it
// off the same way, so it is never recreated.

import type { Config } from "../config";
import { getState, setState } from "../db/state";
import type { SpotifyClient } from "../spotify/client";
import { followedPlaylistIds } from "../spotify/playlist";

/** createPlaylist returns this prefix outside live mode; such ids are never saved. */
export const PLACEHOLDER_PREFIX = "would-create:";

export interface OwnedPlaylist {
  key: string;
  name: string;
  description: string;
}

export const playlistStateKey = (key: string) => `playlist:${key}`;

/** Whether a playlist is still in the user's library; the library is fetched at most once. */
export function followChecker(sp: SpotifyClient): (playlistId: string) => Promise<boolean> {
  let ids: Promise<Set<string>> | undefined;
  return async (playlistId) => (await (ids ??= followedPlaylistIds(sp))).has(playlistId);
}

/**
 * The playlist's id, created on first use, or null once it is switched off. Ids are saved
 * only outside dry_run and never as placeholders, so a dry run "creates" it every time.
 */
export async function ensurePlaylist(
  cfg: Config,
  db: D1Database,
  sp: SpotifyClient,
  playlist: OwnedPlaylist,
  isFollowed: (playlistId: string) => Promise<boolean>,
): Promise<string | null> {
  const writeState = cfg.writeMode !== "dry_run";
  const stateKey = playlistStateKey(playlist.key);
  const id = await getState(db, stateKey);
  if (id === "off") return null;
  if (id) {
    if (await isFollowed(id)) return id;
    // Deleted in Spotify (unfollowed): stop for good rather than write to a hidden playlist.
    if (writeState) await setState(db, stateKey, "off");
    console.log(JSON.stringify({ playlist: playlist.key, switchedOff: id }));
    return null;
  }
  const created = (await sp.createPlaylist({ name: playlist.name, public: false, description: playlist.description })).id;
  if (writeState && !created.startsWith(PLACEHOLDER_PREFIX)) await setState(db, stateKey, created);
  return created;
}
