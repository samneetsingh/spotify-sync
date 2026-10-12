// The live state the settings page shows about the instance, read in one db.batch (plus the
// settings and session reads the router already does). Never reads the refresh token's value, only whether it exists.

import { callsKey, MODE_KEY } from "../editor";
import { PLACEHOLDER_PREFIX, playlistStateKey } from "../jobs/owned-playlists";

const DAY_MS = 86_400_000;
const FAILING_PREFIX = "alert_failing:";
const TOKEN_KEY = "spotify_refresh_token";

/** Playlists the Worker creates and owns (ids in `state` playlist:<key>; "off" = deleted in Spotify). */
export const OWNED_PLAYLISTS = [
  { key: "frequent", name: "Frequent Plays" },
  { key: "hindi", name: "Hindi Favorites" },
  { key: "on_this_day", name: "On This Day" },
  { key: "forgotten_favorites", name: "Forgotten Favorites" },
  { key: "holiday", name: "Holiday Favorites" },
] as const;
export type OwnedPlaylistKey = (typeof OWNED_PLAYLISTS)[number]["key"];
export const isOwnedPlaylistKey = (key: string): key is OwnedPlaylistKey => OWNED_PLAYLISTS.some((p) => p.key === key);

export interface SyncRun {
  id: number;
  /** Epoch ms. */
  startedAt: number;
  finishedAt: number | null;
  status: string | null;
  playsFetched: number | null;
  tracksAdded: number | null;
  error: string | null;
}

export interface FailingJob {
  job: string;
  since: number;
  failures: number;
  /** The latest error (WP-A adds it to the alert state); null for states written before that. */
  lastError: string | null;
}

export interface DashboardStatus {
  now: number;
  /** A Spotify refresh token is stored. */
  connected: boolean;
  lastRun: SyncRun | null;
  lastSuccess: SyncRun | null;
  totalPlays: number;
  playsLast7Days: number;
  failing: FailingJob[];
  /** recap:last_week / recap:last_month: the last period each digest went out for. */
  lastDigest: { week: string | null; month: string | null };
  /** AI editor calls this UTC month (editor:calls:<YYYY-MM>) and the editor:mode kill switch. */
  aiCalls: number;
  aiPaused: boolean;
  /** state playlist:<key> for the owned playlists (null = not created yet, "off" = deleted in Spotify). */
  playlistState: Record<OwnedPlaylistKey, string | null>;
  artistPlaylists: Array<{ id: string; name: string }>;
}

/** SQLite datetime('now') text ("2026-10-11 15:20:00", UTC) to epoch ms. */
export const sqlTime = (s: string | null): number | null => {
  if (!s) return null;
  const ms = Date.parse(`${s.replace(" ", "T")}Z`);
  return Number.isFinite(ms) ? ms : null;
};

interface SyncRunRow {
  id: number;
  started_at: string;
  finished_at: string | null;
  status: string | null;
  plays_fetched: number | null;
  tracks_added: number | null;
  error: string | null;
}

export const syncRun = (r: SyncRunRow): SyncRun => ({
  id: r.id,
  startedAt: sqlTime(r.started_at) ?? 0,
  finishedAt: sqlTime(r.finished_at),
  status: r.status,
  playsFetched: r.plays_fetched,
  tracksAdded: r.tracks_added,
  error: r.error,
});

export const SYNC_RUN_COLUMNS = "id, started_at, finished_at, status, plays_fetched, tracks_added, error";

/** One alert_failing:<job> value; tolerant of older or partial JSON. */
export function parseFailing(job: string, raw: string): FailingJob {
  let v: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object") v = parsed as Record<string, unknown>;
  } catch {
    // keep the defaults
  }
  return {
    job,
    since: typeof v.since === "number" ? v.since : 0,
    failures: typeof v.failures === "number" ? v.failures : 1,
    lastError: typeof v.lastError === "string" && v.lastError ? v.lastError : null,
  };
}

export async function loadStatus(db: D1Database, now = Date.now()): Promise<DashboardStatus> {
  const aiKey = callsKey(now);
  const keys = [TOKEN_KEY, "recap:last_week", "recap:last_month", MODE_KEY, aiKey, ...OWNED_PLAYLISTS.map((p) => playlistStateKey(p.key))];
  const placeholders = keys.map((_, i) => `?${i + 1}`).join(", ");
  const [state, lastRun, lastSuccess, total, week, artists] = await db.batch([
    // The token's value never leaves D1. ';' sorts right after ':', so the range is the alert_failing: prefix.
    db
      .prepare(
        `SELECT key, CASE WHEN key = '${TOKEN_KEY}' THEN '' ELSE value END AS value FROM state
         WHERE key IN (${placeholders}) OR (key >= '${FAILING_PREFIX}' AND key < 'alert_failing;')`,
      )
      .bind(...keys),
    db.prepare(`SELECT ${SYNC_RUN_COLUMNS} FROM sync_runs ORDER BY id DESC LIMIT 1`),
    db.prepare(`SELECT ${SYNC_RUN_COLUMNS} FROM sync_runs WHERE status = 'success' ORDER BY id DESC LIMIT 1`),
    db.prepare("SELECT COUNT(*) AS n FROM plays"),
    db.prepare("SELECT COUNT(*) AS n FROM plays WHERE played_at_ms >= ?1").bind(now - 7 * DAY_MS),
    db.prepare(
      `SELECT playlist_id AS id, name FROM playlists WHERE playlist_type = 'artist' AND playlist_id NOT LIKE '${PLACEHOLDER_PREFIX}%'
       ORDER BY name COLLATE NOCASE`,
    ),
  ]);

  const values = new Map((state!.results as Array<{ key: string; value: string }>).map((r) => [r.key, r.value]));
  const count = (r: D1Result | undefined) => Number((r?.results[0] as { n?: number } | undefined)?.n ?? 0);
  const run = (r: D1Result | undefined) => {
    const row = r?.results[0] as SyncRunRow | undefined;
    return row ? syncRun(row) : null;
  };
  const failing = [...values]
    .filter(([k]) => k.startsWith(FAILING_PREFIX))
    .map(([k, v]) => parseFailing(k.slice(FAILING_PREFIX.length), v))
    .sort((a, b) => a.since - b.since);

  return {
    now,
    connected: values.has(TOKEN_KEY),
    lastRun: run(lastRun),
    lastSuccess: run(lastSuccess),
    totalPlays: count(total),
    playsLast7Days: count(week),
    failing,
    lastDigest: { week: values.get("recap:last_week") ?? null, month: values.get("recap:last_month") ?? null },
    aiCalls: Number(values.get(aiKey)) || 0,
    aiPaused: values.get(MODE_KEY) === "off",
    playlistState: Object.fromEntries(OWNED_PLAYLISTS.map((p) => [p.key, values.get(playlistStateKey(p.key)) ?? null])) as Record<OwnedPlaylistKey, string | null>,
    artistPlaylists: artists!.results as Array<{ id: string; name: string }>,
  };
}
