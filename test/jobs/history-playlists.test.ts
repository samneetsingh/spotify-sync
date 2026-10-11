import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { loadConfig, type Config } from "../../src/config";
import type { Env, WriteMode } from "../../src/env";
import { getState, setState } from "../../src/db/state";
import { migrate } from "../../src/db/schema";
import { runHistoryPlaylists } from "../../src/jobs/history-playlists";
import { SpotifyClient } from "../../src/spotify/client";
import { mockSpotify, resetDb, type Call } from "../parity/spotify-fixture";

const OCT_11 = Date.UTC(2026, 9, 11, 15); // Sunday 08:00 in Los Angeles, ISO week 2026-W41
const OCT_12 = Date.UTC(2026, 9, 12, 15); // Monday, 2026-W42

let restore: (() => void) | undefined;
beforeAll(() => migrate(env.DB));
beforeEach(() => resetDb(env.DB));
afterEach(() => restore?.());

function config(mode: WriteMode = "live", overrides: Partial<Config["historyPlaylists"]> = {}): Config {
  const cfg = loadConfig({ SPOTIFY_ALL_PLAYLIST_ID: "all1", WRITE_MODE: mode, TIME_ZONE: "America/Los_Angeles" } as Env);
  return { ...cfg, historyPlaylists: { ...cfg.historyPlaylists, forgottenMinPlays: 3, ...overrides } };
}

async function seed(plays: Array<[iso: string, trackId: string]>): Promise<void> {
  const ids = [...new Set(plays.map(([, id]) => id))];
  await env.DB.batch([
    ...ids.map((id) => env.DB.prepare("INSERT INTO tracks(track_id, track_uri) VALUES(?1, 'spotify:track:' || ?1)").bind(id)),
    ...plays.map(([iso, id]) =>
      env.DB.prepare("INSERT INTO plays(played_at_ms, track_id, track_uri, source) VALUES(?1, ?2, 'spotify:track:' || ?2, 'history_import')").bind(Date.parse(iso), id),
    ),
  ]);
}

async function run(cfg: Config, now: number, spotify: object = {}) {
  const mock = mockSpotify(spotify);
  restore = mock.restore;
  const result = await runHistoryPlaylists(cfg, env.DB, new SpotifyClient("id", "secret", env.DB, cfg.writeMode), now);
  return { result, calls: mock.calls };
}

const uris = (...ids: string[]) => ids.map((id) => `spotify:track:${id}`);
const writes = (calls: Call[]) => calls.filter((c) => c.op === "create_playlist" || c.op === "playlist_replace");

const SAMPLE: Array<[string, string]> = [
  ["2018-10-11T20:00:00Z", "a"], // Oct 11 13:00 local
  ["2018-10-11T21:00:00Z", "a"],
  ["2018-10-11T21:30:00Z", "a"],
  ["2018-10-11T22:00:00Z", "b"],
  ["2018-10-12T06:30:00Z", "c"], // still Oct 11 local (23:30)
  ["2018-10-11T03:00:00Z", "x"], // Oct 10 local: not on this day
  ["2022-10-11T18:00:00Z", "b"], // already in from 2018
  ["2022-10-11T19:00:00Z", "d"],
  ["2026-10-11T10:00:00Z", "e"], // this year: not a memory yet
];

it("On This Day takes each past year's top tracks on today's local date, oldest year first", async () => {
  await seed(SAMPLE);
  const { result, calls } = await run(config(), OCT_11);

  expect(result).toEqual({ onThisDay: 4, forgottenFavorites: 1 });
  expect(writes(calls)).toEqual([
    { op: "create_playlist", name: "On This Day", public: false, description: expect.stringContaining("this date") },
    { op: "playlist_replace", playlist_id: "created-1", uris: uris("a", "b", "c", "d") },
    { op: "create_playlist", name: "Forgotten Favorites", public: false, description: expect.stringContaining("3+ times") },
    { op: "playlist_replace", playlist_id: "created-2", uris: uris("a") }, // the only track with 3+ plays, none in a year
  ]);
  expect(await getState(env.DB, "playlist:on_this_day")).toBe("created-1");
  expect(await getState(env.DB, "playlist:on_this_day:period")).toBe("2026-10-11");
  expect(await getState(env.DB, "playlist:forgotten_favorites:period")).toBe("2026-W41");
});

