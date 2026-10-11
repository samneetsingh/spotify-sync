// The reconcile diff, shared by `npm run import-history` (in memory) and the dashboard import (whose
// SQL preview and month-by-month apply must agree with it; test/import/reconcile.test.ts checks).
//
// The export is the source of truth for plays inside its span: afterwards the plays there equal
// the export's streams of at least MIN_MS_PLAYED. Missing plays are inserted, existing plays that
// lack the export's per-play fields get them, and anything else in the span is deleted (shorter
// streams, and API plays, whose timestamps never match the export's exactly).

import { playKey, type ExportPlay } from "./parse";

/** [inserts, updates (export fields added), deletes]. */
export type DiffCounts = [number, number, number];

export interface ReconcilePlan {
  toInsert: ExportPlay[];
  toUpdate: ExportPlay[];
  toDelete: Array<[playedAtMs: number, trackId: string]>;
  /** Counts per UTC year, ascending. */
  byYear: Array<[year: number, counts: DiffCounts]>;
}

export const utcYear = (ms: number): number => new Date(ms).getUTCFullYear();

/**
 * @param plays the export's plays (ExportCollector.plays), keyed by playKey
 * @param current the database's plays inside the span, keyed by playKey, mapped to whether they
 *   already carry the export fields (ms_played IS NOT NULL)
 */
export function planReconcile(plays: ReadonlyMap<string, ExportPlay>, current: ReadonlyMap<string, boolean>): ReconcilePlan {
  const toInsert = [...plays].filter(([k]) => !current.has(k)).map(([, p]) => p);
  const toUpdate = [...plays].filter(([k]) => current.get(k) === false).map(([, p]) => p);
  const toDelete = [...current.keys()].filter((k) => !plays.has(k)).map((k): [number, string] => {
    const at = k.indexOf(":");
    return [Number(k.slice(0, at)), k.slice(at + 1)];
  });
  const years = new Map<number, DiffCounts>();
  const tally = (ms: number, i: 0 | 1 | 2) => {
    const counts = years.get(utcYear(ms)) ?? [0, 0, 0];
    counts[i]++;
    years.set(utcYear(ms), counts);
  };
  for (const p of toInsert) tally(p.played_at_ms, 0);
  for (const p of toUpdate) tally(p.played_at_ms, 1);
  for (const [ms] of toDelete) tally(ms, 2);
  return { toInsert, toUpdate, toDelete, byYear: [...years].sort(([a], [b]) => a - b) };
}

export { playKey };
