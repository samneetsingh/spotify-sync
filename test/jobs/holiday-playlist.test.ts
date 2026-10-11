import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { loadConfig, type Config } from "../../src/config";
import type { Env, WriteMode } from "../../src/env";
import { getState, setState } from "../../src/db/state";
import { migrate } from "../../src/db/schema";
import { runHolidayPlaylist } from "../../src/jobs/holiday-playlist";
import { SpotifyClient } from "../../src/spotify/client";
import { mockSpotify, resetDb, type Call } from "../parity/spotify-fixture";

const OCT_11 = Date.UTC(2026, 9, 11, 15); // in season (Los Angeles)
const JULY_4 = Date.UTC(2026, 6, 4, 15);
const JAN_7 = Date.UTC(2027, 0, 7, 15); // the day after the season

let restore: (() => void) | undefined;
beforeAll(() => migrate(env.DB));
beforeEach(() => resetDb(env.DB));
afterEach(() => restore?.());

const config = (mode: WriteMode = "live"): Config =>
  loadConfig({ SPOTIFY_ALL_PLAYLIST_ID: "all1", WRITE_MODE: mode, TIME_ZONE: "America/Los_Angeles" } as Env);

/** Tracks with a title and a play count (plays spread over December 2020). */
async function seed(tracks: Array<[id: string, name: string, plays: number]>): Promise<void> {
  await env.DB.batch(
    tracks.flatMap(([id, name, plays]) => [
      env.DB.prepare("INSERT INTO tracks(track_id, track_uri, name) VALUES(?1, 'spotify:track:' || ?1, ?2)").bind(id, name),
      ...Array.from({ length: plays }, (_, i) =>
        env.DB.prepare("INSERT INTO plays(played_at_ms, track_id, track_uri, source) VALUES(?1, ?2, 'spotify:track:' || ?2, 'history_import')").bind(Date.UTC(2020, 11, i + 1), id),
      ),
    ]),
  );
}

async function run(cfg: Config, now: number, spotify: object = {}) {
  const mock = mockSpotify({ tracks: {}, playlist_items: {}, ...spotify });
  restore = mock.restore;
  const result = await runHolidayPlaylist(cfg, env.DB, new SpotifyClient("id", "secret", env.DB, cfg.writeMode), now);
  return { result, calls: mock.calls };
}

const writes = (calls: Call[]) => calls.filter((c) => c.op === "create_playlist" || c.op === "playlist_add");
const uris = (...ids: string[]) => ids.map((id) => `spotify:track:${id}`);

const LIBRARY: Array<[string, string, number]> = [
  ["jingle", "Jingle Bell Rock", 5],
  ["last", "Last Christmas", 7],
  ["since", "Since U Been Gone", 9], // not a holiday song
  ["white", "White Christmas", 2], // too few plays
  ["holiday", "Holiday (feat. Snoop Dogg)", 6], // "holiday" alone isn't a holiday song
];

it("creates the playlist and adds holiday songs played 3+ times, most played first", async () => {
  await seed(LIBRARY);
  const { result, calls } = await run(config(), OCT_11);
  expect(result).toEqual({ tracksAdded: 2, tracksConsidered: 2 });
  expect(writes(calls)).toEqual([
    { op: "create_playlist", name: "Holiday Favorites", public: false, description: expect.stringContaining("3+ times") },
    { op: "playlist_add", playlist_id: "created-1", uris: uris("last", "jingle") },
  ]);
  expect(await getState(env.DB, "playlist:holiday")).toBe("created-1");
  const cached = await env.DB.prepare("SELECT track_id FROM playlist_tracks WHERE playlist_id = 'created-1' ORDER BY track_id").all();
  expect(cached.results).toEqual([{ track_id: "jingle" }, { track_id: "last" }]);
});

it("does nothing outside October 1 - January 6", async () => {
  await seed(LIBRARY);
  for (const now of [JULY_4, JAN_7]) {
    const { result, calls } = await run(config(), now);
    expect(result).toBeNull();
    expect(calls).toEqual([]);
  }
});

it("never re-adds a song you removed, and keeps adding new ones", async () => {
  await seed(LIBRARY);
  await setState(env.DB, "playlist:holiday", "h1");
  // Added in an earlier run, since removed by hand on Spotify (the playlist is empty now).
  await env.DB.prepare("INSERT INTO playlist_tracks(playlist_id, track_id, track_uri) VALUES('h1', 'jingle', 'spotify:track:jingle')").run();
  const { result, calls } = await run(config(), OCT_11, { my_playlists: ["h1"], playlist_items: { h1: [] } });
  expect(result).toEqual({ tracksAdded: 1, tracksConsidered: 2 });
  expect(writes(calls)).toEqual([{ op: "playlist_add", playlist_id: "h1", uris: uris("last") }]);
});

it("switches off once the playlist is deleted (unfollowed) in Spotify", async () => {
  await seed(LIBRARY);
  await setState(env.DB, "playlist:holiday", "h1");
  const { result, calls } = await run(config(), OCT_11, { my_playlists: [] });
  expect(result).toBeNull();
  expect(writes(calls)).toEqual([]);
  expect(await getState(env.DB, "playlist:holiday")).toBe("off");
});

it("dry_run reports what it would add without writing Spotify or state", async () => {
  await seed(LIBRARY);
  const { result, calls } = await run(config("dry_run"), OCT_11);
  expect(result).toEqual({ tracksAdded: 2, tracksConsidered: 2 });
  expect(writes(calls)).toEqual([]);
  expect(await getState(env.DB, "playlist:holiday")).toBeNull();
  const cached = await env.DB.prepare("SELECT COUNT(*) AS n FROM playlist_tracks").first();
  expect(cached).toEqual({ n: 0 });
});
