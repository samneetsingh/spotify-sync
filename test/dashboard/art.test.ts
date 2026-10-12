// fillArt: Spotify art for the Home's songs and artists, cached in `state` dashboard:art. Fetch is
// mocked (no real credentials or network): a fresh cache makes no calls, missing ids cost at most
// one getTracks and one getArtists (each with an AbortSignal), failures write nothing, the cache
// keeps the newest 300 entries and refetches everything once it is older than 7 days.
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ART_KEY, ART_MAX_ENTRIES, artIds, fillArt } from "../../src/dashboard/art";
import { loadHome, type ArtistItem, type HomeData, type TrackItem } from "../../src/dashboard/home-data";
import { migrate } from "../../src/db/schema";
import { getState, setState } from "../../src/db/state";
import { resetDb } from "../parity/spotify-fixture";
import { seed } from "../jobs/digest-helpers";
import { testEnv } from "./helpers";

const LA = "America/Los_Angeles";
const DAY = 86_400_000;
const NOW = Date.parse("2026-10-14T17:00:00Z");
const cover = (id: string, w = 300) => `https://i.scdn.co/image/${id}-${w}`;

type Call = { path: string; ids: string[]; signal: AbortSignal | null };

/** Spotify's token, tracks and artists endpoints. `gone` ids come back null; `fail`/`hang` break that endpoint. */
function mockSpotify(opts: { fail?: "tracks" | "artists"; hang?: boolean; foreign?: boolean } = {}) {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    if (url.hostname === "accounts.spotify.com") return json({ access_token: "t", token_type: "Bearer", expires_in: 3600 });
    if (url.hostname !== "api.spotify.com") throw new Error(`Unexpected fetch: ${url.href}`);
    const ids = url.searchParams.get("ids")?.split(",") ?? [];
    const signal = init?.signal ?? null;
    calls.push({ path: url.pathname, ids, signal });
    if (opts.hang) {
      return new Promise<Response>((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason)));
    }
    const images = (id: string) => [640, 300, 64].map((w) => ({ url: opts.foreign ? `https://images.example.com/${id}-${w}` : cover(id, w), width: w, height: w }));
    if (url.pathname === "/v1/tracks") {
      if (opts.fail === "tracks") return json({ error: { status: 400, message: "bad" } }, 400);
      return json({ tracks: ids.map((id) => (id.startsWith("gone") ? null : { id, album: { images: images(id) } })) });
    }
    if (url.pathname === "/v1/artists") {
      if (opts.fail === "artists") return json({ error: { status: 400, message: "bad" } }, 400);
      return json({ artists: ids.map((id) => (id.startsWith("gone") ? null : { id, images: images(id) })) });
    }
    throw new Error(`Unexpected Spotify call: ${url.pathname}`);
  }) as typeof fetch;
  return { calls, restore: () => void (globalThis.fetch = original) };
}

/** An ExecutionContext whose waitUntil work the test can wait for. */
function context() {
  const waits: Promise<unknown>[] = [];
  return { ctx: { waitUntil: (p: Promise<unknown>) => void waits.push(p) }, settle: () => Promise.all(waits), waits };
}

const track = (id: string): TrackItem => ({ id, name: `Song ${id}`, artists: "Someone", plays: 1 });
const artist = (id: string): ArtistItem => ({ id, name: `Artist ${id}`, plays: 1 });

/** A Home showing songs t1, t2, gone1 and artists a1, a2, with `art` from the cache. */
async function home(art: Record<string, string>): Promise<HomeData> {
  const base = await loadHome(env.DB, { now: NOW, timeZone: LA });
  return {
    ...base,
    songOfWeek: { track: track("t1"), lastWeek: false },
    topTracks: [track("t1"), track("t2")],
    throwbacks: [{ year: 2025, track: track("gone1") }],
    topArtists: [artist("a1")],
    newToYou: { ...base.newToYou, newArtists: [artist("a2")] },
    art,
  };
}

const storedCache = async () => JSON.parse((await getState(env.DB, ART_KEY)) ?? "null") as { at: number; art: Record<string, string> } | null;

let spotify: ReturnType<typeof mockSpotify> | null = null;
beforeAll(() => migrate(env.DB));
beforeEach(() => resetDb(env.DB)); // also stores a refresh token: connected
afterEach(() => spotify?.restore());

