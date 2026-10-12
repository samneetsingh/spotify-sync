// recapNewTrackCount, recapNewArtists and recapNewArtistCount are "a play in [from, to) and none
// before from" (NOT EXISTS) queries. This pins them to the original GROUP BY ... HAVING MIN() SQL,
// copied below, on random data: multi-artist tracks, artists credited under different names, tracks
// without credits, and ranges whose ends fall exactly on, just before and just after plays.
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import {
  insertPlays,
  recapNewArtistCount,
  recapNewArtistCountStmt,
  recapNewArtists,
  recapNewArtistsStmt,
  recapNewTrackCount,
  recapNewTrackCountStmt,
  runAll,
  upsertTrackArtists,
  upsertTracks,
  type PlayRow,
  type TrackArtistRow,
  type TrackRow,
} from "../../src/db/queries";
import { migrate } from "../../src/db/schema";
import { rng } from "../import/helpers";
import { resetDb } from "../parity/spotify-fixture";

/** The queries before the rewrite. */
const OLD_NEW_TRACK_COUNT = `SELECT COUNT(*) AS n FROM (
  SELECT track_id FROM plays WHERE played_at_ms < ?2 GROUP BY track_id HAVING MIN(played_at_ms) >= ?1
)`;
// Plus the artist_id tiebreak the new query has: before it, artists tied on plays and first play
// (e.g. two credits on one track) came back in no specified order.
const OLD_NEW_ARTISTS = `SELECT ta.artist_id, MAX(ta.artist_name) AS name, COUNT(*) AS plays
  FROM plays p JOIN track_artists ta ON ta.track_id = p.track_id
  WHERE p.played_at_ms < ?2
  GROUP BY ta.artist_id
  HAVING MIN(p.played_at_ms) >= ?1
  ORDER BY plays DESC, MIN(p.played_at_ms), ta.artist_id
  LIMIT ?3`;

const T0 = Date.UTC(2026, 0, 1);
const DAY = 86_400_000;

/** Random tracks (0-3 credits each), artists and ~400 plays over 60 days; returns the play times. */
async function seedRandom(seed: number): Promise<number[]> {
  const r = rng(seed);
  const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)]!;
  const artists = Array.from({ length: 20 }, (_, i) => `a${i}`);
  const tracks: TrackRow[] = Array.from({ length: 50 }, (_, i) => ({
    track_id: `t${i}`, track_uri: `spotify:track:t${i}`, name: `Track ${i}`, artists: null, album: null,
    duration_ms: 1000, explicit: null, popularity: null, release_date: null, isrc: null,
  }));
  const credits: TrackArtistRow[] = [];
  for (const t of tracks) {
    const n = Math.floor(r() * 4); // 0 = no credits (an imported track before enrichment)
    const credited = new Set(Array.from({ length: n }, () => pick(artists)));
    [...credited].forEach((a, position) => credits.push({ track_id: t.track_id, artist_id: a, artist_name: `${a}${r() < 0.2 ? " (alt)" : ""}`, position }));
  }
  // Some tracks are played often, some once; a few plays share a millisecond.
  const plays: PlayRow[] = [];
  for (let i = 0; i < 400; i++) {
    const t = r() < 0.5 ? pick(tracks.slice(0, 10)) : pick(tracks);
    const at = r() < 0.05 && plays.length ? plays.at(-1)!.played_at_ms : T0 + Math.floor(r() * 60 * DAY);
    plays.push({ played_at_ms: at, track_id: t.track_id, track_uri: t.track_uri, context_type: null, context_uri: null, source: "test" });
  }
  await resetDb(env.DB);
  await runAll(env.DB, [...upsertTracks(env.DB, tracks), ...upsertTrackArtists(env.DB, credits), ...insertPlays(env.DB, plays)]);
  return plays.map((p) => p.played_at_ms);
}

