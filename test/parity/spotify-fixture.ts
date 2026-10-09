// Fixture expanders (TS twin of the removed Python generator's) plus a fetch mock that
// records Spotify calls in the shape the frozen golden files use.

import type { Config } from "../../src/config";
import { runArtistPlaylists } from "../../src/jobs/artist-playlists";
import { runHindiFavorites } from "../../src/jobs/hindi-favorites";
import { runSync, runSyncFull } from "../../src/jobs/sync";
import type { SpotifyClient } from "../../src/spotify/client";
import artistFixtures from "./artist-scenarios.json";
import artistGolden from "./artist-golden.json";
import hindiFixtures from "./hindi-scenarios.json";
import hindiGolden from "./hindi-golden.json";
import syncFixtures from "./sync-scenarios.json";
import syncGolden from "./sync-golden.json";

type Json = any; // fixture data is untyped JSON

export const FAMILIES: { family: string; fixtures: Json; golden: Record<string, Json> }[] = [
  { family: "sync", fixtures: syncFixtures, golden: syncGolden },
  { family: "artist", fixtures: artistFixtures, golden: artistGolden },
  { family: "hindi", fixtures: hindiFixtures, golden: hindiGolden },
];

/** Scenarios where the Worker intentionally differs from Python; each has a dedicated test. */
export const KNOWN_DIVERGENCES: Record<string, string> = {
  manual_add_unknown_track: "Python fails the run on the playlist_tracks FK; the Worker upserts the track",
};

export interface Call {
  op: string;
  [k: string]: unknown;
}

export function trackObj(spotify: Json, trackId: string): Json {
  const spec = spotify.tracks[trackId];
  if (spec === undefined) {
    return { id: trackId, uri: `spotify:track:${trackId}`, name: `Track ${trackId}`, artists: [], album: { name: "Album" }, duration_ms: 1000, explicit: false };
  }
  return {
    id: trackId,
    uri: `spotify:track:${trackId}`,
    name: spec.name ?? null,
    artists: (spec.artists ?? []).map((a: [string, string]) => ({ id: a[0], name: a[1] })),
    album: { name: spec.album ?? null, release_date: spec.release_date ?? null },
    duration_ms: spec.duration_ms ?? null,
    explicit: spec.explicit ?? null,
    popularity: spec.popularity ?? null,
    external_ids: { isrc: spec.isrc ?? null },
  };
}

