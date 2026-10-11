// Reading the uploaded export into the `import_plays` staging table, one file or zip entry per
// Workflow step, with the same parsing and duplicate rules as the CLI script (src/import/parse.ts).

import { EXPORT_PLAY_FIELDS } from "../db/schema";
import { ExportCollector, parseRecordsText } from "./parse";
import { OPEN_STATUSES, setProgress, type ImportFile, type StageEntry } from "./store";
import { ImportError, MAX_ENTRY_BYTES, NOT_EXTENDED_HISTORY, audioEntries, listZipEntries, r2Source, readTextLimited, zipEntryStream } from "./zip";

/** Rows per staging statement: one bound JSON array expanded with json_each (D1: <= 100 bound parameters). */
const STAGE_CHUNK = 500;

/** import_plays columns after import_id, in the order of each staged row array. */
export const STAGE_COLUMNS = ["played_at_ms", "track_id", "track_uri", "name", "artists", "album", "explicit", ...EXPORT_PLAY_FIELDS.map(([name]) => name)];

// Rows belong to their import (?2). The last duplicate wins, across entries too (entries are staged
// in the CLI's file order).
const UPSERT_STAGED = `INSERT INTO import_plays (import_id, ${STAGE_COLUMNS.join(", ")})
SELECT ?2, ${STAGE_COLUMNS.map((_, i) => `json_extract(value, '$[${i}]')`).join(", ")} FROM json_each(?1) WHERE true
ON CONFLICT(import_id, played_at_ms, track_id) DO UPDATE SET ${STAGE_COLUMNS.slice(2).map((c) => `${c} = excluded.${c}`).join(", ")}`;

export const uploadPrefix = (importId: string): string => `imports/${importId}/`;
const baseName = (path: string) => path.split("/").pop() ?? path;
const entriesPath = (key: string) => `$."${key}"`;

/** Staged rows for a collector's plays; each track's metadata is its first record in this entry. */
export function stageRows(c: ExportCollector): unknown[][] {
  return [...c.plays.values()].map((p) => {
    const t = c.tracks.get(p.track_id);
    return [p.played_at_ms, p.track_id, p.track_uri, t?.name ?? null, t?.artists ?? null, t?.album ?? null, t?.explicit ?? null, ...EXPORT_PLAY_FIELDS.map(([f]) => p.fields[f])];
  });
}

/** Statements that upsert `rows` into import_plays for `importId`. */
export function stageStatements(db: D1Database, importId: string, rows: unknown[][]): D1PreparedStatement[] {
  const out: D1PreparedStatement[] = [];
  for (let i = 0; i < rows.length; i += STAGE_CHUNK) out.push(db.prepare(UPSERT_STAGED).bind(JSON.stringify(rows.slice(i, i + STAGE_CHUNK)), importId));
  return out;
}

/** The entries to stage for the uploaded files, in staging order. */
export async function listEntries(bucket: R2Bucket, files: ImportFile[]): Promise<StageEntry[]> {
  const found: Array<Omit<StageEntry, "i" | "lastOfFile">> = [];
  for (const f of files) {
    const base = { file: f.n, objectKey: f.key, objectSize: f.size };
    // The routes only accept .zip and audio history .json names.
    if (f.key.endsWith(".zip")) {
      for (const e of audioEntries(await listZipEntries(r2Source(bucket, f.key, f.size)))) {
        found.push({ ...base, key: `${f.n}/${e.offset}`, name: e.name, kind: "zip", method: e.method, offset: e.offset, compressedSize: e.compressedSize, size: e.size });
      }
    } else {
      found.push({ ...base, key: `${f.n}/0`, name: f.name, kind: "json", method: 0, offset: 0, compressedSize: f.size, size: f.size });
    }
  }
  if (!found.length) throw new ImportError(NOT_EXTENDED_HISTORY);
  // The CLI reads a folder's files sorted by name; the last duplicate play wins, so order matters.
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  found.sort((a, b) => cmp(baseName(a.name), baseName(b.name)) || cmp(a.name, b.name) || a.file - b.file || a.offset - b.offset);
  const lastIndex = new Map(found.map((e, i) => [e.file, i]));
  return found.map((e, i) => ({ ...e, i, lastOfFile: lastIndex.get(e.file) === i }));
}

/**
 * The `index` step: lists the entries once and records them in `imports.entries`; a retry reuses
 * that record (the uploads may already be deleted). The first time it also clears this import's
 * staging rows (none, normally) and those of imports that are over (an interrupted Workflow can
 * leave some); rows of an open import are never touched.
 */
