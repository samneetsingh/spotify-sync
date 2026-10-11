// Test helpers for src/import: synthetic export records, a zip builder (CompressionStream
// "deflate-raw"), a Spotify fetch mock for enrichment/backfill, and import rows.

import type { ImportFile } from "../../src/import/store";

export const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

// ---------------------------------------------------------------------------- export records

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

export interface RecordSpec {
  ms: number;
  track?: string | null;
  msPlayed?: number;
  name?: string;
  artist?: string;
  album?: string;
  platform?: string;
  shuffle?: boolean;
  skipped?: boolean | null;
}

/** A record in the current Streaming_History_Audio_*.json format. */
export function audioRecord(r: RecordSpec): Record<string, unknown> {
  return {
    ts: iso(r.ms),
    platform: r.platform ?? "ios",
    ms_played: r.msPlayed ?? 180_000,
    conn_country: "US",
    ip_addr: "203.0.113.7",
    master_metadata_track_name: r.track ? (r.name ?? `Song ${r.track}`) : null,
    master_metadata_album_artist_name: r.track ? (r.artist ?? `Artist ${r.track}`) : null,
    master_metadata_album_album_name: r.track ? (r.album ?? `Album ${r.track}`) : null,
    spotify_track_uri: r.track ? `spotify:track:${r.track}` : null,
    episode_name: null,
    episode_show_name: null,
    spotify_episode_uri: null,
    audiobook_title: null,
    audiobook_uri: null,
    audiobook_chapter_uri: null,
    audiobook_chapter_title: null,
    reason_start: "trackdone",
    reason_end: "trackdone",
    shuffle: r.shuffle ?? false,
    skipped: r.skipped === undefined ? false : r.skipped,
    offline: false,
    offline_timestamp: Math.floor(r.ms / 1000),
    incognito_mode: false,
  };
}

/** A podcast play: no track URI (skipped by the parser). */
export function episodeRecord(ms: number): Record<string, unknown> {
  return { ...audioRecord({ ms, track: null }), episode_name: "Ep 1", episode_show_name: "A Show", spotify_episode_uri: "spotify:episode:ep1" };
}

/** A record in the older endsong_*.json format. */
export function endsongRecord(r: RecordSpec): Record<string, unknown> {
  const { ip_addr: _ip, ...rest } = audioRecord(r);
  return { ...rest, username: "someone", ip_addr_decrypted: "203.0.113.7", user_agent_decrypted: "unknown" };
}

export const exportJson = (records: Array<Record<string, unknown>>): string => JSON.stringify(records, null, 2);

/** Deterministic PRNG (mulberry32) for randomized fixtures. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------- zips

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (const x of b) c = CRC_TABLE[(c ^ x) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export async function deflateRaw(b: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([b]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export interface ZipFileSpec {
  name: string;
  data: string | Uint8Array;
  /** 8 (deflate, default) or 0 (stored). */
  method?: number;
  /** Sizes and CRC in a data descriptor after the data (local header has zeros), like streaming zippers. */
  descriptor?: boolean;
  encrypted?: boolean;
  /** Override the uncompressed size in the central directory (e.g. to look oversized). */
  declaredSize?: number;
  /** Write 0xFFFFFFFF sizes (zip64 style). */
  zip64Sizes?: boolean;
}

