/**
 * Smoke test of real Spotify writes: drives the Worker's SpotifyClient in live mode,
 * touching only a throwaway playlist named "worker-migration-test". Creates it, adds one
 * recently played track, replaces the contents with two tracks (the history playlists'
 * write), verifies each step, then unfollows (deletes) it and checks it left the library
 * (how the history playlists notice a deletion).
 *
 * Usage: npm run live-write-test [-- --db <database name>]
 * Credentials from .dev.vars; refresh token read from (and rotations saved to) D1.
 */
import { SpotifyClient } from "../src/spotify/client";
import { fetchPlaylistTracks, followedPlaylistIds } from "../src/spotify/playlist";
import { d1Rows, requireVars, seedRefreshToken, targetDb } from "./lib";

const db = targetDb();
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
    const recent = await sp.getRecentlyPlayed({ limit: 10 });
    const uris = [...new Set((recent.items ?? []).map((i) => i.track?.uri).filter((u): u is string => !!u))];
    const uri = uris[0];
    check(uri, `picked a recently played track (${uri})`);

    playlistId = (await sp.createPlaylist({ name: "worker-migration-test", public: false, description: "Temp test, safe to delete" })).id;
    check(playlistId && !playlistId.startsWith("would-create:"), `created playlist ${playlistId}`);
    check((await followedPlaylistIds(sp)).has(playlistId), "new playlist is listed in /me/playlists");

    await sp.addToPlaylist(playlistId, [uri!]);
    const total = (await sp.getPlaylist(playlistId, "tracks.total")).tracks?.total;
    check(total === 1, `playlist total is 1 (got ${total})`);
    const items = await fetchPlaylistTracks(sp, playlistId);
    check(items.length === 1 && items[0]!.uri === uri, "playlist contains exactly the added track");

    const replacement = [uris[1] ?? uri!, uri!];
    await sp.replacePlaylistItems(playlistId, replacement);
    const replaced = (await fetchPlaylistTracks(sp, playlistId)).map((t) => t.uri);
    check(replaced.join() === replacement.join(), "replace left exactly the new tracks, in order");

    const deleted = playlistId;
    await sp.unfollowPlaylist(deleted);
    playlistId = null;
    console.log(`  ok  unfollowed (deleted) ${deleted}`);
    check(!(await followedPlaylistIds(sp)).has(deleted), "after unfollowing it is gone from /me/playlists");
  } finally {
    if (playlistId && !playlistId.startsWith("would-create:")) {
      await sp.unfollowPlaylist(playlistId);
      console.log(`  ok  unfollowed (deleted) ${playlistId}`);
    }
  }

  const actions = sp.drainActions();
  check(
    actions.map((a) => `${a.action}:${a.executed}`).join(",") === "createPlaylist:true,addToPlaylist:true,replacePlaylistItems:true,unfollowPlaylist:true",
    "client recorded 4 executed writes",
  );
  if (token !== initialToken) console.log("Spotify rotated the refresh token during this run; saved the new one to D1.");
  console.log("Live write test passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
