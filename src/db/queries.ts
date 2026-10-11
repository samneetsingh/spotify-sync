import { chunkArray } from "../utils/batch";

// Bulk writes bind one JSON array per statement and expand it with json_each,
// so N rows cost ceil(N / BULK_CHUNK) queries instead of N (D1 caps queries per
// invocation and bound parameters per query).
const BULK_CHUNK = 500;

export const LIKED_CACHE_ID = "__liked__";

export interface TrackRow {
  track_id: string;
  track_uri: string;
  name: string | null;
  artists: string | null;
  album: string | null;
  duration_ms: number | null;
  explicit: number | null;
  popularity: number | null;
  release_date: string | null;
  isrc: string | null;
}

export interface PlayRow {
  played_at_ms: number;
  track_id: string;
  track_uri: string;
  context_type: string | null;
  context_uri: string | null;
  source: string;
}

export interface TrackArtistRow {
  track_id: string;
  artist_id: string;
  artist_name: string;
  position: number;
}

export interface ArtistRow {
  artist_id: string;
  name: string;
  genres: string | null;
  popularity: number | null;
  followers: number | null;
}

export interface PlaylistTrackRef {
  track_id: string;
  track_uri: string;
}

const col = (name: string) => `json_extract(value, '$.${name}')`;

// Same ON CONFLICT semantics as src/db/sql/upsert_tracks.sql.
const UPSERT_TRACKS = `
INSERT INTO tracks(track_id, track_uri, name, artists, album, duration_ms, explicit, popularity, release_date, isrc)
SELECT ${["track_id", "track_uri", "name", "artists", "album", "duration_ms", "explicit", "popularity", "release_date", "isrc"].map(col).join(", ")}
FROM json_each(?1) WHERE true
ON CONFLICT(track_id) DO UPDATE SET
  track_uri=excluded.track_uri,
  name=COALESCE(excluded.name, tracks.name),
  artists=COALESCE(excluded.artists, tracks.artists),
  album=COALESCE(excluded.album, tracks.album),
  duration_ms=COALESCE(excluded.duration_ms, tracks.duration_ms),
  explicit=COALESCE(excluded.explicit, tracks.explicit),
  popularity=COALESCE(excluded.popularity, tracks.popularity),
  release_date=COALESCE(excluded.release_date, tracks.release_date),
  isrc=COALESCE(excluded.isrc, tracks.isrc)`;

const INSERT_PLAYS = `
INSERT OR IGNORE INTO plays(played_at_ms, track_id, track_uri, context_type, context_uri, source)
SELECT ${["played_at_ms", "track_id", "track_uri", "context_type", "context_uri", "source"].map(col).join(", ")}
FROM json_each(?1)`;

const UPSERT_TRACK_ARTISTS = `
INSERT INTO track_artists(track_id, artist_id, artist_name, position)
SELECT ${["track_id", "artist_id", "artist_name", "position"].map(col).join(", ")}
FROM json_each(?1) WHERE true
ON CONFLICT(track_id, artist_id) DO UPDATE SET
  artist_name=excluded.artist_name,
  position=excluded.position`;

const UPSERT_ARTISTS = `
INSERT INTO artists(artist_id, name, genres, popularity, followers, updated_at)
SELECT ${["artist_id", "name", "genres", "popularity", "followers"].map(col).join(", ")}, datetime('now')
FROM json_each(?1) WHERE true
ON CONFLICT(artist_id) DO UPDATE SET
  name=excluded.name,
  genres=COALESCE(excluded.genres, artists.genres),
  popularity=COALESCE(excluded.popularity, artists.popularity),
  followers=COALESCE(excluded.followers, artists.followers),
  updated_at=datetime('now')`;

const MARK_TRACKS_IN_PLAYLIST = `
INSERT INTO playlist_tracks(playlist_id, track_id, track_uri, first_added_at, last_seen_at)
SELECT ?1, ${col("track_id")}, ${col("track_uri")}, datetime('now'), datetime('now')
FROM json_each(?2) WHERE true
ON CONFLICT(playlist_id, track_id) DO UPDATE SET
  track_uri=excluded.track_uri,
  last_seen_at=datetime('now')`;

function bulk(db: D1Database, sql: string, rows: object[], ...leadingBinds: unknown[]): D1PreparedStatement[] {
  return chunkArray(rows, BULK_CHUNK).map((chunk) =>
    db.prepare(sql).bind(...leadingBinds, JSON.stringify(chunk)),
  );
}

