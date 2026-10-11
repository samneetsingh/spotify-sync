// Cron dispatch: maps each cron string in wrangler.toml's [triggers] to its jobs. Change both together.
//
// Before any job (tasks/dashboard-plan.md 2.5): migrations and the one-time legacy import, then one
// gate query. Without an owner the 10-minute cron emails the setup link (ensureClaimEmail); without a
// Spotify login nothing else runs (no "sync failed" alerts on a fresh instance). The two are
// independent: an instance connected with `npm run token` keeps syncing while its setup email is out.
// Each job then runs only with its setting on (DISABLED otherwise; see the wrappers below), and the
// daily cron ends with housekeeping.

import { ensureClaimEmail } from "./auth";
import { CLAIM_KEY } from "./auth/claim";
import { OWNER_KEY } from "./auth/owner";
import type { Env } from "./env";
import { runArtistPlaylists } from "./jobs/artist-playlists";
import { runMonthlyRecap, runWeeklyDigest } from "./jobs/digest";
import { runHindiFavorites } from "./jobs/hindi-favorites";
import { runHistoryPlaylists } from "./jobs/history-playlists";
import { runHolidayPlaylist } from "./jobs/holiday-playlist";
import { runSync } from "./jobs/sync";
import { DISABLED, editorConfig, emailConfig, importLegacyOnce, migrateOnce, quietly, withJob, type Job } from "./runtime";

export const SYNC_CRON = "*/10 * * * *";
/** Daily at 08:05 UTC (00:05 PST / 01:05 PDT, just after US Pacific midnight): history, holiday, digests. */
export const DAILY_CRON = "5 8 * * *";

const DAY_MS = 86_400_000;
/** The activity log keeps 90 days. */
export const ACTIVITY_DAYS = 90;
const REFRESH_TOKEN_KEY = "spotify_refresh_token";

/** The jobs for one cron, each switched by its setting; null for an unknown cron. */
function jobsFor(cron: string, env: Env): Array<[string, Job]> | null {
  switch (cron) {
    case SYNC_CRON:
      return [["sync", runSync]]; // Liked Songs and Frequent Plays are switched inside
    case "0 3 * * *":
    case "10 3 * * *": // legacy offset schedule from the side-by-side run with the Python service
      return [["artist-playlists", (c, db, sp) => (c.features.artistPlaylists ? runArtistPlaylists(c, db, sp) : Promise.resolve(DISABLED))]];
    case "0 4 * * *":
    case "10 4 * * *": // legacy offset schedule from the side-by-side run with the Python service
      // Switched inside: it also checks that Frequent Plays still exists, whatever its own setting.
      return [["hindi-favorites", runHindiFavorites]];
    case DAILY_CRON:
      // Separate jobs: each alerts on its own, and one failing doesn't skip the others.
      return [
        ["history-playlists", (c, db, sp) => (c.features.onThisDay || c.features.forgottenFavorites ? runHistoryPlaylists(c, db, sp) : Promise.resolve(DISABLED))],
        ["holiday-playlist", (c, db, sp) => (c.features.holiday ? runHolidayPlaylist(c, db, sp) : Promise.resolve(DISABLED))],
        [
          "weekly-digest",
          (c, db, sp) => (c.digests.weekly ? runWeeklyDigest(c, db, sp, emailConfig(env, c), Date.now(), editorConfig(env, c.digests)) : Promise.resolve(DISABLED)),
        ],
        [
          "monthly-recap",
          (c, db, sp) => (c.digests.monthly ? runMonthlyRecap(c, db, sp, emailConfig(env, c), Date.now(), editorConfig(env, c.digests)) : Promise.resolve(DISABLED)),
        ],
      ];
    default:
      return null;
  }
}

/** Runs the jobs for one cron event; throws (after running every job) if any of them failed. */
export async function runScheduled(cron: string, env: Env, _ctx: ExecutionContext, now = Date.now()): Promise<void> {
  const jobs = jobsFor(cron, env);
  if (!jobs) {
    console.error(`Unknown cron: ${cron}`);
    return;
  }
  await migrateOnce(env.DB);
  await importLegacyOnce(env); // first: it may pin the owner
  const { results } = await env.DB.prepare("SELECT key FROM state WHERE key IN (?1, ?2)").bind(OWNER_KEY, REFRESH_TOKEN_KEY).all<{ key: string }>();
  const keys = new Set(results.map((r) => r.key));

  if (cron === SYNC_CRON && !keys.has(OWNER_KEY)) {
    // ensureClaimEmail answers "owned" when SPOTIFY_USER_ID pins the owner.
    await quietly("claim email", async () => console.log(JSON.stringify({ claimEmail: await ensureClaimEmail(env, env.DB, now) })));
  }
  if (!keys.has(REFRESH_TOKEN_KEY)) {
    console.log(JSON.stringify({ cron, skipped: "not connected to Spotify yet; skipping jobs" }));
    return;
  }

  let failure: unknown;
  for (const [job, fn] of jobs) {
    try {
      await withJob(env, job, fn);
    } catch (err) {
      failure ??= err;
    }
  }
  if (cron === DAILY_CRON) await quietly("housekeeping", () => housekeeping(env.DB, now));
  if (failure) throw failure;
}

/** Daily: prunes the activity log, expired sessions and a setup link left over once there's an owner. */
export async function housekeeping(db: D1Database, now = Date.now()): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM activity WHERE at < ?1").bind(now - ACTIVITY_DAYS * DAY_MS),
    db.prepare("DELETE FROM sessions WHERE expires_at <= ?1").bind(now),
    db.prepare("DELETE FROM state WHERE key = ?1 AND EXISTS (SELECT 1 FROM state WHERE key = ?2)").bind(CLAIM_KEY, OWNER_KEY),
  ]);
}
