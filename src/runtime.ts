// What every job run needs around it: migrations, the email configs, alerting and D1 query counting.
// Used by the cron dispatcher (src/schedule.ts) and by dashboard actions that run a job inline.

import { checkSyncGap, recordFailure, recordSuccess, type AlertConfig } from "./alerts";
import type { Env } from "./env";
import { loadConfig, type Config } from "./config";
import { countingD1 } from "./db/counting";
import { migrate } from "./db/schema";
import type { EditorConfig } from "./editor/types";
import { SpotifyClient } from "./spotify/client";

/** A job: everything in src/jobs takes (config, db, spotifyClient). */
export type Job<T = unknown> = (config: Config, db: D1Database, sp: SpotifyClient) => Promise<T>;

/** Alert bookkeeping must never fail the job itself. */
export async function quietly(what: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    console.error(JSON.stringify({ alertError: what, error: err instanceof Error ? err.message : String(err) }));
  }
}

/**
 * Every email except alerts: digests, account (claim, welcome), previews and imports. Never gated
 * by the `alerts` setting, so turning alerts off can't silence them.
 */
export const emailConfig = (env: Env): AlertConfig => ({
  binding: env.ALERT_EMAIL,
  from: env.ALERT_FROM,
  to: env.ALERT_EMAIL_TO,
  timeZone: env.TIME_ZONE || "UTC",
  publicUrl: env.PUBLIC_URL || undefined,
});

/** Failure, recovery and sync-gap emails: the same binding and addresses as emailConfig. */
export const alertConfig = (env: Env): AlertConfig => emailConfig(env);

/** The digests' AI editor runs only with AI_EDITOR = "on" and an OPENAI_API_KEY secret. */
export const editorConfig = (env: Env): EditorConfig => ({ enabled: env.AI_EDITOR === "on", apiKey: env.OPENAI_API_KEY || null });

/**
 * Runs one job with migrations applied, emails on failure/recovery, and logs its
 * D1 query count (limit: 1,000 per invocation).
 */
export async function withJob<T>(env: Env, job: string, fn: Job<T>): Promise<T> {
  const { db, queries } = countingD1(env.DB);
  const alerts = alertConfig(env);
  try {
    await migrate(db);
    if (job === "sync") await quietly("sync gap check", () => checkSyncGap(db, alerts));
    const config = loadConfig(env);
    const sp = new SpotifyClient(env.SPOTIFY_CLIENT_ID, env.SPOTIFY_CLIENT_SECRET, db, config.writeMode);
    const result = await fn(config, db, sp);
    await quietly("record success", () => recordSuccess(db, alerts, job));
    return result;
  } catch (err) {
    await quietly("record failure", () => recordFailure(db, alerts, job, err));
    throw err;
  } finally {
    console.log(JSON.stringify({ job, d1Queries: queries() }));
  }
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