export const upsertTracks = (db: D1Database, rows: TrackRow[]) => bulk(db, UPSERT_TRACKS, rows);
/** Inserts only tracks not yet known; existing rows are left untouched. */
export const insertMissingTracks = (db: D1Database, rows: TrackRow[]) =>
  bulk(db, UPSERT_TRACKS.slice(0, UPSERT_TRACKS.indexOf("ON CONFLICT")) + "ON CONFLICT(track_id) DO NOTHING", rows);
export const insertPlays = (db: D1Database, rows: PlayRow[]) => bulk(db, INSERT_PLAYS, rows);
export const upsertTrackArtists = (db: D1Database, rows: TrackArtistRow[]) =>
  bulk(db, UPSERT_TRACK_ARTISTS, rows);
export const upsertArtists = (db: D1Database, rows: ArtistRow[]) => bulk(db, UPSERT_ARTISTS, rows);
export const markTracksInPlaylist = (db: D1Database, playlistId: string, rows: PlaylistTrackRef[]) =>
  bulk(db, MARK_TRACKS_IN_PLAYLIST, rows, playlistId);

/** Runs statements as one atomic batch; no-op when empty. */
export async function runAll(db: D1Database, statements: D1PreparedStatement[]): Promise<void> {
  if (statements.length) await db.batch(statements);
}

/** Which of `trackIds` are already cached as members of `playlistId`. */
export async function knownPlaylistTrackIds(
  db: D1Database,
  playlistId: string,
  trackIds: string[],
): Promise<Set<string>> {
  if (!trackIds.length) return new Set();
  const { results } = await db
    .prepare(
      "SELECT track_id FROM playlist_tracks WHERE playlist_id = ?1 AND track_id IN (SELECT value FROM json_each(?2))",
    )
    .bind(playlistId, JSON.stringify(trackIds))
    .all<{ track_id: string }>();
  return new Set(results.map((r) => r.track_id));
}

export async function existingArtistIds(db: D1Database, artistIds: string[]): Promise<Set<string>> {
  if (!artistIds.length) return new Set();
  const { results } = await db
    .prepare("SELECT artist_id FROM artists WHERE artist_id IN (SELECT value FROM json_each(?1))")
    .bind(JSON.stringify(artistIds))
    .all<{ artist_id: string }>();
  return new Set(results.map((r) => r.artist_id));
}

/** Tracks among `trackIds` with at least `minPlays` plays, most played first. */
export async function frequentTracksAmong(
  db: D1Database,
  trackIds: string[],
  minPlays: number,
): Promise<PlaylistTrackRef[]> {
  const { results } = await db
    .prepare(
      `SELECT p.track_id, t.track_uri, COUNT(*) AS play_count, MAX(p.played_at_ms) AS last_play
       FROM plays p JOIN tracks t ON p.track_id = t.track_id
       WHERE p.track_id IN (SELECT value FROM json_each(?1))
       GROUP BY p.track_id, t.track_uri
       HAVING play_count >= ?2
       ORDER BY play_count DESC, last_play DESC`,
    )
    .bind(JSON.stringify(trackIds), minPlays)
    .all<PlaylistTrackRef>();
  return results.map(({ track_id, track_uri }) => ({ track_id, track_uri }));
}

/** Full-history version of frequentTracksAmong, excluding tracks already cached in the playlist. */
export async function frequentTracksMissingFrom(
  db: D1Database,
  playlistId: string,
  minPlays: number,
): Promise<PlaylistTrackRef[]> {
  const { results } = await db
    .prepare(
      `SELECT p.track_id, t.track_uri, COUNT(*) AS play_count, MAX(p.played_at_ms) AS last_play
       FROM plays p JOIN tracks t ON p.track_id = t.track_id
       WHERE NOT EXISTS (SELECT 1 FROM playlist_tracks pt WHERE pt.playlist_id = ?1 AND pt.track_id = p.track_id)
       GROUP BY p.track_id, t.track_uri
       HAVING play_count >= ?2
       ORDER BY play_count DESC, last_play DESC`,
    )
    .bind(playlistId, minPlays)
    .all<PlaylistTrackRef>();
  return results.map(({ track_id, track_uri }) => ({ track_id, track_uri }));
}

