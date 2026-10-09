/**
 * Smoke test of real Spotify writes: drives the Worker's SpotifyClient in live mode,
 * touching only a throwaway playlist named "worker-migration-test". Creates it, adds one
 * recently played track, verifies, then unfollows (deletes) it.
 *
 * Usage: npm run live-write-test [-- --db spotify-sync]
 * Credentials from .dev.vars; refresh token read from (and rotations saved to) D1.
 */
import { SpotifyClient } from "../src/spotify/client";
import { fetchPlaylistTracks } from "../src/spotify/playlist";
import { DEFAULT_DB, d1Rows, flag, requireVars, seedRefreshToken } from "./lib";

const db = flag("db", DEFAULT_DB);
const env = requireVars("SPOTIFY_CLIENT_ID", "SPOTIFY_CLIENT_SECRET");

// SpotifyClient only touches the D1 state table for the refresh token: read it from D1
// once, and write any rotation straight back.
const initialToken = d1Rows<{ value: string }>(db, "SELECT value FROM state WHERE key = 'spotify_refresh_token'")[0]?.value;
if (!initialToken) throw new Error(`No refresh token in ${db}; run: npm run token`);
let token = initialToken;
const stateDb = {
  prepare: () => ({
    bind: (...args: unknown[]) => ({
      first: async () => ({ value: token }),
      run: async () => {
        token = String(args[1]);
        seedRefreshToken(db, token);
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
  if (token !== initialToken) console.log("Spotify rotated the refresh token during this run; saved the new one to D1.");
  console.log("Live write test passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