function recentResponse(spotify: Json, entries: Json): Json {
  if (!Array.isArray(entries)) return entries;
  return {
    items: entries.map((e: Json) =>
      Array.isArray(e)
        ? { played_at: e[0], track: trackObj(spotify, e[1]), context: { type: e[2] ?? null, uri: e[3] ?? null } }
        : e,
    ),
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Installs a fetch mock serving `spotify` fixture data; returns the recorded calls. */
export function mockSpotify(spotify: Json): { calls: Call[]; restore: () => void } {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  let created = 0;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? "GET";
    if (url.hostname === "accounts.spotify.com") {
      return json({ access_token: "test-token", token_type: "Bearer", expires_in: 3600, scope: "" });
    }
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const q = url.searchParams;
    const path = url.pathname;
    if (method === "GET" && path === "/v1/me/player/recently-played") {
      const after = Number(q.get("after"));
      calls.push({ op: "recently_played", limit: Number(q.get("limit")), after });
      if (spotify.recently_played_error) return json({ error: { status: 400, message: "boom" } }, 400);
      const rp = spotify.recently_played;
      return json(recentResponse(spotify, rp.by_after ? (rp.by_after[String(after)] ?? []) : rp.default));
    }
    let m = path.match(/^\/v1\/playlists\/([^/]+)\/tracks$/);
    if (m && method === "GET") {
      const [limit, offset] = [Number(q.get("limit")), Number(q.get("offset"))];
      calls.push({ op: "playlist_items", playlist_id: m[1], limit, offset });
      if ((spotify.missing_playlists ?? []).includes(m[1])) return json({ error: { status: 404, message: "Not found" } }, 404);
      const ids: string[] = spotify.playlist_items[m[1]!] ?? [];
      return json({
        items: ids.slice(offset, offset + limit).map((t) => ({ track: trackObj(spotify, t) })),
        next: offset + limit < ids.length ? "more" : null,
      });
    }
    if (m && method === "POST") {
      calls.push({ op: "playlist_add", playlist_id: m[1], uris: body.uris });
      return json({ snapshot_id: "s" }, 201);
    }
    m = path.match(/^\/v1\/playlists\/([^/]+)$/);
    if (m && method === "GET") {
      calls.push({ op: "playlist_total", playlist_id: m[1] });
      return json({ tracks: { total: spotify.playlist_total[m[1]!] ?? 0 } });
    }
    if (method === "GET" && path === "/v1/artists") {
      const ids = q.get("ids")!.split(",");
      calls.push({ op: "artists", ids: [...ids].sort() });
      return json({
        artists: ids.map((id) => {
          const s = spotify.artists[id];
          return s == null ? null : { id, name: s.name, genres: s.genres, popularity: s.popularity, followers: { total: s.followers } };
        }),
      });
    }
    if (method === "POST" && path === "/v1/me/playlists") {
      calls.push({ op: "create_playlist", name: body.name, public: body.public, description: body.description });
      return json({ id: `created-${++created}` }, 201);
    }
    m = path.match(/^\/v1\/playlists\/([^/]+)\/followers$/);
    if (m && method === "DELETE") {
      calls.push({ op: "unfollow", playlist_id: m[1] });
      return new Response(null, { status: 200 });
    }
    if (method === "PUT" && path === "/v1/me/tracks") {
      calls.push({ op: "liked_add", ids: body.ids });
      return new Response(null, { status: 200 });
    }
    throw new Error(`Unmocked Spotify request: ${method} ${url.href}`);
  }) as typeof fetch;

  return { calls, restore: () => void (globalThis.fetch = original) };
}

const APP_TABLES = [
  "worker_actions", "sync_runs", "state", "playlist_exclusions", "playlist_removals",
  "playlist_tracks", "playlists", "plays", "track_artists", "artists", "tracks",
];

export async function resetDb(db: D1Database): Promise<void> {
  await db.batch(APP_TABLES.map((t) => db.prepare(`DELETE FROM ${t}`)));
  await db.prepare("INSERT INTO state(key, value) VALUES('spotify_refresh_token', 'test-refresh')").run();
}

/** Seeds a scenario's rows (mirrors the original generator's seed_db). */
export async function seedDb(db: D1Database, seed: Json, now: number): Promise<void> {
  const stmts: D1PreparedStatement[] = [];
  for (const [id, name, artists] of seed.tracks) {
    stmts.push(db.prepare("INSERT INTO tracks(track_id, track_uri, name, artists, album, duration_ms, explicit) VALUES(?1, 'spotify:track:' || ?1, ?2, ?3, 'Album', 1000, 0)").bind(id, name, artists));
  }
  for (const [ms, id] of seed.plays) {
    stmts.push(db.prepare("INSERT INTO plays(played_at_ms, track_id, track_uri, source) VALUES(?1, ?2, 'spotify:track:' || ?2, 'history_import')").bind(ms, id));
  }
  for (const [pid, id] of seed.playlist_tracks) {
    stmts.push(db.prepare("INSERT INTO playlist_tracks(playlist_id, track_id, track_uri) VALUES(?1, ?2, 'spotify:track:' || ?2)").bind(pid, id));
  }
  for (const [id, name, genres] of seed.artists) {
    stmts.push(db.prepare("INSERT INTO artists(artist_id, name, genres) VALUES(?1, ?2, ?3)").bind(id, name, genres));
  }
  for (const [tid, aid, name, pos] of seed.track_artists ?? []) {
    stmts.push(db.prepare("INSERT INTO track_artists(track_id, artist_id, artist_name, position) VALUES(?1, ?2, ?3, ?4)").bind(tid, aid, name, pos));
  }
  for (const [pid, name, artist] of seed.playlists ?? []) {
    stmts.push(db.prepare("INSERT INTO playlists(playlist_id, name, artist_name, playlist_type) VALUES(?1, ?2, ?3, 'artist')").bind(pid, name, artist));
  }
  for (const [pid, tid] of seed.playlist_removals ?? []) {
    stmts.push(db.prepare("INSERT INTO playlist_removals(playlist_id, track_id, track_uri) VALUES(?1, ?2, 'spotify:track:' || ?2)").bind(pid, tid));
  }
  for (const [artist, pid] of seed.playlist_exclusions ?? []) {
    stmts.push(db.prepare("INSERT INTO playlist_exclusions(artist_name, playlist_id) VALUES(?1, ?2)").bind(artist, pid));
  }
  const state: Record<string, string> = { ...seed.state };
  for (const [k, age] of Object.entries(seed.state_age_ms)) state[k] = String(now - Number(age));
  for (const [k, v] of Object.entries(state)) {
    stmts.push(db.prepare("INSERT INTO state(key, value) VALUES(?1, ?2)").bind(k, v));
  }
  if (stmts.length) await db.batch(stmts);
}

