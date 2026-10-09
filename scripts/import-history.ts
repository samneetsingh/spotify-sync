/**
 * Import a Spotify privacy export (Extended Streaming History JSON) into D1, then
 * enrich new tracks with artist credits and artist metadata (genres for hindi-favorites,
 * credits for artist playlists). Port of the Python `import-history` + `enrich` commands.
 *
 * Usage: npm run import-history -- <file-or-dir> [--db spotify-sync] [--dry-run]
 * Safe to re-run: plays and tracks use INSERT OR IGNORE, so existing rows are untouched
 * (unlike Python, history data never overwrites richer API metadata).
 *
 * Afterwards, to add newly imported tracks to Liked Songs and the frequent playlist,
 * run the Worker's /sync-full (see README).
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { genresJson, trackRows } from "../src/spotify/metadata";
import type { SpotifyArtistFull, SpotifyTrack } from "../src/spotify/types";
import { DEFAULT_DB, accessTokenFromD1, d1ExecFile, d1Rows, flag, lit, spotifyGet } from "./lib";

const ROWS_PER_STATEMENT = 200; // keeps each statement well under D1's 100 KB limit
const ROWS_PER_FILE = 20_000;

type Rec = Record<string, unknown>;
interface Play { played_at_ms: number; track_id: string; track_uri: string }
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
  return {
    play: { played_at_ms: ms, track_id: trackId, track_uri: uri },
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

function insertStatements(table: string, cols: string[], rows: unknown[][]): string[] {
  const out: string[] = [];
  for (let i = 0; i < rows.length; i += ROWS_PER_STATEMENT) {
    const values = rows.slice(i, i + ROWS_PER_STATEMENT).map((r) => `(${r.map(lit).join(", ")})`).join(",\n");
    out.push(`INSERT OR IGNORE INTO ${table}(${cols.join(", ")}) VALUES\n${values};`);
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
  if (!target) throw new Error("Usage: npm run import-history -- <file-or-dir> [--db name] [--dry-run]");
  const db = flag("db", DEFAULT_DB);
  const dryRun = process.argv.includes("--dry-run");

  const files = statSync(target).isDirectory()
    ? readdirSync(target).filter((f) => f.toLowerCase().endsWith(".json")).sort().map((f) => join(target, f))
    : [target];
  if (!files.length) throw new Error(`No JSON files in ${target}`);

  const plays = new Map<string, Play>();
  const tracks = new Map<string, Track>();
  let seen = 0;
  let skipped = 0;
  for (const f of files) {
    const records = loadRecords(f);
    seen += records.length;
    for (const r of records) {
      const parsed = parseRecord(r);
      if (!parsed) {
        skipped++;
        continue;
      }
      plays.set(`${parsed.play.played_at_ms}:${parsed.play.track_id}`, parsed.play);
      if (!tracks.has(parsed.track.track_id)) tracks.set(parsed.track.track_id, parsed.track);
    }
  }
  let [first, last] = [Infinity, -Infinity];
  for (const p of plays.values()) [first, last] = [Math.min(first, p.played_at_ms), Math.max(last, p.played_at_ms)];
  console.log(`${files.length} files, ${seen} records, ${skipped} skipped (no track URI or timestamp)`);
  if (!plays.size) return;
  console.log(`${plays.size} unique plays, ${tracks.size} unique tracks, ${new Date(first).toISOString()} .. ${new Date(last).toISOString()}`);
  if (dryRun) return;

  const before = { plays: count(db, "SELECT COUNT(*) FROM plays"), tracks: count(db, "SELECT COUNT(*) FROM tracks") };
  const tmp = mkdtempSync(join(tmpdir(), "spotify-import-"));
  try {
    const trackStmts = insertStatements(
      "tracks",
      ["track_id", "track_uri", "name", "artists", "album", "explicit"],
      [...tracks.values()].map((t) => [t.track_id, t.track_uri, t.name, t.artists, t.album, t.explicit]),
    );
    const playStmts = insertStatements(
      "plays",
      ["played_at_ms", "track_id", "track_uri", "source"],
      [...plays.values()].map((p) => [p.played_at_ms, p.track_id, p.track_uri, "history_import"]),
    );
    // Tracks first: plays reference them (foreign key).
    const chunks = [...writeChunks(tmp, "1-tracks", trackStmts, ROWS_PER_STATEMENT), ...writeChunks(tmp, "2-plays", playStmts, ROWS_PER_STATEMENT)];
    chunks.forEach((f, i) => {
      d1ExecFile(db, f);
      console.log(`  imported chunk ${i + 1}/${chunks.length}`);
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  const after = { plays: count(db, "SELECT COUNT(*) FROM plays"), tracks: count(db, "SELECT COUNT(*) FROM tracks") };
  console.log(`New plays: ${after.plays - before.plays}, new tracks: ${after.tracks - before.tracks}`);

  await enrich(db);
  console.log("Done. Next: run /sync-full to add new tracks to Liked Songs and the frequent playlist (see README).");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
