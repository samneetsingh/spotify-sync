// What every job run needs around it: migrations, the one-time import of pre-dashboard deploy vars,
// the owner's settings, the email configs, alerting, the activity log and D1 query counting.
// Used by the cron dispatcher (src/schedule.ts) and by dashboard actions that run a job inline.

import { logActivity } from "./activity";
import { checkSyncGap, FAILING_PREFIX, recordFailure, recordSuccess, type AlertConfig } from "./alerts";
import { OWNER_KEY } from "./auth/owner";
import { DISABLED, isDisabled, loadConfig, type Config, type Disabled } from "./config";
import { countingD1 } from "./db/counting";
import { migrate } from "./db/schema";
import type { EditorConfig } from "./editor/types";
import type { Env } from "./env";
import { HINDI_PLAYLIST } from "./jobs/hindi-favorites";
import { playlistStateKey } from "./jobs/owned-playlists";
import { FREQUENT_PLAYLIST } from "./jobs/sync";
import { displayValue, hasLegacyVars, loadSettings, resolveSettings, SETTING_KEYS, settingDef, withoutLegacyVars, type SettingValues } from "./settings";
import { QUICK_RETRY, SpotifyClient, type RetryPolicy } from "./spotify/client";

export { DISABLED, isDisabled, type Disabled };

/** A job: everything in src/jobs takes (config, db, spotifyClient). Config carries the owner's settings. */
export type Job<T = unknown> = (config: Config, db: D1Database, sp: SpotifyClient) => Promise<T>;

/** Alert bookkeeping must never fail the job itself. */
export async function quietly(what: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    console.error(JSON.stringify({ alertError: what, error: err instanceof Error ? err.message : String(err) }));
  }
}

/** The deploy config and code defaults, without a D1 read (callers without the effective settings). */
const deployLayer = (env: Env): SettingValues => resolveSettings([], env).values;

/**
 * Every email except alerts: digests, account (claim, welcome), previews and imports. Never gated
 * by the `alerts` setting, so turning alerts off can't silence them. Pass the effective settings
 * (`loadSettings(...).values`, or a job's Config) for the owner's time zone.
 */
export const emailConfig = (env: Env, settings: Pick<SettingValues, "timeZone"> = deployLayer(env)): AlertConfig => ({
  binding: env.ALERT_EMAIL,
  from: env.ALERT_FROM,
  to: env.ALERT_EMAIL_TO,
  timeZone: settings.timeZone,
  publicUrl: env.PUBLIC_URL || undefined,
});

/** Failure, recovery and sync-gap emails: emailConfig, without the binding (nothing is sent) when the `alerts` setting is off. */
export const alertConfig = (env: Env, settings: Pick<SettingValues, "alerts" | "timeZone"> = deployLayer(env)): AlertConfig =>
  settings.alerts ? emailConfig(env, settings) : { ...emailConfig(env, settings), binding: undefined };

/** The digests' AI editor: the `aiEditor` setting (`Config.digests` has it too); always off without the OPENAI_API_KEY secret. */
export const editorConfig = (env: Env, settings: Pick<SettingValues, "aiEditor"> = deployLayer(env)): EditorConfig => ({
  enabled: settings.aiEditor && !!env.OPENAI_API_KEY,
  apiKey: env.OPENAI_API_KEY || null,
});

/**
 * Runs one job: migrations, the legacy import, one settings read (D1), then the job with its
 * Config and a Spotify client that retries a 5xx per `retry` (`runScheduled` picks it per cron);
 * emails on failure/recovery (unless the `alerts` setting is off), logs the outcome to the
 * activity log (except the 10-minute sync, which has sync_runs), and logs its D1 query count
 * (limit: 1,000 per invocation). A job that returns DISABLED only has its failure state cleared.
 */