class Bytes {
  private parts: Uint8Array[] = [];
  length = 0;
  push(b: Uint8Array) {
    this.parts.push(b);
    this.length += b.length;
  }
  le(values: Array<[number, 2 | 4]>) {
    const b = new Uint8Array(values.reduce((s, [, n]) => s + n, 0));
    const v = new DataView(b.buffer);
    let at = 0;
    for (const [x, n] of values) {
      if (n === 2) v.setUint16(at, x, true);
      else v.setUint32(at, x >>> 0, true);
      at += n;
    }
    this.push(b);
  }
  concat(): Uint8Array {
    const out = new Uint8Array(this.length);
    let at = 0;
    for (const p of this.parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  }
}

/** Builds a zip archive in memory. */
export async function buildZip(files: ZipFileSpec[], opts: { zip64Locator?: boolean; comment?: string } = {}): Promise<Uint8Array> {
  const out = new Bytes();
  const central = new Bytes();
  for (const f of files) {
    const data = typeof f.data === "string" ? enc(f.data) : f.data;
    const method = f.method ?? 8;
    const body = method === 8 ? await deflateRaw(data) : data;
    const crc = crc32(data);
    const name = enc(f.name);
    const flags = (f.descriptor ? 0x08 : 0) | (f.encrypted ? 0x01 : 0) | 0x800;
    const offset = out.length;
    const [lc, ls, lu] = f.descriptor ? [0, 0, 0] : [crc, body.length, data.length];
    out.le([[0x04034b50, 4], [20, 2], [flags, 2], [method, 2], [0, 2], [0x21, 2], [lc, 4], [ls, 4], [lu, 4], [name.length, 2], [0, 2]]);
    out.push(name);
    out.push(body);
    if (f.descriptor) out.le([[0x08074b50, 4], [crc, 4], [body.length, 4], [data.length, 4]]);
    const csize = f.zip64Sizes ? 0xffffffff : body.length;
    const usize = f.zip64Sizes ? 0xffffffff : (f.declaredSize ?? data.length);
    central.le([
      [0x02014b50, 4], [20, 2], [20, 2], [flags, 2], [method, 2], [0, 2], [0x21, 2], [crc, 4], [csize, 4], [usize, 4],
      [name.length, 2], [0, 2], [0, 2], [0, 2], [0, 2], [0, 4], [offset, 4],
    ]);
    central.push(name);
  }
  const cdOffset = out.length;
  const cd = central.concat();
  out.push(cd);
  if (opts.zip64Locator) out.le([[0x07064b50, 4], [0, 4], [0, 4], [0, 4], [1, 4]]);
  const comment = enc(opts.comment ?? "");
  out.le([[0x06054b50, 4], [0, 2], [0, 2], [files.length, 2], [files.length, 2], [cd.length, 4], [cdOffset, 4], [comment.length, 2]]);
  out.push(comment);
  return out.concat();
}

// ---------------------------------------------------------------------------- import rows and uploads

/** Inserts an import row; returns its id. */
export async function insertImport(
  db: D1Database,
  opts: { id?: string; status?: string; files?: ImportFile[]; spanFrom?: number; spanTo?: number; options?: object; preview?: object; createdAt?: number } = {},
): Promise<string> {
  const id = opts.id ?? crypto.randomUUID();
  const now = opts.createdAt ?? Date.now();
  await db
    .prepare("INSERT INTO imports (id, created_at, updated_at, status, files, span_from, span_to, options, preview) VALUES (?1, ?2, ?2, ?3, ?4, ?5, ?6, ?7, ?8)")
    .bind(id, now, opts.status ?? "reading", JSON.stringify(opts.files ?? []), opts.spanFrom ?? null, opts.spanTo ?? null, opts.options ? JSON.stringify(opts.options) : null, opts.preview ? JSON.stringify(opts.preview) : null)
    .run();
  return id;
}

/** Puts an uploaded file into R2 the way the routes do (single object under imports/<id>/), returning its record. */
export async function putUpload(bucket: R2Bucket, importId: string, n: number, name: string, bytes: Uint8Array): Promise<ImportFile> {
  const ext = name.toLowerCase().endsWith(".zip") ? "zip" : "json";
  const key = `imports/${importId}/${n}.${ext}`;
  await bucket.put(key, bytes);
  return { n, name, size: bytes.length, key, uploadId: "test", done: true };
}

export async function clearBucket(bucket: R2Bucket): Promise<void> {
  const listed = await bucket.list({ prefix: "imports/" });
  if (listed.objects.length) await bucket.delete(listed.objects.map((o) => o.key));
}

export async function bucketKeys(bucket: R2Bucket, importId?: string): Promise<string[]> {
  return (await bucket.list({ prefix: importId ? `imports/${importId}/` : "imports/" })).objects.map((o) => o.key);
}

// ---------------------------------------------------------------------------- Spotify

export interface SpotifyMock {
  calls: string[];
  liked: string[];
  restore: () => void;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/**
 * Serves the token endpoint, GET /tracks and /artists (null for ids listed in `missing`), PUT
 * /me/tracks and the playlist reads the backfill makes. Any other request fails the test instead of
 * reaching Spotify.
 */
export function mockSpotifyApi(opts: { missing?: string[]; genres?: Record<string, string[]> } = {}): SpotifyMock {
  const calls: string[] = [];
  const liked: string[] = [];
  const missing = new Set(opts.missing ?? []);
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url.pathname}${url.search}`);
    if (url.hostname === "accounts.spotify.com") return json({ access_token: "test-token", token_type: "Bearer", expires_in: 3600, scope: "" });
    if (url.hostname !== "api.spotify.com") throw new Error(`Unexpected fetch: ${method} ${url.href}`);
    const ids = url.searchParams.get("ids")?.split(",") ?? [];
    if (method === "GET" && url.pathname === "/v1/tracks") {
      return json({
        tracks: ids.map((id) =>
          missing.has(id)
            ? null
            : { id, uri: `spotify:track:${id}`, name: `API ${id}`, duration_ms: 200_000, explicit: false, popularity: 50, album: { name: `API Album ${id}`, release_date: "2020-01-01" }, artists: [{ id: `a-${id}`, name: `Artist ${id}` }], external_ids: { isrc: `ISRC${id}` } },
        ),
      });
    }
    if (method === "GET" && url.pathname === "/v1/artists") {
      return json({ artists: ids.map((id) => (missing.has(id) ? null : { id, name: `Artist ${id.slice(2)}`, genres: opts.genres?.[id] ?? ["filmi"], popularity: 40, followers: { total: 1000 } })) });
    }
    if (method === "PUT" && url.pathname === "/v1/me/tracks") {
      liked.push(...(JSON.parse(String(init?.body)).ids as string[]));
      return new Response(null, { status: 200 });
    }
    if (method === "GET" && url.pathname === "/v1/me/playlists") return json({ items: [], next: null });
    throw new Error(`Unmocked Spotify request: ${method} ${url.href}`);
  }) as typeof fetch;
  return { calls, liked, restore: () => void (globalThis.fetch = original) };
}

export interface PlayRowOut {
  played_at_ms: number;
  track_id: string;
  track_uri: string;
  source: string;
  ms_played: number | null;
  platform: string | null;
  conn_country: string | null;
  reason_start: string | null;
  reason_end: string | null;
  shuffle: number | null;
  skipped: number | null;
  offline: number | null;
  incognito_mode: number | null;
}

export async function allPlays(db: D1Database): Promise<PlayRowOut[]> {
  const { results } = await db
    .prepare(
      "SELECT played_at_ms, track_id, track_uri, source, ms_played, platform, conn_country, reason_start, reason_end, shuffle, skipped, offline, incognito_mode FROM plays ORDER BY played_at_ms, track_id",
    )
    .all<PlayRowOut>();
  return results;
}

export const count = async (db: D1Database, sql: string): Promise<number> => (await db.prepare(sql).first<{ n: number }>())?.n ?? 0;
