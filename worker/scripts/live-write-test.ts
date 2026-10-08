/**
 * Phase 5 live write test: drives the Worker's SpotifyClient in live mode against the
 * real account, touching only a throwaway playlist named "worker-migration-test".
 * Creates it, adds one recently played track, verifies, then unfollows (deletes) it.
 *
 * Usage (from worker/):  npx tsx scripts/live-write-test.ts
 * Reads SPOTIFY_CLIENT_ID/SECRET from ../.env and the refresh token from
 * ../data/.spotify_token_cache.json (the `poetry run token fetch` cache).
 */
import { readFileSync } from "node:fs";
import { SpotifyClient } from "../src/spotify/client";
import { fetchPlaylistTracks } from "../src/spotify/playlist";

const env = Object.fromEntries(
  readFileSync("../.env", "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trimStart().startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
    }),
);
const initialToken: string = JSON.parse(readFileSync("../data/.spotify_token_cache.json", "utf8")).refresh_token;

// Minimal stand-in for the D1 `state` table: SpotifyClient only reads/writes the refresh token.
let token = initialToken;
const stateDb = {
  prepare: () => ({
    bind: (...args: unknown[]) => ({
      first: async () => ({ value: token }),
      run: async () => {
        token = String(args[1]);
        return {};
      },
    }),
  }),
} as unknown as D1Database;

function check(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`FAILED: ${msg}`);
  console.log(`  ok  ${msg}`);
}

async function main() {
  const sp = new SpotifyClient(env.SPOTIFY_CLIENT_ID!, env.SPOTIFY_CLIENT_SECRET!, stateDb, "live");
  let playlistId: string | null = null;
  try {
    const recent = await sp.getRecentlyPlayed({ limit: 1 });
    const uri = recent.items?.[0]?.track?.uri;
    check(uri, `picked a recently played track (${uri})`);

    playlistId = (await sp.createPlaylist({ name: "worker-migration-test", public: false, description: "Temp test, safe to delete" })).id;
    check(playlistId && !playlistId.startsWith("would-create:"), `created playlist ${playlistId}`);

    await sp.addToPlaylist(playlistId, [uri!]);
    const total = (await sp.getPlaylist(playlistId, "tracks.total")).tracks?.total;
    check(total === 1, `playlist total is 1 (got ${total})`);
    const items = await fetchPlaylistTracks(sp, playlistId);
    check(items.length === 1 && items[0]!.uri === uri, "playlist contains exactly the added track");
  } finally {
    if (playlistId && !playlistId.startsWith("would-create:")) {
      await sp.unfollowPlaylist(playlistId);
      console.log(`  ok  unfollowed (deleted) ${playlistId}`);
    }
  }

  const actions = sp.drainActions();
  check(
    actions.map((a) => `${a.action}:${a.executed}`).join(",") === "createPlaylist:true,addToPlaylist:true,unfollowPlaylist:true",
    "client recorded 3 executed writes",
  );
  if (token !== initialToken) {
    console.log("WARNING: Spotify rotated the refresh token during this run; re-seed D1 before the next Worker run.");
  }
  console.log("Live write test passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