/** All tracks not cached as members of `playlistId`, in table order. */
export async function tracksMissingFrom(db: D1Database, playlistId: string): Promise<PlaylistTrackRef[]> {
  const { results } = await db
    .prepare(
      `SELECT track_id, track_uri FROM tracks t
       WHERE NOT EXISTS (SELECT 1 FROM playlist_tracks pt WHERE pt.playlist_id = ?1 AND pt.track_id = t.track_id)
       ORDER BY rowid`,
    )
    .bind(playlistId)
    .all<PlaylistTrackRef>();
  return results;
}

export async function createSyncRun(db: D1Database, cursorInMs: number): Promise<number> {
  const res = await db
    .prepare("INSERT INTO sync_runs(cursor_in_ms, status) VALUES(?1, 'running')")
    .bind(cursorInMs)
    .run();
  return res.meta.last_row_id;
}

export async function finishSyncRun(
  db: D1Database,
  runId: number,
  r: { cursorOutMs: number | null; playsFetched: number; tracksAdded: number; status: "success" | "fail"; error?: string },
): Promise<void> {
  await db
    .prepare(
      `UPDATE sync_runs SET finished_at=datetime('now'), cursor_out_ms=?1, plays_fetched=?2,
         tracks_added=?3, status=?4, error=?5 WHERE id=?6`,
    )
    .bind(r.cursorOutMs, r.playsFetched, r.tracksAdded, r.status, r.error ?? null, runId)
    .run();
}

export interface ActionRecord {
  executed: boolean;
  action: string;
  target: string | null;
  items: string[];
}

export async function recordActions(
  db: D1Database,
  job: string,
  writeMode: string,
  syncRunId: number | null,
  actions: ActionRecord[],
): Promise<void> {
  if (!actions.length) return;
  const rows = actions.map((a) => ({
    executed: a.executed ? 1 : 0,
    action: a.action,
    target: a.target,
    item_count: a.items.length,
    items: JSON.stringify(a.items),
  }));
  await runAll(
    db,
    bulk(
      db,
      `INSERT INTO worker_actions(job, write_mode, sync_run_id, executed, action, target, item_count, items)
       SELECT ?1, ?2, ?3, ${["executed", "action", "target", "item_count", "items"].map(col).join(", ")}
       FROM json_each(?4)`,
      rows,
      job,
      writeMode,
      syncRunId,
    ),
  );
}

// --- artist playlists ---

export interface DiscoveredArtist {
  artist: string;
  song_count: number;
  total_streams: number;
  songs_over_threshold: number;
}

/**
 * Rewrite of the Python discover_artists.sql (docs/PORTING.md): joins track_artists instead of
 * splitting tracks.artists on ", ". Counts featured credits, keeps comma names whole.
 */
export async function discoverArtists(
  db: D1Database,
  d: { playsPerSongThreshold: number; songsOverThreshold: number; totalStreamsThreshold: number; altSongCount: number; altStreamsThreshold: number },
): Promise<DiscoveredArtist[]> {
  const { results } = await db
    .prepare(
      `SELECT ta.artist_name AS artist,
              COUNT(DISTINCT ta.track_id) AS song_count,
              SUM(pc.play_count) AS total_streams,
              COUNT(CASE WHEN pc.play_count > ?1 THEN 1 END) AS songs_over_threshold
       FROM track_artists ta
       JOIN (SELECT track_id, COUNT(*) AS play_count FROM plays GROUP BY track_id) pc ON ta.track_id = pc.track_id
       GROUP BY ta.artist_name
       HAVING songs_over_threshold > ?2 OR total_streams > ?3 OR (song_count > ?4 AND total_streams > ?5)
       ORDER BY total_streams DESC`,
    )
    .bind(d.playsPerSongThreshold, d.songsOverThreshold, d.totalStreamsThreshold, d.altSongCount, d.altStreamsThreshold)
    .all<DiscoveredArtist>();
  return results;
}

/**
 * Rewrite of the Python get_artist_tracks_over_threshold.sql (docs/PORTING.md) for many artists at
 * once: exact track_artists match instead of LIKE '%name%'. Per-artist order is
 * play_count DESC, last_play DESC, as before.
 */
