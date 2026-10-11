// Preview and apply in SQL: the same diff as planReconcile (src/import/plan.ts), computed against the
// staging table one UTC year (preview) or month (apply) at a time so every query stays small. Every
// query reads only the given import's staging rows (import_plays.import_id).

import { EXPORT_PLAY_FIELDS } from "../db/schema";
import { SPAN_TAIL_MS } from "./parse";
import type { DiffCounts } from "./plan";
import type { Preview } from "./store";
import { ImportError } from "./zip";

/** Warn when fewer than this share of the live sync's plays in the span have a twin in the export. */
export const MISMATCH_MIN_SYNCED = 20;
export const MISMATCH_MAX_SHARE = 0.5;
/** A twin: same track within this many ms (API play times differ from the export's by seconds). */
export const TWIN_WINDOW_MS = 120_000;
/** Warn when the import deletes more than this many plays an earlier import added, and more than HISTORY_LOSS_SHARE of them. */
export const HISTORY_LOSS_MIN = 100;
export const HISTORY_LOSS_SHARE = 0.01;

export interface Span {
  from: number;
  to: number;
}

/** The staged export's span: first record to last record + SPAN_TAIL_MS, as the CLI computes it. */
export const spanOf = (spanFrom: number, spanTo: number): Span => ({ from: spanFrom, to: spanTo + SPAN_TAIL_MS });

const monthLabel = (ms: number) => new Date(ms).toISOString().slice(0, 7);

/** The span cut at UTC month boundaries: one apply step each. */
export function monthSlices(span: Span): Array<Span & { label: string }> {
  const out: Array<Span & { label: string }> = [];
  for (let from = span.from; from < span.to; ) {
    const d = new Date(from);
    const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
    const to = Math.min(next, span.to);
    out.push({ label: monthLabel(from), from, to });
    from = to;
  }
  return out;
}

/** The span's UTC years: one preview step each. */
export function yearSlices(span: Span): Array<Span & { year: number }> {
  const out: Array<Span & { year: number }> = [];
  for (let y = new Date(span.from).getUTCFullYear(); Date.UTC(y, 0, 1) < span.to; y++) {
    out.push({ year: y, from: Math.max(span.from, Date.UTC(y, 0, 1)), to: Math.min(span.to, Date.UTC(y + 1, 0, 1)) });
  }
  return out;
}

const MONTH = "strftime('%Y-%m', played_at_ms / 1000, 'unixepoch')";

export interface YearPreview {
  months: Record<string, DiffCounts>;
  /** recently_played plays in the slice, and how many have a staged twin. */
  synced: number;
  matched: number;
  /** history_import plays in the slice, and how many would be deleted. */
  imported: number;
  importedDeletes: number;
}

