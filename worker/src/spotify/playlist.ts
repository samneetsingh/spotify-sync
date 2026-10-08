import type { SpotifyClient } from "./client";
import type { SpotifyTrack } from "./types";

export type ValidTrack = SpotifyTrack & { id: string; uri: string };

export const isValidTrack = (t: SpotifyTrack | null | undefined): t is ValidTrack => !!t?.id && !!t?.uri;

const PAGE_SIZE = 100;
const FIELDS =
  "items(track(id,uri,name,album(name,release_date),artists(id,name),duration_ms,explicit,popularity,external_ids)),next";

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