describe("fillArt", () => {
  it("lists the page's songs and artists once each", async () => {
    expect(artIds(await home({}))).toEqual({ tracks: ["t1", "t2", "gone1"], artists: ["a1", "a2"] });
  });

  it("makes no Spotify call and writes nothing when the cache has everything", async () => {
    spotify = mockSpotify();
    const art = { t1: cover("t1"), t2: "", gone1: "", a1: cover("a1"), a2: cover("a2") };
    const data = await home(art);
    const { ctx, waits } = context();
    expect(await fillArt(testEnv(), ctx, data)).toBe(data);
    expect(spotify.calls).toEqual([]);
    expect(waits).toEqual([]);
  });

  it("fetches only the missing ids, in one call per kind with an AbortSignal, and keeps the cache's time", async () => {
    const at = NOW - 2 * DAY;
    await setState(env.DB, ART_KEY, JSON.stringify({ at, art: { t1: cover("t1"), a1: "" } }));
    spotify = mockSpotify();
    const { ctx, settle } = context();
    const data = await home({ t1: cover("t1"), a1: "" });
    const filled = await fillArt(testEnv(), ctx, data);

    expect(spotify.calls.map((c) => [c.path, c.ids])).toEqual([["/v1/tracks", ["t2", "gone1"]], ["/v1/artists", ["a2"]]]);
    for (const c of spotify.calls) {
      expect(c.signal).toBeInstanceOf(AbortSignal);
      expect(c.signal!.aborted).toBe(false);
    }
    expect(filled.art).toEqual({ t1: cover("t1"), a1: "", t2: cover("t2"), gone1: "", a2: cover("a2") }); // 300px; "" = no image
    expect(filled.topTracks).toBe(data.topTracks);

    await settle();
    expect(await storedCache()).toEqual({ at, art: { t1: cover("t1"), t2: cover("t2"), gone1: "", a1: "", a2: cover("a2") } });
  });

  it("calls only the endpoint that has missing ids", async () => {
    spotify = mockSpotify();
    await fillArt(testEnv(), context().ctx, await home({ t1: "", t2: "", gone1: "", a1: "" }));
    expect(spotify.calls.map((c) => [c.path, c.ids])).toEqual([["/v1/artists", ["a2"]]]);
  });

  it("shows placeholders and writes nothing when a call fails", async () => {
    for (const fail of ["tracks", "artists"] as const) {
      await resetDb(env.DB);
      spotify?.restore();
      spotify = mockSpotify({ fail });
      const { ctx, settle } = context();
      const data = await home({ t1: cover("t1") });
      const filled = await fillArt(testEnv(), ctx, data);
      expect(filled).toBe(data);
      await settle();
      expect(await getState(env.DB, ART_KEY)).toBeNull();
    }
  });

  it("makes no call without a Spotify login or the app's credentials", async () => {
    spotify = mockSpotify();
    const data = await home({});
    const disconnected = { ...data, status: { ...data.status, connected: false } };
    expect(await fillArt(testEnv(), context().ctx, disconnected)).toBe(disconnected);
    expect(await fillArt(testEnv({ SPOTIFY_CLIENT_ID: "" }), context().ctx, data)).toBe(data);
    expect(await fillArt(testEnv({ SPOTIFY_CLIENT_SECRET: "" }), context().ctx, data)).toBe(data);
    expect(spotify.calls).toEqual([]);
  });

  it("keeps the newest 300 entries, the page's ids counting as newest", async () => {
    const old = Object.fromEntries(Array.from({ length: ART_MAX_ENTRIES - 1 }, (_, i) => [`old${i}`, cover(`old${i}`)]));
    const at = NOW - DAY;
    await setState(env.DB, ART_KEY, JSON.stringify({ at, art: { ...old, t1: cover("t1"), a1: cover("a1") } }));
    spotify = mockSpotify();
    const { ctx, settle } = context();
    await fillArt(testEnv(), ctx, await home({ ...old, t1: cover("t1"), a1: cover("a1") }));
    await settle();

    const saved = (await storedCache())!;
    const keys = Object.keys(saved.art);
    expect(saved.at).toBe(at);
    expect(keys).toHaveLength(ART_MAX_ENTRIES);
    // 299 old + t1 + a1 + 3 fetched = 304: the 4 oldest go; t1 and a1 move to the end with the page.
    expect(keys.slice(0, 2)).toEqual(["old4", "old5"]);
    expect(keys.slice(-5)).toEqual(["t1", "t2", "gone1", "a1", "a2"]);
  });

  it("refetches everything on the page once the cache is older than 7 days", async () => {
    await seed([{ id: "s1", name: "Song", artist: ["r1", "Artist"], at: ["2026-10-13T18:00:00Z"] }]);
    await setState(env.DB, ART_KEY, JSON.stringify({ at: NOW - 8 * DAY, art: { s1: "https://i.scdn.co/image/old", r1: "https://i.scdn.co/image/old", other: "" } }));
    spotify = mockSpotify();
    const { ctx, settle } = context();
    const data = await loadHome(env.DB, { now: NOW, timeZone: LA });
    expect(data.art).toEqual({});
    const filled = await fillArt(testEnv(), ctx, data);

    expect(spotify.calls.map((c) => [c.path, c.ids])).toEqual([["/v1/tracks", ["s1"]], ["/v1/artists", ["r1"]]]);
    expect(filled.art).toEqual({ s1: cover("s1"), r1: cover("r1") });
    await settle();
    expect(await storedCache()).toEqual({ at: NOW, art: { s1: cover("s1"), r1: cover("r1") } });

    // The next view is warm: no call.
    spotify.calls.length = 0;
    const warm = await loadHome(env.DB, { now: NOW + 60_000, timeZone: LA });
    expect(await fillArt(testEnv(), context().ctx, warm)).toBe(warm);
    expect(spotify.calls).toEqual([]);
  });

  it("gives up on a request that hangs, at the deadline", async () => {
    spotify = mockSpotify({ hang: true });
    const { ctx, settle } = context();
    const data = await home({});
    expect(await fillArt(testEnv(), ctx, data)).toBe(data);
    expect(spotify.calls.length).toBeGreaterThan(0);
    expect(spotify.calls.every((c) => c.signal?.aborted)).toBe(true);
    await settle();
    expect(await getState(env.DB, ART_KEY)).toBeNull();
  });
});

describe("fillArt: image hosts", () => {
  it("stores an image the CSP wouldn't allow as a placeholder, and drops one from the cache", async () => {
    spotify = mockSpotify({ foreign: true });
    const { ctx, settle } = context();
    const filled = await fillArt(testEnv(), ctx, await home({}));
    await settle();
    expect(filled.art.t1).toBe("");
    expect(filled.art.a1).toBe("");
    expect(Object.values((await storedCache())!.art).every((url) => url === "")).toBe(true);

    await setState(env.DB, ART_KEY, JSON.stringify({ at: NOW, art: { t1: "https://images.example.com/x", t2: cover("t2") } }));
    const cached = await loadHome(env.DB, { now: NOW, timeZone: LA });
    expect(cached.art).toEqual({ t2: cover("t2") });
  });
});