export async function artistTracksOverThreshold(
  db: D1Database,
  artistNames: string[],
  minPlays: number,
): Promise<Map<string, PlaylistTrackRef[]>> {
  const out = new Map<string, PlaylistTrackRef[]>();
  if (!artistNames.length) return out;
  const { results } = await db
    .prepare(
      `SELECT ta.artist_name, p.track_id, t.track_uri, COUNT(*) AS play_count, MAX(p.played_at_ms) AS last_play_ms
       FROM plays p
       JOIN tracks t ON p.track_id = t.track_id
       JOIN track_artists ta ON ta.track_id = t.track_id
       WHERE ta.artist_name IN (SELECT value FROM json_each(?1))
       GROUP BY ta.artist_name, p.track_id, t.track_uri
       HAVING COUNT(*) > ?2
       ORDER BY ta.artist_name, play_count DESC, last_play_ms DESC`,
    )
    .bind(JSON.stringify(artistNames), minPlays)
    .all<{ artist_name: string; track_id: string; track_uri: string }>();
  for (const r of results) {
    if (!out.has(r.artist_name)) out.set(r.artist_name, []);
    out.get(r.artist_name)!.push({ track_id: r.track_id, track_uri: r.track_uri });
  }
  return out;
}

export interface ArtistPlaylistState {
  playlistByArtist: Map<string, string>;
  /** playlist_id -> (track_id -> track_uri) cached members, for every artist playlist. */
  members: Map<string, Map<string, string>>;
  removals: Map<string, Set<string>>;
  excludedArtists: Set<string>;
}

export async function loadArtistPlaylistState(db: D1Database): Promise<ArtistPlaylistState> {
  const [playlists, members, removals, exclusions] = await db.batch([
    db.prepare("SELECT playlist_id, artist_name FROM playlists WHERE playlist_type = 'artist' ORDER BY playlist_id"),
    db.prepare(
      `SELECT pt.playlist_id, pt.track_id, pt.track_uri FROM playlist_tracks pt
       JOIN playlists p ON p.playlist_id = pt.playlist_id WHERE p.playlist_type = 'artist'`,
    ),
    db.prepare("SELECT playlist_id, track_id FROM playlist_removals"),
    db.prepare("SELECT artist_name FROM playlist_exclusions"),
  ]);

  const state: ArtistPlaylistState = {
    playlistByArtist: new Map(),
    members: new Map(),
    removals: new Map(),
    excludedArtists: new Set((exclusions!.results as { artist_name: string }[]).map((r) => r.artist_name)),
  };
  for (const r of playlists!.results as { playlist_id: string; artist_name: string | null }[]) {
    if (r.artist_name !== null) state.playlistByArtist.set(r.artist_name, r.playlist_id);
    state.members.set(r.playlist_id, new Map());
  }
  for (const r of members!.results as { playlist_id: string; track_id: string; track_uri: string }[]) {
    state.members.get(r.playlist_id)!.set(r.track_id, r.track_uri);
  }
  for (const r of removals!.results as { playlist_id: string; track_id: string }[]) {
    if (!state.removals.has(r.playlist_id)) state.removals.set(r.playlist_id, new Set());
    state.removals.get(r.playlist_id)!.add(r.track_id);
  }
  return state;
}

export const registerPlaylist = (db: D1Database, playlistId: string, name: string, artistName: string) =>
  db
    .prepare(
      `INSERT INTO playlists(playlist_id, name, artist_name, playlist_type) VALUES(?1, ?2, ?3, 'artist')
       ON CONFLICT(playlist_id) DO UPDATE SET name=excluded.name, artist_name=excluded.artist_name`,
    )
    .bind(playlistId, name, artistName);

export const recordPlaylistRemovals = (db: D1Database, playlistId: string, rows: PlaylistTrackRef[]) =>
  bulk(
    db,
    `INSERT INTO playlist_removals(playlist_id, track_id, track_uri)
     SELECT ?1, ${col("track_id")}, ${col("track_uri")} FROM json_each(?2) WHERE true
     ON CONFLICT(playlist_id, track_id) DO NOTHING`,
    rows,
    playlistId,
  );

export const removeFromPlaylistTracks = (db: D1Database, playlistId: string, trackIds: string[]) =>
  chunkArray(trackIds, BULK_CHUNK).map((chunk) =>
    db
      .prepare("DELETE FROM playlist_tracks WHERE playlist_id = ?1 AND track_id IN (SELECT value FROM json_each(?2))")
      .bind(playlistId, JSON.stringify(chunk)),
  );

export const excludeArtist = (db: D1Database, artistName: string, playlistId: string | null) =>
  db
    .prepare("INSERT INTO playlist_exclusions(artist_name, playlist_id) VALUES(?1, ?2) ON CONFLICT(artist_name) DO NOTHING")
    .bind(artistName, playlistId);