export async function indexImport(db: D1Database, bucket: R2Bucket, importId: string, now = Date.now()): Promise<StageEntry[]> {
  const row = await db.prepare("SELECT status, files, entries FROM imports WHERE id = ?1").bind(importId).first<{ status: string; files: string; entries: string }>();
  if (!row || row.status === "cancelled") throw new ImportError("This import was cancelled.");
  const recorded = Object.values(JSON.parse(row.entries) as Record<string, StageEntry>);
  if (recorded.length) return recorded.sort((a, b) => a.i - b.i);

  const files = (JSON.parse(row.files) as ImportFile[]).filter((f) => f.done);
  const entries = await listEntries(bucket, files);
  await db.batch([
    db
      .prepare(
        `DELETE FROM import_plays WHERE (SELECT entries FROM imports WHERE id = ?1) = '{}'
           AND (import_id = ?1 OR import_id NOT IN (SELECT id FROM imports WHERE status IN (SELECT value FROM json_each(?2))))`,
      )
      .bind(importId, JSON.stringify(OPEN_STATUSES)),
    db
      .prepare("UPDATE imports SET entries = ?2, progress = ?3, updated_at = ?4 WHERE id = ?1 AND entries = '{}'")
      .bind(importId, JSON.stringify(Object.fromEntries(entries.map((e) => [e.key, e]))), `Reading ${entries.length} file${entries.length === 1 ? "" : "s"}`, now),
  ]);
  return entries;
}

/** An entry's text, at most MAX_ENTRY_BYTES. */
export async function readEntryText(bucket: R2Bucket, entry: StageEntry): Promise<string> {
  if (entry.kind === "json") {
    const obj = await bucket.get(entry.objectKey);
    if (!obj) throw new ImportError("The uploaded file is gone (uploads are kept for 7 days at most). Start a new import.");
    return readTextLimited(obj.body, MAX_ENTRY_BYTES, baseName(entry.name));
  }
  const stream = await zipEntryStream(r2Source(bucket, entry.objectKey, entry.objectSize), entry);
  return readTextLimited(stream, MAX_ENTRY_BYTES, baseName(entry.name));
}

export interface StageResult {
  /** Already staged by an earlier attempt: nothing was read. */
  already: boolean;
  records: number;
  plays: number;
}

/**
 * The `stage` step for one entry: parse, then one atomic batch that upserts its plays and marks it
 * done in `imports.entries` (with the span), so a replay skips it. The entry's R2 object is deleted
 * as soon as its last entry is staged.
 */
export async function stageEntry(db: D1Database, bucket: R2Bucket, importId: string, entry: StageEntry, total: number, now = Date.now()): Promise<StageResult> {
  const state = await db
    .prepare("SELECT status, json_extract(entries, ?2) AS done FROM imports WHERE id = ?1")
    .bind(importId, `${entriesPath(entry.key)}.done`)
    .first<{ status: string; done: number | null }>();
  if (!state || state.status === "cancelled") throw new ImportError("This import was cancelled.");

  let result: StageResult = { already: true, records: 0, plays: 0 };
  if (!state.done) {
    const c = new ExportCollector().add(parseRecordsText(await readEntryText(bucket, entry)));
    const done: StageEntry = { ...entry, done: true, records: c.seen, skipped: c.skipped, short: c.short, plays: c.plays.size };
    const first = Number.isFinite(c.first) ? c.first : null;
    const last = Number.isFinite(c.last) ? c.last : null;
    await db.batch([
      ...stageStatements(db, importId, stageRows(c)),
      db
        .prepare(
          `UPDATE imports SET entries = json_set(entries, ?2, json(?3)),
             span_from = CASE WHEN ?4 IS NULL THEN span_from ELSE MIN(COALESCE(span_from, ?4), ?4) END,
             span_to = CASE WHEN ?5 IS NULL THEN span_to ELSE MAX(COALESCE(span_to, ?5), ?5) END,
             updated_at = ?6 WHERE id = ?1`,
        )
        .bind(importId, entriesPath(entry.key), JSON.stringify(done), first, last, now),
      setProgress(db, importId, `Read file ${entry.i + 1} of ${total}`, now),
    ]);
    result = { already: false, records: c.seen, plays: c.plays.size };
  }
  if (entry.lastOfFile) await bucket.delete(entry.objectKey);
  return result;
}

/** Deletes everything uploaded for this import (R2 keeps nothing once it's staged). */
export async function deleteUpload(bucket: R2Bucket, importId: string): Promise<number> {
  let deleted = 0;
  for (;;) {
    const listed = await bucket.list({ prefix: uploadPrefix(importId), limit: 1000 });
    if (!listed.objects.length) return deleted;
    await bucket.delete(listed.objects.map((o) => o.key));
    deleted += listed.objects.length;
    if (!listed.truncated) return deleted;
  }
}
