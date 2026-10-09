// Write-mode gating (PLAN.md 3.2), checked against every parity scenario:
// shadow = live DB state with zero Spotify writes; dry_run = no Spotify writes and
// no D1 state writes (playlist_tracks, state, playlists, playlist_removals,
// playlist_exclusions). Metadata tables match live in both.
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { WriteMode } from "../../src/env";
import { migrate } from "../../src/db/schema";
import { SpotifyClient } from "../../src/spotify/client";
import { FAMILIES, KNOWN_DIVERGENCES, dumpTables, mockSpotify, resetDb, runJob, scenarioConfig, seedDb, type Call } from "../parity/spotify-fixture";

type Json = any;
const WRITE_OPS = new Set(["liked_add", "playlist_add", "create_playlist", "unfollow"]);
const isWrite = (c: Call) => WRITE_OPS.has(c.op);
const METADATA = ["tracks", "plays", "track_artists", "artists"];
const STATE = ["playlist_tracks", "state", "playlists", "playlist_removals", "playlist_exclusions"];

let restore: (() => void) | undefined;
beforeAll(() => migrate(env.DB));
afterEach(() => restore?.());

async function runScenario(sc: Json, queries: Record<string, string>, mode: WriteMode) {
  await resetDb(env.DB);
  await seedDb(env.DB, sc.seed, Date.now());
  const before = await dumpTables(env.DB, queries);
  const mock = mockSpotify(sc.spotify);
  restore = mock.restore;
  for (let i = 0; i < sc.runs; i++) {
    await runJob(sc, scenarioConfig(sc.config, mode), env.DB, new SpotifyClient("id", "secret", env.DB, mode));
  }
  const actions = (await env.DB.prepare("SELECT executed FROM worker_actions").all<Json>()).results;
  return { before, after: await dumpTables(env.DB, queries), calls: mock.calls, actions };
}

/** Shadow registers placeholder ids for playlists it would create; map them to the ids live mode got. */
function mapPlaceholders(tables: Record<string, Json[]>, golden: Record<string, Json[]>): Record<string, Json[]> {
  const liveIdByArtist = new Map(golden.playlists!.map((p: Json) => [p.artist_name, p.playlist_id]));
  const ids = new Map<string, string>();
  for (const p of tables.playlists ?? []) {
    if (String(p.playlist_id).startsWith("would-create:")) ids.set(p.playlist_id, liveIdByArtist.get(p.artist_name));
  }
  const fix = (rows: Json[]) =>
    rows.map((r) => (ids.has(r.playlist_id) ? { ...r, playlist_id: ids.get(r.playlist_id) } : r));
  const out: Record<string, Json[]> = {};
  for (const [t, rows] of Object.entries(tables)) out[t] = fix(rows);
  out.playlists!.sort((a, b) => (a.playlist_id < b.playlist_id ? -1 : 1));
  out.playlist_tracks!.sort((a, b) => (a.playlist_id + a.track_id < b.playlist_id + b.track_id ? -1 : 1));
  return out;
}

for (const { family, fixtures, golden } of FAMILIES) {
  const scenarios = (fixtures.scenarios as Json[]).filter((s) => !KNOWN_DIVERGENCES[s.name]);

  describe(`${family}: shadow mode`, () => {
    for (const sc of scenarios) {
      it(`${sc.name}: live DB state, no Spotify writes`, async () => {
        const expected = golden[sc.name];
        const { after, calls, actions } = await runScenario(sc, fixtures.dump_queries, "shadow");
        expect(calls.filter(isWrite)).toEqual([]);
        expect(calls).toEqual(expected.calls.filter((c: Call) => !isWrite(c)));
        expect(mapPlaceholders(after, expected.tables)).toEqual(expected.tables);
        expect(actions.every((a: Json) => a.executed === 0)).toBe(true);
        expect(actions).toHaveLength(expected.calls.filter(isWrite).length);
      });
    }
  });

  describe(`${family}: dry_run mode`, () => {
    for (const sc of scenarios) {
      it(`${sc.name}: no Spotify writes, no state writes`, async () => {
        const expected = golden[sc.name];
        const { before, after, calls, actions } = await runScenario(sc, fixtures.dump_queries, "dry_run");
        expect(calls.filter(isWrite)).toEqual([]);
        for (const t of STATE) expect(after[t], t).toEqual(before[t]);
        for (const t of METADATA) expect(after[t], t).toEqual(expected.tables[t]);
        expect(actions.every((a: Json) => a.executed === 0)).toBe(true);
      });
    }
  });
}

describe("live mode", () => {
  it("records executed Spotify writes in worker_actions", async () => {
    const { fixtures } = FAMILIES.find((f) => f.family === "sync")!;
    const sc = (fixtures.scenarios as Json[]).find((s) => s.name === "basic");
    const { calls, actions } = await runScenario(sc, fixtures.dump_queries, "live");
    const writes = calls.filter(isWrite);
    expect(writes.length).toBeGreaterThan(0);
    expect(actions).toHaveLength(writes.length);
    expect(actions.every((a: Json) => a.executed === 1)).toBe(true);
  });
});
