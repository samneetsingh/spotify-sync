// The `imports` table (schema v11): one row per history import, the Workflow's durable state.

import type { DiffCounts } from "./plan";

export type ImportStatus = "uploading" | "reading" | "review" | "applying" | "done" | "failed" | "cancelled" | "expired";

/** Statuses that block starting another import (a failed one is retried or discarded first). */
export const OPEN_STATUSES: readonly ImportStatus[] = ["uploading", "reading", "review", "applying", "failed"];
/** Before the owner's approval: cancel discards everything and nothing has been applied. */
export const CANCELLABLE: readonly ImportStatus[] = ["uploading", "reading", "review", "failed"];

/** An uploaded file. R2 keys are imports/<id>/<n>.<zip|json>, never the owner's file names. */
export interface ImportFile {
  n: number;
  name: string;
  size: number;
  key: string;
  uploadId: string;
  done: boolean;
}

/** One export file to stage: a JSON upload or an audio entry of an uploaded zip. */
export interface StageEntry {
  /** Key in `imports.entries`: "<file n>/<offset of the zip entry, 0 for JSON>". */
  key: string;
  /** Position in staging order (by file name, like the CLI script). */
  i: number;
  file: number;
  objectKey: string;
  objectSize: number;
  name: string;
  kind: "json" | "zip";
  method: number;
  offset: number;
  compressedSize: number;
  size: number;
  /** The last entry of its upload: the R2 object is deleted once this one is staged. */
  lastOfFile: boolean;
  done?: boolean;
  records?: number;
  skipped?: number;
  short?: number;
  plays?: number;
}

export interface ImportOptions {
  /** Add every imported track to Liked Songs (off by default; needs an explicit confirmation). */
  liked: boolean;
  /** Add newly frequent tracks to Frequent Plays (on by default; only while that playlist is on). */
  frequent: boolean;
}

export interface Preview {
  /** The span [from, to) the export replaces. */
  from: number;
  to: number;
  records: number;
  skipped: number;
  short: number;
  /** Staged plays (>= 30 s, deduplicated). */
  plays: number;
  /** "YYYY-MM" (UTC) -> [inserts, updates, deletes]. */
  months: Record<string, DiffCounts>;
  totals: DiffCounts;
  /** Either one makes the owner tick "I understand" before importing. */
  warnings: {
    /** Few of the plays the live sync recorded in the span have a twin in the export. */
    accountMismatch?: { synced: number; matched: number };
    /** The import would delete many plays an earlier import added. */
    historyLoss?: { deletes: number; imported: number };
  };
}

export interface ImportRow {
  id: string;
  created_at: number;
  updated_at: number;
  status: ImportStatus;
  files: ImportFile[];
  entries: Record<string, StageEntry>;
  span_from: number | null;
  span_to: number | null;
  preview: Preview | null;
  options: ImportOptions | null;
  applied_to: number | null;
  progress: string | null;
  error: string | null;
  attempt: number;
}

type RawRow = Omit<ImportRow, "files" | "entries" | "preview" | "options"> & { files: string; entries: string; preview: string | null; options: string | null };

const parse = (r: RawRow | null): ImportRow | null =>
  r && {
    ...r,
    files: JSON.parse(r.files),
    entries: JSON.parse(r.entries),
    preview: r.preview ? JSON.parse(r.preview) : null,
    options: r.options ? JSON.parse(r.options) : null,
  };

export async function getImport(db: D1Database, id: string): Promise<ImportRow | null> {
  return parse(await db.prepare("SELECT * FROM imports WHERE id = ?1").bind(id).first<RawRow>());
}

/** The newest import, whatever its status. */
export async function latestImport(db: D1Database): Promise<ImportRow | null> {
  return parse(await db.prepare("SELECT * FROM imports ORDER BY created_at DESC, rowid DESC LIMIT 1").first<RawRow>());
}

/** The Workflow instance of an attempt: the import id, then `<id>-r<attempt>` for retries. */
export const instanceId = (importId: string, attempt: number): string => (attempt ? `${importId}-r${attempt}` : importId);

/** Sets status and progress (and error, when given), bumps updated_at; `onlyFrom` makes it conditional. */
export async function setStatus(
  db: D1Database,
  id: string,
  status: ImportStatus,
  progress: string | null,
  opts: { error?: string | null; now?: number; onlyFrom?: readonly ImportStatus[] } = {},
): Promise<boolean> {
  const sets = ["status = ?2", "progress = ?3", "updated_at = ?4", "error = CASE WHEN ?5 THEN ?6 ELSE error END"];
  const where = opts.onlyFrom ? " AND status IN (SELECT value FROM json_each(?7))" : " AND ?7 IS NULL";
  const res = await db
    .prepare(`UPDATE imports SET ${sets.join(", ")} WHERE id = ?1${where}`)
    .bind(id, status, progress, opts.now ?? Date.now(), opts.error !== undefined ? 1 : 0, opts.error ?? null, opts.onlyFrom ? JSON.stringify(opts.onlyFrom) : null)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

export const setProgress = (db: D1Database, id: string, progress: string, now = Date.now()): D1PreparedStatement =>
  db.prepare("UPDATE imports SET progress = ?2, updated_at = ?3 WHERE id = ?1").bind(id, progress, now);