export const deletePlaylist = (db: D1Database, playlistId: string) => [
  db.prepare("DELETE FROM playlist_tracks WHERE playlist_id = ?1").bind(playlistId),
  db.prepare("DELETE FROM playlist_removals WHERE playlist_id = ?1").bind(playlistId),
  db.prepare("DELETE FROM playlists WHERE playlist_id = ?1").bind(playlistId),
];

// --- hindi favorites ---

/**
 * Verbatim src/db/sql/get_hindi_favorites.sql. Note the play count is multiplied by
 * the number of matching-genre credited artists (plays x track_artists join); kept
 * for parity with Python.
 */
export async function hindiFavorites(db: D1Database, minPlays: number): Promise<PlaylistTrackRef[]> {
  const { results } = await db
    .prepare(
      `SELECT p.track_id, p.track_uri, COUNT(*) AS play_count
       FROM plays p
       JOIN track_artists ta ON ta.track_id = p.track_id
       JOIN artists a ON a.artist_id = ta.artist_id
       WHERE EXISTS (
         SELECT 1 FROM json_each(a.genres) je
         WHERE je.value IN ('bollywood', 'hindi', 'filmi', 'desi')
       )
       GROUP BY p.track_id, p.track_uri
       HAVING COUNT(*) >= ?1
       ORDER BY play_count DESC`,
    )
    .bind(minPlays)
    .all<PlaylistTrackRef>();
  return results.map(({ track_id, track_uri }) => ({ track_id, track_uri }));
}

// --- history playlists ---

export interface TrackPlays extends PlaylistTrackRef {
  plays: number;
}

/**
 * Tracks played in each [start, end) ms range, keyed by the range's index, most played
 * first (ties: played earlier that day first).
 */
export async function tracksPlayedIn(db: D1Database, ranges: Array<[number, number]>): Promise<Map<number, TrackPlays[]>> {
  const out = new Map<number, TrackPlays[]>();
  if (!ranges.length) return out;
  const { results } = await db
    .prepare(
      `SELECT r.key AS range_index, p.track_id, t.track_uri, COUNT(*) AS plays, MIN(p.played_at_ms) AS first_ms
       FROM json_each(?1) r
       JOIN plays p ON p.played_at_ms >= json_extract(r.value, '$[0]') AND p.played_at_ms < json_extract(r.value, '$[1]')
       JOIN tracks t ON t.track_id = p.track_id
       GROUP BY r.key, p.track_id, t.track_uri
       ORDER BY r.key, plays DESC, first_ms`,
    )
    .bind(JSON.stringify(ranges))
    .all<TrackPlays & { range_index: number }>();
  for (const { range_index, track_id, track_uri, plays } of results) {
    if (!out.has(range_index)) out.set(range_index, []);
    out.get(range_index)!.push({ track_id, track_uri, plays });
  }
  return out;
}

/** Tracks with at least `minPlays` plays and none since `idleSinceMs`, most played first. */
export async function forgottenTracks(db: D1Database, minPlays: number, idleSinceMs: number): Promise<TrackPlays[]> {
  const { results } = await db
    .prepare(
      `SELECT p.track_id, t.track_uri, COUNT(*) AS plays
       FROM plays p JOIN tracks t ON t.track_id = p.track_id
       GROUP BY p.track_id, t.track_uri
       HAVING COUNT(*) >= ?1 AND MAX(p.played_at_ms) < ?2
       ORDER BY plays DESC, p.track_id`,
    )
    .bind(minPlays, idleSinceMs)
    .all<TrackPlays>();
  return results;
}

/** Tracks whose lowercased title contains one of `phrases`, with at least `minPlays` plays, most played first. */
export async function holidayTracks(db: D1Database, minPlays: number, phrases: readonly string[]): Promise<TrackPlays[]> {
  const { results } = await db
    .prepare(
      `SELECT p.track_id, t.track_uri, COUNT(*) AS plays
       FROM plays p JOIN tracks t ON t.track_id = p.track_id
       WHERE EXISTS (SELECT 1 FROM json_each(?2) k WHERE instr(lower(t.name), k.value) > 0)
       GROUP BY p.track_id, t.track_uri
       HAVING COUNT(*) >= ?1
       ORDER BY plays DESC, p.track_id`,
    )
    .bind(minPlays, JSON.stringify(phrases))
    .all<TrackPlays>();
  return results;
}

