// Cover art and artist photos for the Home, cached in `state` dashboard:art = {at, art: {id: url | ""}}
// ("" = Spotify has no image for it). loadHome (./home-data.ts) reads the cache in its batch; fillArt
// fetches what the page shows and the cache lacks: at most one getTracks and one getArtists call
// (<= 8 ids each), each with a 2.5 s AbortSignal, then saves the merged cache after the response
// (ctx.waitUntil), keeping the newest 300 entries. A cache older than 7 days counts as empty, so the
// page's art is fetched again and `at` restarts; a partial fill keeps `at`. Any failure means
// placeholders and no write. A warm page view makes no Spotify calls.

import { isLoginError } from "../alerts";
import { parseWriteMode, type Env } from "../env";
import { getState, setState } from "../db/state";
import { isSpotifyImageUrl } from "../http";
import { pickImage } from "../jobs/digest";
import { SpotifyClient } from "../spotify/client";
import type { HomeData } from "./home-data";

export const ART_KEY = "dashboard:art";
export const ART_MAX_AGE_MS = 7 * 86_400_000;
export const ART_MAX_ENTRIES = 300;
export const ART_TIMEOUT_MS = 2_500;

type ArtMap = Record<string, string>;

/** A `dashboard:art` value's entries and time; null when it is missing, malformed or older than ART_MAX_AGE_MS. */
function parseCache(raw: string | null, now: number): { at: number; art: ArtMap } | null {
  if (!raw) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  const { at, art } = (v && typeof v === "object" ? v : {}) as { at?: unknown; art?: unknown };
  if (typeof at !== "number" || now - at > ART_MAX_AGE_MS || !art || typeof art !== "object") return null;
  // Only Spotify image URLs the CSP allows (or "") ever get here; anything else in the value is dropped.
  return { at, art: Object.fromEntries(Object.entries(art).filter(([, url]) => url === "" || (typeof url === "string" && isSpotifyImageUrl(url)))) };
}

/** The cached entries of a `dashboard:art` value: none when it is missing, malformed or stale. */
export const cachedArt = (raw: string | null, now: number): ArtMap => parseCache(raw, now)?.art ?? {};

/** The ids the Home shows art for: songs (album covers) and artists (photos), each once. */
export function artIds(data: HomeData): { tracks: string[]; artists: string[] } {
  const tracks = [data.songOfWeek?.track, ...data.topTracks, ...data.throwbacks.map((t) => t.track)].flatMap((t) => (t ? [t.id] : []));
  const artists = [...data.topArtists, ...data.newToYou.newArtists].map((a) => a.id);
  return { tracks: [...new Set(tracks)], artists: [...new Set(artists)] };
}

/**
 * `data` with art for every id it shows that the cache lacks. No Spotify call when nothing is
 * missing, Spotify isn't connected (or its login needs reconnecting) or the app has no credentials.
 * Never throws.
 */
export async function fillArt(env: Env, ctx: Pick<ExecutionContext, "waitUntil">, data: HomeData): Promise<HomeData> {
  const ids = artIds(data);
  const tracks = ids.tracks.filter((id) => !Object.hasOwn(data.art, id));
  const artists = ids.artists.filter((id) => !Object.hasOwn(data.art, id));
  // Spotify's login expired or was revoked: every call would fail after a token refresh, so don't try.
  const loginFailing = data.status.failing.some((f) => f.job === "sync" && !!f.lastError && isLoginError(f.lastError));
  if ((!tracks.length && !artists.length) || !data.status.connected || loginFailing || !env.SPOTIFY_CLIENT_ID || !env.SPOTIFY_CLIENT_SECRET) return data;
  try {
    const fetched = await fetchArt(env, ctx, tracks, artists);
    ctx.waitUntil(saveArt(env.DB, fetched, [...ids.tracks, ...ids.artists], data.now));
    return { ...data, art: { ...data.art, ...fetched } };
  } catch (err) {
    console.warn(JSON.stringify({ dashboard: "art unavailable", error: err instanceof Error ? err.message : String(err) }));
    return data;
  }
}

/** One batch call per kind; an id Spotify doesn't return (or has no image for) gets "". Throws on any failure or after ART_TIMEOUT_MS. */
async function fetchArt(env: Env, ctx: Pick<ExecutionContext, "waitUntil">, tracks: string[], artists: string[]): Promise<ArtMap> {
  const sp = new SpotifyClient(env.SPOTIFY_CLIENT_ID, env.SPOTIFY_CLIENT_SECRET, env.DB, parseWriteMode(env.WRITE_MODE));
  const signal = AbortSignal.timeout(ART_TIMEOUT_MS);
  const work = Promise.all([tracks.length ? sp.getTracks(tracks, signal) : null, artists.length ? sp.getArtists(artists, signal) : null]);
  // The signal aborts the API requests, not the token refresh before them (aborting that could lose a
  // rotated refresh token), so keep the work alive after the response and give up waiting at the deadline.
  ctx.waitUntil(work.catch(() => {}));
  const timedOut = new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  const [t, a] = await Promise.race([work, timedOut]);

  const art: ArtMap = Object.fromEntries([...tracks, ...artists].map((id) => [id, ""]));
  // A URL the CSP wouldn't allow is stored as "" (placeholder), like a missing image.
  const allowed = (url: string | undefined) => (url && isSpotifyImageUrl(url) ? url : "");
  for (const track of t?.tracks ?? []) if (track?.id && track.id in art) art[track.id] = allowed(pickImage(track.album?.images));
  for (const artist of a?.artists ?? []) if (artist?.id && artist.id in art) art[artist.id] = allowed(pickImage(artist.images));
  return art;
}

/**
 * Merges `fetched` into the stored cache (re-read here, after the response) and keeps the newest
 * ART_MAX_ENTRIES, the page's ids counting as newest. A stale or missing cache starts over at `now`.
 */
async function saveArt(db: D1Database, fetched: ArtMap, pageIds: string[], now: number): Promise<void> {
  try {
    const stored = parseCache(await getState(db, ART_KEY), now);
    const merged: ArtMap = { ...stored?.art, ...fetched };
    const page = new Set(pageIds);
    const entries = [
      ...Object.entries(merged).filter(([id]) => !page.has(id)),
      ...pageIds.flatMap((id) => (id in merged ? [[id, merged[id]!] as const] : [])),
    ].slice(-ART_MAX_ENTRIES);
    await setState(db, ART_KEY, JSON.stringify({ at: stored?.at ?? now, art: Object.fromEntries(entries) }));
  } catch (err) {
    console.warn(JSON.stringify({ dashboard: "art cache not saved", error: err instanceof Error ? err.message : String(err) }));
  }
}
