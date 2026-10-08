import type { Env } from "./env";
import { loadConfig, type Config } from "./config";
import { countingD1 } from "./db/counting";
import { migrate } from "./db/schema";
import { runArtistPlaylists } from "./jobs/artist-playlists";
import { runHindiFavorites } from "./jobs/hindi-favorites";
import { runSync, runSyncFull } from "./jobs/sync";
import { SpotifyClient } from "./spotify/client";

/** Runs one job with migrations applied and logs its D1 query count (limit: 1,000 per invocation). */
async function withJob<T>(env: Env, job: string, fn: (config: Config, db: D1Database, sp: SpotifyClient) => Promise<T>): Promise<T> {
  const { db, queries } = countingD1(env.DB);
  try {
    await migrate(db);
    const config = loadConfig(env);
    const sp = new SpotifyClient(env.SPOTIFY_CLIENT_ID, env.SPOTIFY_CLIENT_SECRET, db, config.writeMode);
    return await fn(config, db, sp);
  } finally {
    console.log(JSON.stringify({ job, d1Queries: queries() }));
  }
}

export default {
  async scheduled(event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    switch (event.cron) {
      case "*/10 * * * *":
      case "* * * * *": // TEMP: cutover debugging, remove
        await withJob(env, "sync", runSync);
        break;
      case "0 3 * * *":
      case "10 3 * * *": // shadow-run offset (Amendment A2)
        await withJob(env, "artist-playlists", runArtistPlaylists);
        break;
      case "0 4 * * *":
      case "10 4 * * *": // shadow-run offset (Amendment A2)
        await withJob(env, "hindi-favorites", runHindiFavorites);
        break;
      default:
        console.error(`Unknown cron: ${event.cron}`);
    }
  },

  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/sync-full" || request.method !== "POST") {
      return new Response("Not Found", { status: 404 });
    }

    const auth = request.headers.get("Authorization") ?? "";
    const provided = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!env.SYNC_FULL_SECRET || !provided || !(await constantTimeEqual(provided, env.SYNC_FULL_SECRET))) {
      return new Response("Unauthorized", { status: 401 });
    }

    const result = await withJob(env, "sync-full", async (config, db, sp) => ({
      writeMode: config.writeMode,
      ...(await runSyncFull(config, db, sp)),
    }));
    return Response.json(result);
  },
};

// Compares SHA-256 digests so timing depends on neither input's content nor length (Amendment A3).
async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [dA, dB] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const vA = new Uint8Array(dA);
  const vB = new Uint8Array(dB);
  let diff = 0;
  for (let i = 0; i < vA.length; i++) diff |= vA[i]! ^ vB[i]!;
  return diff === 0;
}