// --- monthly recap (plays with from <= played_at_ms < to) ---

export interface RecapTotals {
  plays: number;
  tracks: number;
  artists: number;
  /** Listening time: the export's ms_played, else the track's duration. */
  ms: number;
}

export interface RecapTrack {
  track_id: string;
  name: string | null;
  artists: string | null;
  plays: number;
}

export interface RecapArtist {
  artist_id: string;
  name: string;
  plays: number;
}

export async function recapTotals(db: D1Database, from: number, to: number): Promise<RecapTotals> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS plays, COUNT(DISTINCT p.track_id) AS tracks,
              COALESCE(SUM(COALESCE(p.ms_played, t.duration_ms)), 0) AS ms,
              (SELECT COUNT(DISTINCT ta.artist_id) FROM plays p2 JOIN track_artists ta ON ta.track_id = p2.track_id
               WHERE p2.played_at_ms >= ?1 AND p2.played_at_ms < ?2) AS artists
       FROM plays p JOIN tracks t ON t.track_id = p.track_id
       WHERE p.played_at_ms >= ?1 AND p.played_at_ms < ?2`,
    )
    .bind(from, to)
    .first<RecapTotals>();
  return row ?? { plays: 0, tracks: 0, artists: 0, ms: 0 };
}

export async function recapTopTracks(db: D1Database, from: number, to: number, limit: number): Promise<RecapTrack[]> {
  const { results } = await db
    .prepare(
      `SELECT p.track_id, t.name, t.artists, COUNT(*) AS plays
       FROM plays p JOIN tracks t ON t.track_id = p.track_id
       WHERE p.played_at_ms >= ?1 AND p.played_at_ms < ?2
       GROUP BY p.track_id, t.name, t.artists
       ORDER BY plays DESC, MIN(p.played_at_ms)
       LIMIT ?3`,
    )
    .bind(from, to, limit)
    .all<RecapTrack>();
  return results;
}

export async function recapTopArtists(db: D1Database, from: number, to: number, limit: number): Promise<RecapArtist[]> {
  const { results } = await db
    .prepare(
      `SELECT ta.artist_id, MAX(ta.artist_name) AS name, COUNT(*) AS plays
       FROM plays p JOIN track_artists ta ON ta.track_id = p.track_id
       WHERE p.played_at_ms >= ?1 AND p.played_at_ms < ?2
       GROUP BY ta.artist_id
       ORDER BY plays DESC, MIN(p.played_at_ms)
       LIMIT ?3`,
    )
    .bind(from, to, limit)
    .all<RecapArtist>();
  return results;
}

/** How many tracks were played for the first time ever in the range. */
export async function recapNewTrackCount(db: D1Database, from: number, to: number): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM (
         SELECT track_id FROM plays WHERE played_at_ms < ?2 GROUP BY track_id HAVING MIN(played_at_ms) >= ?1
       )`,
    )
    .bind(from, to)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Artists first heard in the range, most played first. */
export async function recapNewArtists(db: D1Database, from: number, to: number, limit: number): Promise<RecapArtist[]> {
  const { results } = await db
    .prepare(
      `SELECT ta.artist_id, MAX(ta.artist_name) AS name, COUNT(*) AS plays
       FROM plays p JOIN track_artists ta ON ta.track_id = p.track_id
       WHERE p.played_at_ms < ?2
       GROUP BY ta.artist_id
       HAVING MIN(p.played_at_ms) >= ?1
       ORDER BY plays DESC, MIN(p.played_at_ms)
       LIMIT ?3`,
    )
    .bind(from, to, limit)
    .all<RecapArtist>();
  return results;
}

/**
 * Artists played at least `minPlays` times in the range after a break of `idleMs` or more,
 * having had at least `minEarlierPlays` plays before it. `last_before_ms` is when the break began.
 */
export async function recapReturningArtists(
  db: D1Database,
  from: number,
  to: number,
  opts: { idleMs: number; minEarlierPlays: number; minPlays: number; limit: number },
): Promise<Array<RecapArtist & { last_before_ms: number }>> {
  const { results } = await db
    .prepare(
      `SELECT ta.artist_id, MAX(ta.artist_name) AS name,
              SUM(p.played_at_ms >= ?1) AS plays,
              MAX(CASE WHEN p.played_at_ms < ?1 THEN p.played_at_ms END) AS last_before_ms
       FROM plays p JOIN track_artists ta ON ta.track_id = p.track_id
       WHERE p.played_at_ms < ?2
       GROUP BY ta.artist_id
       HAVING plays >= ?5 AND SUM(p.played_at_ms < ?1) >= ?4 AND last_before_ms < ?1 - ?3
       ORDER BY plays DESC
       LIMIT ?6`,
    )
    .bind(from, to, opts.idleMs, opts.minEarlierPlays, opts.minPlays, opts.limit)
    .all<RecapArtist & { last_before_ms: number }>();
  return results;
}