it("gives every year the same quota", async () => {
  await seed(SAMPLE);
  const { calls } = await run(config("live", { onThisDayPerYear: 1 }), OCT_11);
  expect(calls.find((c) => c.op === "playlist_replace")!.uris).toEqual(uris("a", "b"));
});

it("rewrites only when the day or week changes", async () => {
  await seed(SAMPLE);
  await run(config(), OCT_11);

  const again = await run(config(), OCT_11);
  expect(again.result).toEqual({ onThisDay: null, forgottenFavorites: null });
  expect(writes(again.calls)).toEqual([]);

  await seed([["2025-10-12T18:00:00Z", "f"]]);
  const monday = await run(config(), OCT_12, { my_playlists: ["created-1", "created-2"] });
  expect(writes(monday.calls)).toEqual([
    { op: "playlist_replace", playlist_id: "created-1", uris: uris("f") },
    { op: "playlist_replace", playlist_id: "created-2", uris: uris("a") },
  ]);
});

it("samples a different set of forgotten favorites each week, biggest first", async () => {
  // Tracks t0..t9 with 2..11 plays, all in March 2020 (so On This Day stays empty).
  const plays: Array<[string, string]> = [];
  for (let i = 0; i < 10; i++) for (let n = 0; n < i + 2; n++) plays.push([`2020-03-${String(n + 1).padStart(2, "0")}T12:00:00Z`, `t${i}`]);
  await seed(plays);
  const cfg = config("live", { forgottenSize: 3 });

  const week41 = (await run(cfg, OCT_11)).calls.filter((c) => c.op === "playlist_replace")[0]!.uris as string[];
  const week42 = (await run(cfg, OCT_12, { my_playlists: ["created-1"] })).calls.filter((c) => c.op === "playlist_replace")[0]!.uris as string[];
  expect(week41).toHaveLength(3);
  expect(week42).not.toEqual(week41);
  const plays41 = week41.map((u) => Number(u.split(":t")[1]) + 2);
  expect(plays41).toEqual([...plays41].sort((x, y) => y - x));
});

it("leaves a playlist alone when its state is 'off'", async () => {
  await seed(SAMPLE);
  await setState(env.DB, "playlist:on_this_day", "off");
  const { result, calls } = await run(config(), OCT_11);
  expect(result.onThisDay).toBeNull();
  expect(writes(calls).map((c) => c.name ?? c.playlist_id)).toEqual(["Forgotten Favorites", "created-1"]);
});

it("switches a playlist off once it's deleted (unfollowed) in Spotify", async () => {
  await seed(SAMPLE);
  await setState(env.DB, "playlist:on_this_day", "gone");
  const { result, calls } = await run(config(), OCT_11, { my_playlists: ["other"] });
  expect(result.onThisDay).toBeNull();
  expect(await getState(env.DB, "playlist:on_this_day")).toBe("off");
  expect(calls.filter((c) => c.op === "playlist_replace" && c.playlist_id === "gone")).toEqual([]);
});

it("fails the job when Spotify rejects a write, keeping the playlist for the next run", async () => {
  await seed(SAMPLE);
  await setState(env.DB, "playlist:on_this_day", "p1");
  await expect(run(config(), OCT_11, { my_playlists: ["p1"], missing_playlists: ["p1"] })).rejects.toThrow(/404/);
  expect(await getState(env.DB, "playlist:on_this_day")).toBe("p1");
  expect(await getState(env.DB, "playlist:on_this_day:period")).toBeNull();
});

it("dry_run computes the playlists but writes neither Spotify nor state", async () => {
  await seed(SAMPLE);
  const { result, calls } = await run(config("dry_run"), OCT_11);
  expect(result).toEqual({ onThisDay: 4, forgottenFavorites: 1 });
  expect(writes(calls)).toEqual([]);
  const keys = await env.DB.prepare("SELECT key FROM state WHERE key LIKE 'playlist:%'").all();
  expect(keys.results).toEqual([]);
  const actions = await env.DB.prepare("SELECT action, executed FROM worker_actions ORDER BY id").all();
  expect(actions.results).toEqual([
    { action: "createPlaylist", executed: 0 },
    { action: "replacePlaylistItems", executed: 0 },
    { action: "createPlaylist", executed: 0 },
    { action: "replacePlaylistItems", executed: 0 },
  ]);
});
