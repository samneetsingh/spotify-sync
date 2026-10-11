/**
 * Reconcile D1 plays with a Spotify privacy export (Extended Streaming History JSON), then
 * enrich new tracks with artist credits and artist metadata (genres for hindi-favorites,
 * credits for artist playlists).
 *
 * Usage: npm run import-history -- <export-dir> [--db <database name>] [--dry-run]
 * The database defaults to the production one in wrangler.generated.toml (or $WRANGLER_CONFIG).
 * The dashboard's Import page does the same from the uploaded zip (src/import); both use the
 * parser and diff in src/import/parse.ts and plan.ts, so they reconcile identically.
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
 * Imported tracks don't reach Liked Songs or the frequent playlist from here; the dashboard
 * import offers that backfill.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXPORT_PLAY_FIELDS } from "../src/db/schema";
import { ExportCollector, MIN_MS_PLAYED, isAudioHistoryFile, parseRecordsText, playKey, type ExportPlay, type ExportTrack } from "../src/import/parse";
import { planReconcile, utcYear } from "../src/import/plan";
import { genresJson, trackRows } from "../src/spotify/metadata";
import type { SpotifyArtistFull, SpotifyTrack } from "../src/spotify/types";
import { accessTokenFromD1, d1ExecFile, d1Rows, lit, schemaVersion, spotifyGet, targetDb } from "./lib";

const ROWS_PER_STATEMENT = 200; // keeps each statement well under D1's 100 KB limit
const ROWS_PER_FILE = 20_000;

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

/**
 * Plays in D1 with from <= played_at_ms < to, keyed like `plays`, mapped to whether they
 * already carry the export fields. One query per calendar year keeps responses small.
 */
function currentPlays(db: string, from: number, to: number): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (let y = utcYear(from); y <= utcYear(to); y++) {
    const [lo, hi] = [Math.max(from, Date.UTC(y, 0, 1)), Math.min(to, Date.UTC(y + 1, 0, 1))];
    const rows = d1Rows<{ played_at_ms: number; track_id: string; has_fields: number }>(
      db,
      `SELECT played_at_ms, track_id, ms_played IS NOT NULL AS has_fields FROM plays WHERE played_at_ms >= ${lo} AND played_at_ms < ${hi}`,
    );
    for (const r of rows) out.set(playKey(r.played_at_ms, r.track_id), r.has_fields === 1);
  }
  return out;
}

function applyDiff(db: string, tracks: Map<string, ExportTrack>, toInsert: ExportPlay[], toUpdate: ExportPlay[], toDelete: Array<[number, string]>): void {
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
  const db = targetDb();
  const dryRun = process.argv.includes("--dry-run");

  // A directory: its audio history files (Streaming_History_Audio_*.json, older endsong_*.json),
  // in name order like the dashboard import; video history and other JSON files are ignored.
  const files = statSync(target).isDirectory()
    ? readdirSync(target).filter(isAudioHistoryFile).sort().map((f) => join(target, f))
    : [target];
  if (!files.length) throw new Error(`No Streaming_History_Audio_*.json (or endsong_*.json) files in ${target}`);

  const collected = new ExportCollector();
  for (const f of files) collected.add(parseRecordsText(readFileSync(f, "utf8")));
  const { plays, tracks } = collected;
  console.log(`${files.length} files, ${collected.seen} records, ${collected.skipped} skipped (no track URI or timestamp), ${collected.short} under ${MIN_MS_PLAYED / 1000} s`);
  const span = collected.span();
  if (!span) return;
  const { from, to } = span;
  console.log(`Span ${new Date(from).toISOString()} .. ${new Date(to).toISOString()}: ${plays.size} plays, ${tracks.size} tracks`);

  const version = schemaVersion(db);
  if (version < 9) throw new Error(`${db} is at schema v${version}; run \`npm run token\` first (it applies the schema and stores the login the import needs)`);
  const current = currentPlays(db, from, to);
  const { toInsert, toUpdate, toDelete, byYear } = planReconcile(plays, current);
  console.log(`D1 has ${current.size} plays in the span; diff +${toInsert.length} / ~${toUpdate.length} / -${toDelete.length} (insert / add export fields / delete)`);
  for (const [y, [ins, upd, del]] of byYear) console.log(`  ${y}: +${ins} / ~${upd} / -${del}`);
  if (dryRun) return;

  if (toInsert.length || toUpdate.length || toDelete.length) applyDiff(db, tracks, toInsert, toUpdate, toDelete);
  await enrich(db); // also on an empty diff, so a re-run finishes an enrichment that failed
  console.log("Done. (Liked Songs / Frequent Plays backfill: use the dashboard's Import page.)");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
