/**
 * Reconcile D1 plays with a Spotify privacy export (Extended Streaming History JSON), then
 * enrich new tracks with artist credits and artist metadata (genres for hindi-favorites,
 * credits for artist playlists).
 *
 * Usage: npm run import-history -- <export-dir> [--db spotify-sync] [--dry-run]
 *
 * The export is the source of truth for plays inside its span (first record to last record
 * + 30 s): afterwards D1's plays there equal the export's streams of at least 30 s. Missing
 * plays are inserted; anything else in the span is deleted (shorter streams, and API plays,
 * whose timestamps never match the export's exactly). Plays after the span are untouched.
 * Each play also keeps the export's per-play fields (EXPORT_PLAY_FIELDS: ms_played,
 * reason_end, shuffle, ...); existing plays that lack them are updated in place.
 * Pass the whole export folder (a single file would only cover its own span) and always
 * --dry-run first: it reads D1 and prints the per-year diff without writing anything.
 * Safe to re-run: the diff is recomputed, so an interrupted run converges. Tracks are only
 * ever inserted (INSERT OR IGNORE), so history data never overwrites richer API metadata.
 *
 * Afterwards, to add newly imported tracks to Liked Songs and the frequent playlist,
 * run the Worker's /sync-full (see README).
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXPORT_PLAY_FIELDS } from "../src/db/schema";
import { genresJson, trackRows } from "../src/spotify/metadata";
import type { SpotifyArtistFull, SpotifyTrack } from "../src/spotify/types";
import { DEFAULT_DB, accessTokenFromD1, d1ExecFile, d1Rows, flag, lit, spotifyGet } from "./lib";

const ROWS_PER_STATEMENT = 200; // keeps each statement well under D1's 100 KB limit
const ROWS_PER_FILE = 20_000;
const MIN_MS_PLAYED = 30_000; // Spotify counts a stream at 30 s; recently-played (the live sync) only reports those
const SPAN_TAIL_MS = 30_000; // covers the API's twin of the export's last play, which lands ~2 s after its ts

type Rec = Record<string, unknown>;
type ExportFields = Record<(typeof EXPORT_PLAY_FIELDS)[number][0], string | number | null> & { ms_played: number | null };
interface Play { played_at_ms: number; track_id: string; track_uri: string; fields: ExportFields }
interface Track { track_id: string; track_uri: string; name: string | null; artists: string | null; album: string | null; explicit: number | null }

/** Port of _parse_record: needs a spotify:track URI and a timestamp; everything else is optional. */
export function parseRecord(r: Rec): { play: Play; track: Track } | null {
  const uri = [r.spotify_track_uri, r.track_uri, r.trackUri].find((u) => typeof u === "string" && u) as string | undefined;
  if (!uri?.startsWith("spotify:track:")) return null;
  const trackId = uri.split(":").pop()!;
  const ts = (r.ts ?? r.endTime) as string | undefined;
  if (!ts || typeof ts !== "string") return null;
  const ms = parseTimestamp(ts);
  if (ms === null) return null;
  const flagKey = "explicit" in r ? "explicit" : "is_explicit" in r ? "is_explicit" : null;
  const explicit = flagKey === null ? null : r[flagKey] === true ? 1 : r[flagKey] === false ? 0 : null;
  const str = (...vals: unknown[]) => (vals.find((v) => typeof v === "string" && v) as string | undefined) ?? null;
  const bool = (v: unknown) => (typeof v === "boolean" ? (v ? 1 : 0) : null);
  const fields: ExportFields = {
    ms_played: ([r.ms_played, r.msPlayed].find((v) => typeof v === "number") as number | undefined) ?? null,
    platform: str(r.platform),
    conn_country: str(r.conn_country),
    reason_start: str(r.reason_start),
    reason_end: str(r.reason_end),
    shuffle: bool(r.shuffle),
    skipped: bool(r.skipped),
    offline: bool(r.offline),
    incognito_mode: bool(r.incognito_mode),
  };
  return {
    play: { played_at_ms: ms, track_id: trackId, track_uri: uri, fields },
    track: {
      track_id: trackId,
      track_uri: uri,
      name: str(r.master_metadata_track_name, r.trackName),
      artists: str(r.master_metadata_album_artist_name, r.artistName),
      album: str(r.master_metadata_album_album_name),
      explicit,
    },
  };
}

