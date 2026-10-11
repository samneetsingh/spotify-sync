// The dashboard's activity log: what ran, what was sent, account and settings changes, imports.
// Written in every write mode (like sync_runs); callers wrap it in `quietly` where a failed log
// mustn't fail the work. Rows older than 90 days are pruned by the daily housekeeping.

export type ActivityKind = "job" | "email" | "account" | "settings" | "import";

export interface ActivityEvent {
  id: number;
  /** Epoch ms. */
  at: number;
  kind: ActivityKind;
  ok: boolean;
  summary: string;
  detail: string | null;
}

const MAX_SUMMARY = 200;
const MAX_DETAIL = 2_000;

/** Records one event. `summary` is one line for the dashboard; `detail` is optional extra text (e.g. an error). */
export async function logActivity(
  db: D1Database,
  kind: ActivityKind,
  summary: string,
  ok = true,
  detail?: string,
  now = Date.now(),
): Promise<void> {
  await db
    .prepare("INSERT INTO activity (at, kind, ok, summary, detail) VALUES (?1, ?2, ?3, ?4, ?5)")
    .bind(now, kind, ok ? 1 : 0, summary.slice(0, MAX_SUMMARY), detail === undefined ? null : detail.slice(0, MAX_DETAIL))
    .run();
}

/** The newest `limit` events, newest first. */
export async function recentActivity(db: D1Database, limit = 50): Promise<ActivityEvent[]> {
  const { results } = await db
    .prepare("SELECT id, at, kind, ok, summary, detail FROM activity ORDER BY at DESC, id DESC LIMIT ?1")
    .bind(limit)
    .all<Omit<ActivityEvent, "ok"> & { ok: number }>();
  return results.map((r) => ({ ...r, ok: r.ok === 1 }));
}
