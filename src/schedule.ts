// Cron dispatch: maps each cron string in wrangler.toml's [triggers] to its jobs. Change both together.
// WP-B adds the pre-claim gate, settings-based dispatch wrappers and housekeeping here.

import type { Env } from "./env";
import { runArtistPlaylists } from "./jobs/artist-playlists";
import { runMonthlyRecap, runWeeklyDigest } from "./jobs/digest";
import { runHindiFavorites } from "./jobs/hindi-favorites";
import { runHistoryPlaylists } from "./jobs/history-playlists";
import { runHolidayPlaylist } from "./jobs/holiday-playlist";
import { runSync } from "./jobs/sync";
import { editorConfig, emailConfig, withJob, type Job } from "./runtime";

/** Runs the jobs for one cron event; throws (after running every job) if any of them failed. */
export async function runScheduled(cron: string, env: Env, _ctx: ExecutionContext): Promise<void> {
  switch (cron) {
    case "*/10 * * * *":
      await withJob(env, "sync", runSync);
      break;
    case "0 3 * * *":
    case "10 3 * * *": // legacy offset schedule from the side-by-side run with the Python service
      await withJob(env, "artist-playlists", runArtistPlaylists);
      break;
    case "0 4 * * *":
    case "10 4 * * *": // legacy offset schedule from the side-by-side run with the Python service
      await withJob(env, "hindi-favorites", runHindiFavorites);
      break;
    case "5 8 * * *": {
      // Daily at 00:05 PST / 01:05 PDT, just after local midnight. Separate jobs: each
      // alerts on its own, and one failing doesn't skip the others.
      const daily: Array<[string, Job]> = [
        ["history-playlists", runHistoryPlaylists],
        ["holiday-playlist", runHolidayPlaylist],
        ["weekly-digest", (cfg, db, sp) => runWeeklyDigest(cfg, db, sp, emailConfig(env), Date.now(), editorConfig(env))],
        ["monthly-recap", (cfg, db, sp) => runMonthlyRecap(cfg, db, sp, emailConfig(env), Date.now(), editorConfig(env))],
      ];
      let failure: unknown;
      for (const [job, fn] of daily) {
        try {
          await withJob(env, job, fn);
        } catch (err) {
          failure ??= err;
        }
      }
      if (failure) throw failure;
      break;
    }
    default:
      console.error(`Unknown cron: ${cron}`);
  }
}
