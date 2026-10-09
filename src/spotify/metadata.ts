import type { TrackArtistRow, TrackRow } from "../db/queries";
import type { SpotifyTrack } from "./types";

/** Port of extract_track_metadata + the TrackRow/TrackArtistRow building in sync_recent.py. */
export function trackRows(track: SpotifyTrack & { id: string; uri: string }): {
  track: TrackRow;
  artists: TrackArtistRow[];
} {
  const artists = track.artists ?? [];
  const names = artists.map((a) => a?.name).filter((n): n is string => !!n);
  const explicit = track.explicit === true ? 1 : track.explicit === false ? 0 : null;
  const infos = artists.filter((a) => a?.id && a?.name);

  return {
    track: {
      track_id: track.id,
      track_uri: track.uri,
      name: track.name ?? null,
      artists: names.length ? names.join(", ") : null,
      album: track.album?.name ?? null,
      duration_ms: track.duration_ms ?? null,
      explicit,
      popularity: track.popularity ?? null,
      release_date: track.album?.release_date ?? null,
      isrc: track.external_ids?.isrc ?? null,
    },
    artists: infos.map((a, i) => ({
      track_id: track.id,
      artist_id: a.id!,
      artist_name: a.name!,
      position: i,
    })),
  };
}

/** Genres as stored in `artists.genres`: the existing rows' format (", " separators, \uXXXX for non-ASCII). */
export function genresJson(values: string[]): string {
  const esc = (s: string) =>
    JSON.stringify(s).replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return `[${values.map(esc).join(", ")}]`;
}