/** Every play time in the range (one query; the digest buckets them by local day and hour in JS). */
export async function recapPlayTimes(db: D1Database, from: number, to: number): Promise<number[]> {
  const { results } = await db
    .prepare("SELECT played_at_ms AS t FROM plays WHERE played_at_ms >= ?1 AND played_at_ms < ?2 ORDER BY played_at_ms")
    .bind(from, to)
    .all<{ t: number }>();
  return results.map((r) => r.t);
}

/** Plays in each [start, end) ms range, in order (e.g. one range per month). */
export async function recapRangeCounts(db: D1Database, ranges: Array<[number, number]>): Promise<number[]> {
  if (!ranges.length) return [];
  const { results } = await db
    .prepare(
      `SELECT r.key AS i, (SELECT COUNT(*) FROM plays p
                           WHERE p.played_at_ms >= json_extract(r.value, '$[0]') AND p.played_at_ms < json_extract(r.value, '$[1]')) AS plays
       FROM json_each(?1) r ORDER BY r.key`,
    )
    .bind(JSON.stringify(ranges))
    .all<{ i: number; plays: number }>();
  return results.map((r) => r.plays);
}

/** Most played genres in the range, counting each play once under its primary artist's genres. */
export async function recapGenres(db: D1Database, from: number, to: number, limit: number): Promise<Array<{ genre: string; plays: number }>> {
  const { results } = await db
    .prepare(
      `SELECT g.value AS genre, COUNT(*) AS plays
       FROM plays p
       JOIN track_artists ta ON ta.track_id = p.track_id AND ta.position = 0
       JOIN artists a ON a.artist_id = ta.artist_id,
            json_each(CASE WHEN json_valid(a.genres) THEN a.genres ELSE '[]' END) g
       WHERE p.played_at_ms >= ?1 AND p.played_at_ms < ?2
       GROUP BY g.value ORDER BY plays DESC, g.value LIMIT ?3`,
    )
    .bind(from, to, limit)
    .all<{ genre: string; plays: number }>();
  return results;
}