export async function dumpTables(db: D1Database, queries: Record<string, string>): Promise<Record<string, Json[]>> {
  const out: Record<string, Json[]> = {};
  for (const [name, sql] of Object.entries(queries)) out[name] = (await db.prepare(sql).all()).results;
  return out;
}

/** Worker Config for a scenario's config block. */
export function scenarioConfig(c: Json, writeMode: Config["writeMode"] = "live"): Config {
  return {
    writeMode,
    allPlaylistId: c.all_playlist_id,
    frequentPlaylistId: c.frequent_playlist_id,
    hindiFavoritesPlaylistId: c.hindi_favorites_playlist_id,
    frequentMinPlays: c.frequent_min_plays,
    hindiFavoritesMinPlays: c.hindi_favorites_min_plays,
    bootstrapHours: 24,
    recentlyPlayedLimit: c.recently_played_limit,
    addBatchSize: 100,
    likeBatchSize: 50,
    cacheRefreshHours: 24,
    artistDiscovery: {
      playsPerSongThreshold: c.artist_discovery.plays_per_song_threshold,
      songsOverThreshold: c.artist_discovery.songs_over_threshold,
      totalStreamsThreshold: c.artist_discovery.total_streams_threshold,
      altSongCount: c.artist_discovery.alt_song_count,
      altStreamsThreshold: c.artist_discovery.alt_streams_threshold,
      minPlaysPerTrack: c.artist_discovery.min_plays_per_track,
      maxTracksPerPlaylist: c.artist_discovery.max_tracks_per_playlist,
      minTracksPerPlaylist: c.artist_discovery.min_tracks_per_playlist,
    },
  };
}

/** Runs one scenario run with the Worker job, returning the result in golden-file shape. */
export async function runJob(sc: Json, cfg: Config, db: D1Database, sp: SpotifyClient): Promise<Json> {
  try {
    if (sc.job === "sync") {
      const r = await runSync(cfg, db, sp);
      return { plays_fetched: r.playsFetched, liked_added: r.likedAdded, frequent_added: r.frequentAdded, cursor_in_ms: r.cursorInMs, cursor_out_ms: r.cursorOutMs };
    }
    if (sc.job === "sync_full") {
      const r = await runSyncFull(cfg, db, sp);
      return { total_added: r.likedAdded + r.frequentAdded };
    }
    if (sc.job === "hindi_favorites") {
      const r = (await runHindiFavorites(cfg, db, sp))!;
      return { tracks_added: r.tracksAdded, tracks_considered: r.tracksConsidered };
    }
    const r = await runArtistPlaylists(cfg, db, sp);
    return { artists_processed: r.artistsProcessed, playlists_created: r.playlistsCreated, total_tracks_added: r.totalTracksAdded, pruned: r.pruned };
  } catch (err) {
    if (!sc.spotify.recently_played_error) console.error(sc.name, err);
    return { error: true };
  }
}
