// After an import: Spotify metadata for tracks without artist credits and artists without a row,
// like the CLI script's enrichment. Cursor steps (ids ascending) so each step is bounded and the
// loop ends even when Spotify returns null for removed tracks.

import { runAll, upsertArtists, upsertTrackArtists, upsertTracks, type ArtistRow, type TrackArtistRow, type TrackRow } from "../db/queries";
import type { SpotifyClient } from "../spotify/client";
import { genresJson, trackRows } from "../spotify/metadata";
import type { SpotifyTrack } from "../spotify/types";
import { chunkArray } from "../utils/batch";

/** Ids per step: 20 Spotify calls of 50, then one D1 batch. */
export const ENRICH_PAGE = 1000;
const PER_CALL = 50;

export interface EnrichStep {
  /** The last id looked at; the next step starts after it. */
  cursor: string;
  done: boolean;
  /** Rows written this step. */
  written: number;
}

/** Tracks after `cursor` that have no track_artists rows: fetch them, upsert tracks and credits. */
export async function enrichTracks(db: D1Database, sp: SpotifyClient, cursor: string, page = ENRICH_PAGE): Promise<EnrichStep> {
  const { results } = await db
    .prepare(
      `SELECT t.track_id FROM tracks t WHERE t.track_id > ?1
         AND NOT EXISTS (SELECT 1 FROM track_artists ta WHERE ta.track_id = t.track_id)
       ORDER BY t.track_id LIMIT ?2`,
    )
    .bind(cursor, page)
    .all<{ track_id: string }>();
  const ids = results.map((r) => r.track_id);
  if (!ids.length) return { cursor, done: true, written: 0 };

  const tracks: TrackRow[] = [];
  const credits: TrackArtistRow[] = [];
  for (const batch of chunkArray(ids, PER_CALL)) {
    for (const t of (await sp.getTracks(batch)).tracks ?? []) {
      if (!t?.id || !t.uri) continue;
      const rows = trackRows(t as SpotifyTrack & { id: string; uri: string });
      tracks.push(rows.track);
      credits.push(...rows.artists);
    }
  }
  await runAll(db, [...upsertTracks(db, tracks), ...upsertTrackArtists(db, credits)]);
  return { cursor: ids[ids.length - 1]!, done: ids.length < page, written: tracks.length };
}

/** Credited artists after `cursor` with no `artists` row: fetch and store them (genres for Hindi Favorites). */
export async function enrichArtists(db: D1Database, sp: SpotifyClient, cursor: string, page = ENRICH_PAGE): Promise<EnrichStep> {
  const { results } = await db
    .prepare(
      `SELECT DISTINCT ta.artist_id FROM track_artists ta WHERE ta.artist_id > ?1
         AND NOT EXISTS (SELECT 1 FROM artists a WHERE a.artist_id = ta.artist_id)
       ORDER BY ta.artist_id LIMIT ?2`,
    )
    .bind(cursor, page)
    .all<{ artist_id: string }>();
  const ids = results.map((r) => r.artist_id);
  if (!ids.length) return { cursor, done: true, written: 0 };

  const rows: ArtistRow[] = [];
  for (const batch of chunkArray(ids, PER_CALL)) {
    for (const a of (await sp.getArtists(batch)).artists ?? []) {
      if (!a?.id || !a.name) continue;
      rows.push({ artist_id: a.id, name: a.name, genres: a.genres?.length ? genresJson(a.genres) : null, popularity: a.popularity ?? null, followers: a.followers?.total ?? null });
    }
  }
  await runAll(db, upsertArtists(db, rows));
  return { cursor: ids[ids.length - 1]!, done: ids.length < page, written: rows.length };
}