/** Plays in the range of tracks that had been played before it. */
export async function recapRepeatPlays(db: D1Database, from: number, to: number): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM plays p
       WHERE p.played_at_ms >= ?1 AND p.played_at_ms < ?2
         AND EXISTS (SELECT 1 FROM plays q WHERE q.track_id = p.track_id AND q.played_at_ms < ?1)`,
    )
    .bind(from, to)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

// --- digest highlights (src/editor/highlights.ts; plays with from <= played_at_ms < to) ---

export interface PeriodPlay {
  at: number;
  id: string;
  /** Listening time: the export's ms_played, else the track's duration, else 0. */
  ms: number;
}

/** Every play in the range with its track and listening time, oldest first (highlights bucket them in JS). */
export async function periodPlayRows(db: D1Database, from: number, to: number): Promise<PeriodPlay[]> {
  const { results } = await db
    .prepare(
      `SELECT p.played_at_ms AS at, p.track_id AS id, COALESCE(p.ms_played, t.duration_ms, 0) AS ms
       FROM plays p LEFT JOIN tracks t ON t.track_id = p.track_id
       WHERE p.played_at_ms >= ?1 AND p.played_at_ms < ?2 ORDER BY p.played_at_ms`,
    )
    .bind(from, to)
    .all<PeriodPlay>();
  return results;
}

/**
 * Tracks played at least `minPlays` times in the range after a break of `idleMs` or more, having
 * had at least `minEarlierPlays` plays before it; most played first, at most 3.
 */
export async function digestComebackTracks(
  db: D1Database,
  from: number,
  to: number,
  opts: { idleMs: number; minEarlierPlays: number; minPlays: number },
): Promise<Array<RecapTrack & { earlier: number; last_before_ms: number }>> {
  const { results } = await db
    .prepare(
      `SELECT p.track_id, t.name, t.artists,
              SUM(p.played_at_ms >= ?1) AS plays, SUM(p.played_at_ms < ?1) AS earlier,
              MAX(CASE WHEN p.played_at_ms < ?1 THEN p.played_at_ms END) AS last_before_ms
       FROM plays p JOIN tracks t ON t.track_id = p.track_id
       WHERE p.played_at_ms < ?2
         AND p.track_id IN (SELECT DISTINCT track_id FROM plays WHERE played_at_ms >= ?1 AND played_at_ms < ?2)
       GROUP BY p.track_id, t.name, t.artists
       HAVING plays >= ?5 AND earlier >= ?4 AND last_before_ms < ?1 - ?3
       ORDER BY plays DESC, p.track_id
       LIMIT 3`,
    )
    .bind(from, to, opts.idleMs, opts.minEarlierPlays, opts.minPlays)
    .all<RecapTrack & { earlier: number; last_before_ms: number }>();
  return results;
}

/** The most played track first heard in the range (ties: found earlier), or null. */
export async function digestNewObsession(db: D1Database, from: number, to: number): Promise<(RecapTrack & { first_ms: number }) | null> {
  return db
    .prepare(
      `SELECT p.track_id, t.name, t.artists, COUNT(*) AS plays, MIN(p.played_at_ms) AS first_ms
       FROM plays p JOIN tracks t ON t.track_id = p.track_id
       WHERE p.played_at_ms < ?2
         AND p.track_id IN (SELECT DISTINCT track_id FROM plays WHERE played_at_ms >= ?1 AND played_at_ms < ?2)
       GROUP BY p.track_id, t.name, t.artists
       HAVING MIN(p.played_at_ms) >= ?1
       ORDER BY plays DESC, first_ms
       LIMIT 1`,
    )
    .bind(from, to)
    .first<RecapTrack & { first_ms: number }>();
}

export interface GenreShares {
  /** Plays per genre (under the primary artist's genres) in [from, to) and in [prevFrom, from). */
  genres: Array<{ genre: string; now: number; before: number }>;
  /** Plays whose primary artist has any genre: the denominator of a share. */
  tagged: { now: number; before: number };
}

/** Genre play counts in the range and in the one before it (`prevFrom` to `from`). Bad or empty genre JSON counts as untagged. */
export async function digestGenreShares(db: D1Database, prevFrom: number, from: number, to: number): Promise<GenreShares> {
  const genres = "CASE WHEN json_valid(a.genres) THEN a.genres ELSE '[]' END";
  const { results } = await db
    .prepare(
      `SELECT g.value AS genre, SUM(p.played_at_ms >= ?2) AS now, SUM(p.played_at_ms < ?2) AS before
       FROM plays p
       JOIN track_artists ta ON ta.track_id = p.track_id AND ta.position = 0
       JOIN artists a ON a.artist_id = ta.artist_id
       JOIN json_each(${genres}) g
       WHERE p.played_at_ms >= ?1 AND p.played_at_ms < ?3
       GROUP BY g.value
       UNION ALL
       SELECT '__tagged__', SUM(p.played_at_ms >= ?2), SUM(p.played_at_ms < ?2)
       FROM plays p
       JOIN track_artists ta ON ta.track_id = p.track_id AND ta.position = 0
       JOIN artists a ON a.artist_id = ta.artist_id
       WHERE p.played_at_ms >= ?1 AND p.played_at_ms < ?3 AND json_array_length(${genres}) > 0`,
    )
    .bind(prevFrom, from, to)
    .all<{ genre: string; now: number | null; before: number | null }>();
  const tagged = results.find((r) => r.genre === "__tagged__");
  return {
    genres: results.filter((r) => r !== tagged).map((r) => ({ genre: r.genre, now: r.now ?? 0, before: r.before ?? 0 })),
    tagged: { now: tagged?.now ?? 0, before: tagged?.before ?? 0 },
  };
}

/** Name and artists of each known track among `trackIds` (one bound JSON array). */
export async function trackNames(db: D1Database, trackIds: string[]): Promise<Map<string, Pick<RecapTrack, "name" | "artists">>> {
  if (!trackIds.length) return new Map();
  const { results } = await db
    .prepare("SELECT track_id, name, artists FROM tracks WHERE track_id IN (SELECT value FROM json_each(?1))")
    .bind(JSON.stringify(trackIds))
    .all<{ track_id: string; name: string | null; artists: string | null }>();
  return new Map(results.map((r) => [r.track_id, { name: r.name, artists: r.artists }]));
}