/** Range ends: random times, play times exactly and +-1 ms, before and after everything, and empty/backwards ranges. */
function randomRanges(seed: number, times: number[]): Array<[number, number]> {
  const r = rng(seed * 7919);
  const end = () => {
    const x = r();
    const t = times[Math.floor(r() * times.length)]!;
    if (x < 0.3) return t;
    if (x < 0.45) return t + 1;
    if (x < 0.6) return t - 1;
    if (x < 0.65) return T0 - DAY;
    if (x < 0.7) return T0 + 61 * DAY;
    return T0 + Math.floor(r() * 60 * DAY);
  };
  const ranges: Array<[number, number]> = [];
  for (let i = 0; i < 40; i++) {
    const [a, b] = [end(), end()];
    ranges.push(i % 10 === 9 ? [b, a] : [Math.min(a, b), Math.max(a, b)]); // every 10th is backwards (or empty)
  }
  const t = times[0]!;
  ranges.push([t, t], [t, t + 1], [T0 - DAY, T0 + 61 * DAY]);
  return ranges;
}

beforeAll(() => migrate(env.DB));

describe("new-to-you queries == the original SQL", () => {
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    it(`seed ${seed}`, async () => {
      const times = await seedRandom(seed);
      let nonEmpty = 0;
      for (const [from, to] of randomRanges(seed, times)) {
        const oldCount = await env.DB.prepare(OLD_NEW_TRACK_COUNT).bind(from, to).first<{ n: number }>();
        expect(await recapNewTrackCount(env.DB, from, to), `tracks ${from}-${to}`).toBe(oldCount!.n);

        const oldArtists = (await env.DB.prepare(OLD_NEW_ARTISTS).bind(from, to, -1).all()).results;
        expect(await recapNewArtistCount(env.DB, from, to), `artist count ${from}-${to}`).toBe(oldArtists.length);
        for (const limit of [1, 3, 1000]) {
          const old = (await env.DB.prepare(OLD_NEW_ARTISTS).bind(from, to, limit).all()).results;
          expect(await recapNewArtists(env.DB, from, to, limit), `artists ${from}-${to} limit ${limit}`).toEqual(old);
        }
        if (oldCount!.n && oldArtists.length) nonEmpty++;
      }
      expect(nonEmpty).toBeGreaterThan(5); // the ranges exercise more than the empty case
    });
  }
});

describe("query plans", () => {
  /** The SQL a statement builder prepares. */
  const sqlOf = (build: (db: D1Database) => unknown): string => {
    let sql = "";
    build({ prepare: (s: string) => ((sql = s), { bind: () => ({}) }) } as unknown as D1Database);
    return sql;
  };
  const plan = async (sql: string, binds: unknown[]) =>
    (await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...binds).all<{ detail: string }>()).results.map((r) => r.detail).join("\n");
  // The range is an index search on plays' time (idx_plays_time, or the primary key, which starts with
  // played_at_ms and covers track_id); the earlier-play check is an index seek, never a scan of plays.
  const timeRange = /SEARCH \w+ USING (COVERING )?INDEX (idx_plays_time|sqlite_autoindex_plays_1) \(played_at_ms>\? AND played_at_ms<\?\)/;

  it("new tracks: the range by time, the earlier play by track and time", async () => {
    const p = await plan(sqlOf((db) => recapNewTrackCountStmt(db, 0, 0)), [1, 2]);
    expect(p).toMatch(timeRange);
    expect(p).toMatch(/SEARCH q USING COVERING INDEX idx_plays_track_time \(track_id=\? AND played_at_ms<\?\)/);
    expect(p).not.toMatch(/SCAN (plays|q)\b/);
  });

  it("new artists: the range by time, the earlier play through the artist's tracks", async () => {
    for (const [build, binds] of [
      [(db: D1Database) => recapNewArtistsStmt(db, 0, 0, 3), [1, 2, 3]],
      [(db: D1Database) => recapNewArtistCountStmt(db, 0, 0), [1, 2]],
    ] as const) {
      const p = await plan(sqlOf(build), [...binds]);
      expect(p).toMatch(timeRange);
      expect(p).toMatch(/SEARCH e USING (COVERING )?INDEX idx_track_artists_artist \(artist_id=\?\)/);
      expect(p).toMatch(/SEARCH q USING COVERING INDEX idx_plays_track_time \(track_id=\? AND played_at_ms<\?\)/);
      expect(p).not.toMatch(/SCAN (p|q|plays)\b/);
    }
  });
});