export async function withJob<T>(env: Env, job: string, fn: Job<T>, retry: RetryPolicy = QUICK_RETRY): Promise<T> {
  const { db, queries } = countingD1(env.DB);
  let settings = deployLayer(env); // until D1 answers, so a failure still alerts
  try {
    await migrate(db);
    await importLegacyOnce(env, db);
    settings = (await loadSettings(db, env)).values;
    const alerts = alertConfig(env, settings);
    if (job === "sync") await quietly("sync gap check", () => checkSyncGap(db, alerts));
    const config = loadConfig(env, settings);
    const sp = new SpotifyClient(env.SPOTIFY_CLIENT_ID, env.SPOTIFY_CLIENT_SECRET, db, config.writeMode, retry);
    const result = await fn(config, db, sp);
    if (isDisabled(result)) {
      // Switched off: forget an old failure without a misleading "recovered" email.
      console.log(JSON.stringify({ job, disabled: true }));
      await quietly("clear failure", () => clearFailure(db, job));
    } else {
      await quietly("record success", () => recordSuccess(db, alerts, job));
      const summary = job === "sync" ? null : jobSummary(job, result);
      if (summary) await quietly("activity", () => logActivity(db, "job", summary));
    }
    return result;
  } catch (err) {
    await quietly("record failure", () => recordFailure(db, alertConfig(env, settings), job, err));
    if (job !== "sync") {
      await quietly("activity", () => logActivity(db, "job", `${jobLabel(job)} failed`, false, err instanceof Error ? err.message : String(err)));
    }
    throw err;
  } finally {
    console.log(JSON.stringify({ job, d1Queries: queries() }));
  }
}

async function clearFailure(db: D1Database, job: string): Promise<void> {
  await db.prepare("DELETE FROM state WHERE key = ?1").bind(`${FAILING_PREFIX}${job}`).run();
}

const JOB_LABELS: Record<string, string> = {
  sync: "Sync",
  "artist-playlists": "Artist playlists",
  "hindi-favorites": "Hindi Favorites",
  "history-playlists": "On This Day and Forgotten Favorites",
  "holiday-playlist": "Holiday Favorites",
  "weekly-digest": "Weekly digest",
  "monthly-recap": "Monthly recap",
};

/** The owner-facing name of a job (activity log). */
export const jobLabel = (job: string): string => JOB_LABELS[job] ?? job;

/** One activity line for a finished job; null when it had nothing to do (a null result, or only nulls). */
export function jobSummary(job: string, result: unknown): string | null {
  if (result === null || result === undefined) return null;
  if (typeof result !== "object") return `${jobLabel(job)}: done`;
  const r = result as Record<string, unknown>;
  if (typeof r.sent === "boolean" && typeof r.period === "string") {
    return `${jobLabel(job)} for ${r.period}: ${r.sent ? "sent" : "not sent (not in live mode)"}`;
  }
  const parts = Object.entries(r)
    .filter(([, v]) => typeof v === "number" || typeof v === "string" || typeof v === "boolean")
    .map(([k, v]) => `${k.replace(/[A-Z]/g, (c) => ` ${c.toLowerCase()}`)} ${v}`);
  return parts.length ? `${jobLabel(job)}: ${parts.join(", ")}` : null;
}

const migrated = new WeakSet<D1Database>();

/**
 * `migrate` once per isolate and database binding (the fetch handler: on a fresh database the
 * first page view can come before any cron). Only remembered after it succeeds.
 */
export async function migrateOnce(db: D1Database): Promise<void> {
  if (migrated.has(db)) return;
  await migrate(db);
  migrated.add(db);
}

/** `state` key set once the legacy vars are imported; while it exists they're never read again. */
export const LEGACY_IMPORTED_KEY = "legacy_config:imported";

/**
 * Copies the pre-dashboard deploy vars (LEGACY_VARS in src/settings.ts) into the database, once, so
 * the deploy config can then drop them without changing behaviour.
 * It runs only while a deploy config still renders them, i.e. an existing instance deploying this
 * version with its old config. This isn't a migration because migrate() never sees env.
 * - SPOTIFY_USER_ID -> `state` owner:spotify_id; SPOTIFY_FREQUENT_PLAYLIST_ID and
 *   SPOTIFY_HINDI_FAVORITES_PLAYLIST_ID -> playlist:frequent / playlist:hindi (the owned-playlist
 *   keys). Never over a value already there (a login pins the owner too).
 * - An instance with data (plays or a Spotify login) gets a `settings` row for each setting whose
 *   current value would change without the vars: TIME_ZONE, FREQUENT_MIN_PLAYS, AI_EDITOR, Hindi
 *   Favorites on (its id), Frequent Plays off (an empty or absent id: the old template defaulted it
 *   to "", and Frequent Plays never ran without one). Rows already there win. Fresh instances
 *   start from the defaults. Liked Songs and the sync cursor (SPOTIFY_ALL_PLAYLIST_ID) need no env:
 *   migration v12 handles them.
 * Returns what it copied (for the activity log), or null when there was nothing to do.
 */