/** The diff for one slice (a year) of `importId`, read-only: inserts, updates and deletes per month, plus the warning inputs. */
export async function previewSlice(db: D1Database, importId: string, slice: Span): Promise<YearPreview> {
  const [ins, upd, del, synced, imported] = await db.batch<{ m?: string; n: number; h?: number; matched?: number }>([
    db
      .prepare(
        `SELECT ${MONTH} AS m, COUNT(*) AS n FROM import_plays i WHERE i.import_id = ?3 AND played_at_ms >= ?1 AND played_at_ms < ?2
           AND NOT EXISTS (SELECT 1 FROM plays p WHERE p.played_at_ms = i.played_at_ms AND p.track_id = i.track_id) GROUP BY m`,
      )
      .bind(slice.from, slice.to, importId),
    db
      .prepare(
        `SELECT ${MONTH} AS m, COUNT(*) AS n FROM import_plays i WHERE i.import_id = ?3 AND played_at_ms >= ?1 AND played_at_ms < ?2
           AND EXISTS (SELECT 1 FROM plays p WHERE p.played_at_ms = i.played_at_ms AND p.track_id = i.track_id AND p.ms_played IS NULL) GROUP BY m`,
      )
      .bind(slice.from, slice.to, importId),
    db
      .prepare(
        `SELECT ${MONTH} AS m, COUNT(*) AS n, SUM(source = 'history_import') AS h FROM plays p WHERE played_at_ms >= ?1 AND played_at_ms < ?2
           AND NOT EXISTS (SELECT 1 FROM import_plays i WHERE i.import_id = ?3 AND i.played_at_ms = p.played_at_ms AND i.track_id = p.track_id) GROUP BY m`,
      )
      .bind(slice.from, slice.to, importId),
    db
      .prepare(
        `SELECT COUNT(*) AS n, COALESCE(SUM(EXISTS (SELECT 1 FROM import_plays i WHERE i.import_id = ?4 AND i.played_at_ms BETWEEN p.played_at_ms - ?3 AND p.played_at_ms + ?3 AND i.track_id = p.track_id)), 0) AS matched
           FROM plays p WHERE p.played_at_ms >= ?1 AND p.played_at_ms < ?2 AND p.source = 'recently_played'`,
      )
      .bind(slice.from, slice.to, TWIN_WINDOW_MS, importId),
    db.prepare("SELECT COUNT(*) AS n FROM plays WHERE played_at_ms >= ?1 AND played_at_ms < ?2 AND source = 'history_import'").bind(slice.from, slice.to),
  ]);
  const months: Record<string, DiffCounts> = {};
  const add = (rows: Array<{ m?: string; n: number }>, i: 0 | 1 | 2) => {
    for (const r of rows) (months[r.m!] ??= [0, 0, 0])[i] += r.n;
  };
  add(ins!.results, 0);
  add(upd!.results, 1);
  add(del!.results, 2);
  return {
    months,
    synced: synced!.results[0]?.n ?? 0,
    matched: synced!.results[0]?.matched ?? 0,
    imported: imported!.results[0]?.n ?? 0,
    importedDeletes: del!.results.reduce((s, r) => s + (r.h ?? 0), 0),
  };
}

/** Folds the per-year previews into the stored Preview (sorted months, totals, warnings). */
export function buildPreview(span: Span, stats: { records: number; skipped: number; short: number; plays: number }, years: YearPreview[]): Preview {
  const months: Record<string, DiffCounts> = {};
  for (const y of years) Object.assign(months, y.months);
  const sorted = Object.fromEntries(Object.entries(months).sort(([a], [b]) => (a < b ? -1 : 1)));
  const totals: DiffCounts = [0, 0, 0];
  for (const c of Object.values(sorted)) c.forEach((n, i) => (totals[i] += n));
  const sum = (k: "synced" | "matched" | "imported" | "importedDeletes") => years.reduce((s, y) => s + y[k], 0);
  const warnings: Preview["warnings"] = {};
  if (sum("synced") >= MISMATCH_MIN_SYNCED && sum("matched") < sum("synced") * MISMATCH_MAX_SHARE) {
    warnings.accountMismatch = { synced: sum("synced"), matched: sum("matched") };
  }
  if (sum("importedDeletes") > HISTORY_LOSS_MIN && sum("importedDeletes") > sum("imported") * HISTORY_LOSS_SHARE) {
    warnings.historyLoss = { deletes: sum("importedDeletes"), imported: sum("imported") };
  }
  return { ...span, ...stats, months: sorted, totals, warnings };
}

/** Per-year rows for display: [year, inserts, updates, deletes]. */
export function previewYears(p: Preview): Array<[number, ...DiffCounts]> {
  const years = new Map<number, DiffCounts>();
  for (const [m, c] of Object.entries(p.months)) {
    const y = Number(m.slice(0, 4));
    const t = years.get(y) ?? [0, 0, 0];
    c.forEach((n, i) => (t[i] += n));
    years.set(y, t);
  }
  return [...years].sort(([a], [b]) => a - b).map(([y, c]) => [y, ...c]);
}

const FIELDS = EXPORT_PLAY_FIELDS.map(([name]) => name);

// Every statement re-checks the guard, so the batch is a no-op once its month is recorded as applied
// (or if the import isn't in the applying state). Without it, a replayed step would delete the
// whole month: its staging rows are gone by then.
const GUARD = "EXISTS (SELECT 1 FROM imports WHERE id = ?3 AND status = 'applying' AND COALESCE(applied_to, 0) < ?2)";