/** ISO 8601 (extended export `ts`), or legacy "YYYY-MM-DD HH:MM" (`endTime`) treated as UTC. */
export function parseTimestamp(ts: string): number | null {
  const legacy = ts.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/);
  const ms = legacy ? Date.UTC(+legacy[1]!, +legacy[2]! - 1, +legacy[3]!, +legacy[4]!, +legacy[5]!) : Date.parse(ts);
  return Number.isFinite(ms) ? ms : null;
}

/** JSON array, single object, or newline-delimited JSON. */
export function loadRecords(path: string): Rec[] {
  const text = readFileSync(path, "utf8").trim();
  try {
    const parsed = JSON.parse(text);
    return (Array.isArray(parsed) ? parsed : [parsed]).filter((r) => r && typeof r === "object");
  } catch {
    return text.split("\n").flatMap((line) => {
      try {
        const r = JSON.parse(line);
        return r && typeof r === "object" ? [r] : [];
      } catch {
        return [];
      }
    });
  }
}

/** INSERT OR IGNORE, or an upsert when `onConflict` (an ON CONFLICT clause) is given. */
function insertStatements(table: string, cols: string[], rows: unknown[][], onConflict?: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < rows.length; i += ROWS_PER_STATEMENT) {
    const values = rows.slice(i, i + ROWS_PER_STATEMENT).map((r) => `(${r.map(lit).join(", ")})`).join(",\n");
    out.push(
      onConflict
        ? `INSERT INTO ${table}(${cols.join(", ")}) VALUES\n${values}\n${onConflict};`
        : `INSERT OR IGNORE INTO ${table}(${cols.join(", ")}) VALUES\n${values};`,
    );
  }
  return out;
}

/** Deletes plays by primary key; the row-value IN is a primary-key lookup, not a scan. */
function deleteStatements(keys: Array<[number, string]>): string[] {
  const out: string[] = [];
  for (let i = 0; i < keys.length; i += ROWS_PER_STATEMENT) {
    const values = keys.slice(i, i + ROWS_PER_STATEMENT).map(([ms, id]) => `(${ms}, ${lit(id)})`).join(",\n");
    out.push(`DELETE FROM plays WHERE (played_at_ms, track_id) IN (VALUES\n${values});`);
  }
  return out;
}

function writeChunks(dir: string, prefix: string, statements: string[], rowsPerStatement: number): string[] {
  const perFile = Math.max(1, Math.floor(ROWS_PER_FILE / rowsPerStatement));
  const files: string[] = [];
  for (let i = 0; i < statements.length; i += perFile) {
    const f = join(dir, `${prefix}-${String(files.length).padStart(3, "0")}.sql`);
    writeFileSync(f, statements.slice(i, i + perFile).join("\n") + "\n");
    files.push(f);
  }
  return files;
}

const count = (db: string, sql: string) => Number(Object.values(d1Rows(db, sql)[0] ?? {})[0] ?? 0);
const playKey = (ms: number, trackId: string) => `${ms}:${trackId}`;
const year = (ms: number) => new Date(ms).getUTCFullYear();

/**
 * Plays in D1 with from <= played_at_ms < to, keyed like `plays`, mapped to whether they
 * already carry the export fields. One query per calendar year keeps responses small.
 */
function currentPlays(db: string, from: number, to: number): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (let y = year(from); y <= year(to); y++) {
    const [lo, hi] = [Math.max(from, Date.UTC(y, 0, 1)), Math.min(to, Date.UTC(y + 1, 0, 1))];
    const rows = d1Rows<{ played_at_ms: number; track_id: string; has_fields: number }>(
      db,
      `SELECT played_at_ms, track_id, ms_played IS NOT NULL AS has_fields FROM plays WHERE played_at_ms >= ${lo} AND played_at_ms < ${hi}`,
    );
    for (const r of rows) out.set(playKey(r.played_at_ms, r.track_id), r.has_fields === 1);
  }
  return out;
}

