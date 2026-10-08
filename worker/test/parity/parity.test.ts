// Replays the Python-generated scenarios through the Worker jobs (live mode) and
// requires identical results, ordered Spotify calls, and DB rows. Regenerate with:
//   poetry run python worker/test/parity/generate_golden.py
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../src/db/schema";
import { SpotifyClient } from "../../src/spotify/client";
import { FAMILIES, KNOWN_DIVERGENCES, dumpTables, mockSpotify, resetDb, runJob, scenarioConfig, seedDb } from "./spotify-fixture";

type Json = any;
let restore: (() => void) | undefined;
beforeAll(() => migrate(env.DB));
afterEach(() => restore?.());

for (const { family, fixtures, golden } of FAMILIES) {
  describe(`${family} parity with Python (live mode)`, () => {
    for (const sc of fixtures.scenarios as Json[]) {
      if (KNOWN_DIVERGENCES[sc.name]) continue;
      it(sc.name, async () => {
        await resetDb(env.DB);
        await seedDb(env.DB, sc.seed, Date.now());
        const mock = mockSpotify(sc.spotify);
        restore = mock.restore;
        const cfg = scenarioConfig(sc.config);
        const sp = new SpotifyClient("id", "secret", env.DB, "live");

        const results: Json[] = [];
        for (let i = 0; i < sc.runs; i++) results.push(await runJob(sc, cfg, env.DB, sp));

        const expected = golden[sc.name];
        expect(results).toEqual(expected.results);
        expect(mock.calls).toEqual(expected.calls);
        expect(await dumpTables(env.DB, fixtures.dump_queries)).toEqual(expected.tables);
      });
    }
  });
}

describe("intentional divergences from Python", () => {
  it("manual_add_unknown_track: upserts the track instead of failing the run on the FK", async () => {
    const { fixtures, golden } = FAMILIES.find((f) => f.family === "artist")!;
    const sc = (fixtures.scenarios as Json[]).find((s) => s.name === "manual_add_unknown_track");
    expect(golden[sc.name].results).toEqual([{ error: true }]); // Python crashes here

    await resetDb(env.DB);
    await seedDb(env.DB, sc.seed, Date.now());
    restore = mockSpotify(sc.spotify).restore;
    const result = await runJob(sc, scenarioConfig(sc.config), env.DB, new SpotifyClient("id", "secret", env.DB, "live"));

    expect(result).toEqual({ artists_processed: 1, playlists_created: 0, total_tracks_added: 0, pruned: 0 });
    const cached = await env.DB.prepare("SELECT track_id FROM playlist_tracks WHERE playlist_id = 'pl_beta' ORDER BY track_id").all();
    expect(cached.results.map((r: Json) => r.track_id)).toEqual(["b1", "b2", "b3", "never_played"]);
    const track = await env.DB.prepare("SELECT track_uri, name FROM tracks WHERE track_id = 'never_played'").first();
    expect(track).toEqual({ track_uri: "spotify:track:never_played", name: "Track never_played" });
  });
});