export async function importLegacyConfig(db: D1Database, env: Env, now = Date.now()): Promise<string[] | null> {
  if (!hasLegacyVars(env)) return null;
  const [flag, data, rows, frequentRow] = await db.batch([
    db.prepare("SELECT 1 AS done FROM state WHERE key = ?1").bind(LEGACY_IMPORTED_KEY),
    db.prepare("SELECT (EXISTS (SELECT 1 FROM plays) OR EXISTS (SELECT 1 FROM state WHERE key = 'spotify_refresh_token')) AS has_data"),
    db.prepare("SELECT key FROM settings"),
    db.prepare("SELECT 1 AS found FROM state WHERE key = ?1").bind(playlistStateKey(FREQUENT_PLAYLIST.key)),
  ]);
  if (flag!.results.length) return null;
  const hasData = (data!.results[0] as { has_data: number } | undefined)?.has_data === 1;
  const saved = new Set((rows!.results as Array<{ key: string }>).map((r) => r.key));

  const copied: string[] = [];
  const statements: D1PreparedStatement[] = [];
  const ids: Array<[key: string, value: string | undefined, what: string]> = [
    [OWNER_KEY, env.SPOTIFY_USER_ID, "the owner's Spotify account"],
    [playlistStateKey(FREQUENT_PLAYLIST.key), env.SPOTIFY_FREQUENT_PLAYLIST_ID, "the Frequent Plays playlist"],
    [playlistStateKey(HINDI_PLAYLIST.key), env.SPOTIFY_HINDI_FAVORITES_PLAYLIST_ID, "the Hindi Favorites playlist"],
  ];
  for (const [key, value, what] of ids) {
    if (!value?.trim()) continue;
    statements.push(db.prepare("INSERT INTO state (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO NOTHING").bind(key, value.trim()));
    copied.push(what);
  }

  if (hasData) {
    const today = resolveSettings([], env);
    const current: SettingValues = { ...today.values };
    // Frequent Plays only ran with a playlist id; an empty or absent one meant off. Keep it off
    // unless a Frequent Plays playlist is known, so the next sync doesn't create a new one.
    const frequentId = env.SPOTIFY_FREQUENT_PLAYLIST_ID?.trim() ?? "";
    if (today.source.frequent === "default" && !frequentId && !frequentRow!.results.length) current.frequent = false;
    const without = resolveSettings([], withoutLegacyVars(env)).values;
    for (const key of SETTING_KEYS) {
      if (current[key] === without[key] || saved.has(key)) continue;
      statements.push(db.prepare("INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO NOTHING").bind(key, JSON.stringify(current[key])));
      copied.push(`${settingDef(key).label}: ${displayValue(settingDef(key), current[key])}`);
    }
  }
  statements.push(
    db
      .prepare("INSERT INTO state (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')")
      .bind(LEGACY_IMPORTED_KEY, new Date(now).toISOString()),
  );
  await db.batch(statements);

  console.log(JSON.stringify({ legacyConfig: "imported", items: copied.length }));
  if (copied.length) {
    const summary = `Moved the deploy config's settings into the dashboard: ${copied.join("; ")}`;
    await quietly("activity", () => logActivity(db, "settings", summary, true, summary.length > 200 ? summary : undefined, now));
  }
  return copied;
}

const legacyChecked = new WeakSet<D1Database>();

/**
 * importLegacyConfig before any job (cron or dashboard): at most one flag read per isolate and
 * database binding while the legacy vars are set, none once they're gone. Throws if the import
 * fails, so a job never runs half-configured (e.g. creating a second Frequent Plays playlist).
 */
export async function importLegacyOnce(env: Env, db: D1Database = env.DB): Promise<void> {
  if (!hasLegacyVars(env) || legacyChecked.has(env.DB)) return;
  await importLegacyConfig(db, env);
  legacyChecked.add(env.DB);
}
