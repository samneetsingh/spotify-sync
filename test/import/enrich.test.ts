// Enrichment after an import (src/import/enrich.ts): cursor steps that end even when Spotify
// returns null for removed tracks.
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { migrate } from "../../src/db/schema";
import { enrichArtists, enrichTracks } from "../../src/import/enrich";
import { SpotifyClient } from "../../src/spotify/client";
import { resetDb } from "../parity/spotify-fixture";
import { mockSpotifyApi, type SpotifyMock } from "./helpers";

const db = env.DB;
let mock: SpotifyMock | undefined;
beforeAll(() => migrate(db));
beforeEach(() => resetDb(db));
afterEach(() => mock?.restore());

async function seedTracks(ids: string[]) {
  await db.batch(ids.map((id) => db.prepare("INSERT INTO tracks (track_id, track_uri, name) VALUES (?1, 'spotify:track:' || ?1, 'From export')").bind(id)));
}

it("credits tracks and fetches artists page by page, and ends although some tracks are gone", async () => {
  await seedTracks(["t1", "t2", "t3", "t4", "t5"]);
  await db.batch([
    db.prepare("INSERT INTO track_artists (track_id, artist_id, artist_name) VALUES ('t5', 'a-known', 'Known')"),
    db.prepare("INSERT INTO artists (artist_id, name) VALUES ('a-known', 'Known')"),
  ]);
  mock = mockSpotifyApi({ missing: ["t2", "a-t3"], genres: { "a-t1": ["desi pop", "filmi"] } });
  const sp = new SpotifyClient("id", "secret", db, "dry_run");

  const steps = [];
  let cursor = "";
  for (let i = 0; i < 10; i++) {
    const r = await enrichTracks(db, sp, cursor, 2);
    steps.push(r);
    if (r.done) break;
    cursor = r.cursor;
  }
  expect(steps.map((s) => [s.cursor, s.done, s.written])).toEqual([
    ["t2", false, 1],
    ["t4", false, 2],
    ["t4", true, 0],
  ]);
  // t2 is gone from Spotify: still uncredited, but the cursor moved past it.
  const credited = await db.prepare("SELECT track_id, artist_id FROM track_artists ORDER BY track_id").all();
  expect(credited.results).toEqual([
    { track_id: "t1", artist_id: "a-t1" },
    { track_id: "t3", artist_id: "a-t3" },
    { track_id: "t4", artist_id: "a-t4" },
    { track_id: "t5", artist_id: "a-known" },
  ]);
  // API metadata replaces the export's.
  expect(await db.prepare("SELECT name, duration_ms FROM tracks WHERE track_id = 't1'").first()).toEqual({ name: "API t1", duration_ms: 200_000 });

  const a = await enrichArtists(db, sp, "");
  expect(a).toEqual({ cursor: "a-t4", done: true, written: 2 });
  const artists = await db.prepare("SELECT artist_id, genres FROM artists ORDER BY artist_id").all();
  expect(artists.results).toEqual([
    { artist_id: "a-known", genres: null },
    { artist_id: "a-t1", genres: '["desi pop", "filmi"]' },
    { artist_id: "a-t4", genres: '["filmi"]' },
  ]);
  // Only reads: nothing is written to Spotify.
  expect(mock.calls.filter((c) => !c.startsWith("GET") && !c.includes("/api/token"))).toEqual([]);
});

it("is a no-op when everything is enriched", async () => {
  mock = mockSpotifyApi();
  const sp = new SpotifyClient("id", "secret", db, "live");
  expect(await enrichTracks(db, sp, "")).toEqual({ cursor: "", done: true, written: 0 });
  expect(await enrichArtists(db, sp, "")).toEqual({ cursor: "", done: true, written: 0 });
  expect(mock.calls).toEqual([]);
});