// Staging rows are this import's only (?3 is the import id).
const APPLY_SQL = [
  // Tracks first: plays reference them (D1 enforces foreign keys). Existing tracks are untouched.
  `INSERT OR IGNORE INTO tracks (track_id, track_uri, name, artists, album, explicit)
   SELECT track_id, track_uri, name, artists, album, explicit FROM import_plays
   WHERE import_id = ?3 AND played_at_ms >= ?1 AND played_at_ms < ?2 AND ${GUARD} GROUP BY track_id`,
  `INSERT INTO plays (played_at_ms, track_id, track_uri, source, ${FIELDS.join(", ")})
   SELECT played_at_ms, track_id, track_uri, 'history_import', ${FIELDS.join(", ")} FROM import_plays
   WHERE import_id = ?3 AND played_at_ms >= ?1 AND played_at_ms < ?2 AND ${GUARD}
   ON CONFLICT (played_at_ms, track_id) DO UPDATE SET ${FIELDS.map((f) => `${f} = excluded.${f}`).join(", ")} WHERE plays.ms_played IS NULL`,
  `DELETE FROM plays WHERE played_at_ms >= ?1 AND played_at_ms < ?2 AND ${GUARD}
   AND NOT EXISTS (SELECT 1 FROM import_plays i WHERE i.import_id = ?3 AND i.played_at_ms = plays.played_at_ms AND i.track_id = plays.track_id)`,
  `DELETE FROM import_plays WHERE import_id = ?3 AND played_at_ms >= ?1 AND played_at_ms < ?2 AND ${GUARD}`,
  `UPDATE imports SET applied_to = ?2, progress = ?4, updated_at = ?5 WHERE id = ?3 AND status = 'applying' AND COALESCE(applied_to, 0) < ?2`,
];

export interface ApplyResult {
  /** Already applied (a replayed step): nothing changed. */
  skipped: boolean;
  /** Plays inserted or given the export fields. */
  written: number;
  deleted: number;
}

/**
 * The `apply` step for one month: tracks, plays upsert, deletes, staging cleanup and the
 * `applied_to` marker in one atomic batch. Months must be applied in order.
 */
export async function applySlice(db: D1Database, importId: string, slice: Span, progress: string, now = Date.now()): Promise<ApplyResult> {
  // D1 wants exactly as many bindings as the highest ?N: the marker update alone uses ?4 and ?5.
  const results = await db.batch(
    APPLY_SQL.map((sql, i) => (i === APPLY_SQL.length - 1 ? db.prepare(sql).bind(slice.from, slice.to, importId, progress, now) : db.prepare(sql).bind(slice.from, slice.to, importId))),
  );
  const changes = (i: number) => results[i]?.meta.changes ?? 0;
  if (!changes(4)) return { skipped: true, written: 0, deleted: 0 };
  return { skipped: false, written: changes(1), deleted: changes(2) };
}

export const STAGING_INCOMPLETE =
  "Part of your export went missing between the review and the import, so nothing was changed. Discard this import and upload the export again.";

/**
 * Before the first month is applied: this import's staging rows must be exactly the plays the
 * review counted (Preview.plays). The apply deletes every play in a month that has no staged twin,
 * so applying incomplete staging would delete history. Later months (a retry after some were
 * applied) have already consumed their rows, so the check runs only while nothing is applied.
 */
export async function checkStaged(db: D1Database, importId: string): Promise<void> {
  const row = await db
    .prepare("SELECT applied_to, json_extract(preview, '$.plays') AS expected, (SELECT COUNT(*) FROM import_plays WHERE import_id = ?1) AS staged FROM imports WHERE id = ?1")
    .bind(importId)
    .first<{ applied_to: number | null; expected: number | null; staged: number }>();
  if (!row) throw new ImportError("This import was cancelled.");
  if (row.applied_to !== null) return;
  if (row.expected === null || row.staged !== row.expected) throw new ImportError(STAGING_INCOMPLETE);
}
