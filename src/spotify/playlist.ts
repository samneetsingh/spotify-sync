import type { SpotifyClient } from "./client";
import type { SpotifyTrack } from "./types";

export type ValidTrack = SpotifyTrack & { id: string; uri: string };

export const isValidTrack = (t: SpotifyTrack | null | undefined): t is ValidTrack => !!t?.id && !!t?.uri;

const PAGE_SIZE = 100;
const FIELDS =
  "items(track(id,uri,name,album(name,release_date),artists(id,name),duration_ms,explicit,popularity,external_ids)),next";

/**
 * Ids of every playlist in the user's library. Spotify has no real delete: deleting a
 * playlist in the app unfollows it, which drops it from this list (writes to it still work).
 */
export async function followedPlaylistIds(sp: SpotifyClient): Promise<Set<string>> {
  const ids = new Set<string>();
  for (let offset = 0; ; offset += 50) {
    const resp = await sp.getMyPlaylists({ limit: 50, offset });
    for (const p of resp?.items ?? []) if (p?.id) ids.add(p.id);
    if (!resp?.next) return ids;
  }
}

/** Port of _fetch_playlist_items (playlist path): every track with an id and uri, in playlist order. */
export async function fetchPlaylistTracks(sp: SpotifyClient, playlistId: string): Promise<ValidTrack[]> {
  const out: ValidTrack[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const resp = await sp.getPlaylistItems(playlistId, { limit: PAGE_SIZE, offset, fields: FIELDS });
    for (const item of resp?.items ?? []) {
      if (isValidTrack(item?.track)) out.push(item.track);
    }
    if (!resp?.next) return out;
  }
}
