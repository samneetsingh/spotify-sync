// Intentional differences of the track_artists-based rewrite vs the recursive CTE
// of the original Python service, which split tracks.artists on ", " (docs/PORTING.md).
import { env } from "cloudflare:workers";
import { beforeAll, expect, it } from "vitest";
import { artistTracksOverThreshold, discoverArtists } from "../../src/db/queries";
import { migrate } from "../../src/db/schema";
import { resetDb } from "../parity/spotify-fixture";

const D = { playsPerSongThreshold: 1, songsOverThreshold: 0, totalStreamsThreshold: 1000, altSongCount: 1000, altStreamsThreshold: 1000 };

beforeAll(async () => {
  await migrate(env.DB);
  await resetDb(env.DB);
  const db = env.DB;
  const track = (id: string, artists: string, credits: [string, string][], plays: number, start: number) => [
    db.prepare("INSERT INTO tracks(track_id, track_uri, name, artists) VALUES(?1, 'spotify:track:' || ?1, ?1, ?2)").bind(id, artists),
    ...credits.map(([aid, name], i) =>
      db.prepare("INSERT INTO track_artists(track_id, artist_id, artist_name, position) VALUES(?1, ?2, ?3, ?4)").bind(id, aid, name, i),
    ),
    ...Array.from({ length: plays }, (_, i) =>
      db.prepare("INSERT INTO plays(played_at_ms, track_id, track_uri, source) VALUES(?1, ?2, 'spotify:track:' || ?2, 'test')").bind(start + i, id),
    ),
  ];
  await db.batch([
    // Comma inside one artist's name: the CTE produced "Tyler" and "the Creator".
    ...track("tc", "Tyler, the Creator", [["tyler", "Tyler, the Creator"]], 3, 100),
    // History-import style row: tracks.artists lists only the primary artist, but
    // track_artists credits the feature too.
    ...track("ft", "Main Artist", [["main", "Main Artist"], ["feat", "Featured Artist"]], 4, 200),
  ]);
});

it("keeps comma names whole and credits featured artists", async () => {
  const names = (await discoverArtists(env.DB, D)).map((a) => a.artist).sort();
  expect(names).toEqual(["Featured Artist", "Main Artist", "Tyler, the Creator"]);
});

it("selects tracks by exact credited name, not substring", async () => {
  const byArtist = await artistTracksOverThreshold(env.DB, ["Tyler, the Creator", "Tyler", "Featured Artist"], 1);
  expect(byArtist.get("Tyler, the Creator")?.map((t) => t.track_id)).toEqual(["tc"]);
  expect(byArtist.has("Tyler")).toBe(false);
  expect(byArtist.get("Featured Artist")?.map((t) => t.track_id)).toEqual(["ft"]);
});