function applyDiff(db: string, tracks: Map<string, Track>, toInsert: Play[], toUpdate: Play[], toDelete: Array<[number, string]>): void {
  const before = { plays: count(db, "SELECT COUNT(*) FROM plays"), tracks: count(db, "SELECT COUNT(*) FROM tracks") };
  const tmp = mkdtempSync(join(tmpdir(), "spotify-import-"));
  try {
    const insertTrackIds = new Set(toInsert.map((p) => p.track_id));
    const trackStmts = insertStatements(
      "tracks",
      ["track_id", "track_uri", "name", "artists", "album", "explicit"],
      [...tracks.values()].filter((t) => insertTrackIds.has(t.track_id)).map((t) => [t.track_id, t.track_uri, t.name, t.artists, t.album, t.explicit]),
    );
    const fieldNames = EXPORT_PLAY_FIELDS.map(([name]) => name);
    const playStmts = insertStatements(
      "plays",
      ["played_at_ms", "track_id", "track_uri", "source", ...fieldNames],
      [...toInsert, ...toUpdate].map((p) => [p.played_at_ms, p.track_id, p.track_uri, "history_import", ...fieldNames.map((f) => p.fields[f])]),
      `ON CONFLICT(played_at_ms, track_id) DO UPDATE SET ${fieldNames.map((f) => `${f}=excluded.${f}`).join(", ")}`,
    );
    // Tracks first (plays reference them), and inserts before deletes so an interrupted run never loses plays.
    const chunks = [
      ...writeChunks(tmp, "1-tracks", trackStmts, ROWS_PER_STATEMENT),
      ...writeChunks(tmp, "2-plays", playStmts, ROWS_PER_STATEMENT),
      ...writeChunks(tmp, "3-deletes", deleteStatements(toDelete), ROWS_PER_STATEMENT),
    ];
    chunks.forEach((f, i) => {
      d1ExecFile(db, f);
      console.log(`  applied chunk ${i + 1}/${chunks.length}`);
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  const after = { plays: count(db, "SELECT COUNT(*) FROM plays"), tracks: count(db, "SELECT COUNT(*) FROM tracks") };
  console.log(`Plays: ${before.plays} -> ${after.plays}, new tracks: ${after.tracks - before.tracks}`);
}

async function enrich(db: string): Promise<void> {
  const token = await accessTokenFromD1(db);
  const missingCredits = d1Rows<{ track_id: string }>(
    db,
    "SELECT t.track_id FROM tracks t WHERE NOT EXISTS (SELECT 1 FROM track_artists ta WHERE ta.track_id = t.track_id)",
  ).map((r) => r.track_id);
  console.log(`Enriching: ${missingCredits.length} tracks without artist credits`);

  const statements: string[] = [];
  for (let i = 0; i < missingCredits.length; i += 50) {
    const resp = await spotifyGet<{ tracks?: Array<SpotifyTrack | null> }>(token, `/tracks?ids=${missingCredits.slice(i, i + 50).join(",")}`);
    const rows = (resp.tracks ?? []).flatMap((t) => (t?.id && t.uri ? trackRows(t as SpotifyTrack & { id: string; uri: string }).artists : []));
    statements.push(...insertStatements("track_artists", ["track_id", "artist_id", "artist_name", "position"], rows.map((r) => [r.track_id, r.artist_id, r.artist_name, r.position])));
  }

  const tmp = mkdtempSync(join(tmpdir(), "spotify-enrich-"));
  try {
    for (const f of writeChunks(tmp, "track-artists", statements, ROWS_PER_STATEMENT)) d1ExecFile(db, f);
    const missingArtists = d1Rows<{ artist_id: string }>(
      db,
      "SELECT DISTINCT ta.artist_id FROM track_artists ta LEFT JOIN artists a ON a.artist_id = ta.artist_id WHERE a.artist_id IS NULL",
    ).map((r) => r.artist_id);
    console.log(`Enriching: ${missingArtists.length} artists without metadata`);

    const artistStatements: string[] = [];
    for (let i = 0; i < missingArtists.length; i += 50) {
      const resp = await spotifyGet<{ artists?: Array<SpotifyArtistFull | null> }>(token, `/artists?ids=${missingArtists.slice(i, i + 50).join(",")}`);
      const rows = (resp.artists ?? []).flatMap((a) =>
        a?.id && a.name ? [[a.id, a.name, a.genres?.length ? genresJson(a.genres) : null, a.popularity ?? null, a.followers?.total ?? null]] : [],
      );
      artistStatements.push(...insertStatements("artists", ["artist_id", "name", "genres", "popularity", "followers"], rows));
    }
    for (const f of writeChunks(tmp, "artists", artistStatements, ROWS_PER_STATEMENT)) d1ExecFile(db, f);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const target = process.argv.slice(2).find((a, i, all) => !a.startsWith("--") && all[i - 1] !== "--db");
  if (!target) throw new Error("Usage: npm run import-history -- <export-dir> [--db name] [--dry-run]");
  const db = flag("db", DEFAULT_DB);
  const dryRun = process.argv.includes("--dry-run");

  const files = statSync(target).isDirectory()
    ? readdirSync(target).filter((f) => f.toLowerCase().endsWith(".json")).sort().map((f) => join(target, f))
    : [target];
  if (!files.length) throw new Error(`No JSON files in ${target}`);

  const plays = new Map<string, Play>();
  const tracks = new Map<string, Track>();
  let [seen, skipped, short] = [0, 0, 0];
  let [first, last] = [Infinity, -Infinity];
  for (const f of files) {
    const records = loadRecords(f);
    seen += records.length;
    for (const r of records) {
      const parsed = parseRecord(r);
      if (!parsed) {
        skipped++;
        continue;
      }
      const { play, track } = parsed;
      // The span covers every track record, so shorter streams inside it get deleted too.
      [first, last] = [Math.min(first, play.played_at_ms), Math.max(last, play.played_at_ms)];
      if ((play.fields.ms_played ?? 0) < MIN_MS_PLAYED) {
        short++;
        continue;
      }
      plays.set(playKey(play.played_at_ms, play.track_id), play);
      if (!tracks.has(track.track_id)) tracks.set(track.track_id, track);
    }
  }
  console.log(`${files.length} files, ${seen} records, ${skipped} skipped (no track URI or timestamp), ${short} under ${MIN_MS_PLAYED / 1000} s`);
  if (first > last) return;
  const [from, to] = [first, last + SPAN_TAIL_MS];
  console.log(`Span ${new Date(from).toISOString()} .. ${new Date(to).toISOString()}: ${plays.size} plays, ${tracks.size} tracks`);

  const schemaVersion = count(db, "SELECT MAX(version) FROM schema_migrations");
  if (schemaVersion < 9) throw new Error(`${db} is at schema v${schemaVersion}; deploy the Worker first (its next job applies v9)`);
  const current = currentPlays(db, from, to);
  const toInsert = [...plays].filter(([k]) => !current.has(k)).map(([, p]) => p);
  const toUpdate = [...plays].filter(([k]) => current.get(k) === false).map(([, p]) => p);
  const toDelete = [...current.keys()].filter((k) => !plays.has(k)).map((k): [number, string] => {
    const [ms, trackId] = k.split(":");
    return [Number(ms), trackId!];
  });
  const byYear = new Map<number, [number, number, number]>();
  const tally = (ms: number, i: 0 | 1 | 2) => {
    const counts = byYear.get(year(ms)) ?? [0, 0, 0];
    counts[i]++;
    byYear.set(year(ms), counts);
  };
  for (const p of toInsert) tally(p.played_at_ms, 0);
  for (const p of toUpdate) tally(p.played_at_ms, 1);
  for (const [ms] of toDelete) tally(ms, 2);
  console.log(`D1 has ${current.size} plays in the span; diff +${toInsert.length} / ~${toUpdate.length} / -${toDelete.length} (insert / add export fields / delete)`);
  for (const [y, [ins, upd, del]] of [...byYear].sort(([a], [b]) => a - b)) console.log(`  ${y}: +${ins} / ~${upd} / -${del}`);
  if (dryRun) return;

  if (toInsert.length || toUpdate.length || toDelete.length) applyDiff(db, tracks, toInsert, toUpdate, toDelete);
  await enrich(db); // also on an empty diff, so a re-run finishes an enrichment that failed
  console.log("Done. Next: run /sync-full to add new tracks to Liked Songs and the frequent playlist (see README).");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
