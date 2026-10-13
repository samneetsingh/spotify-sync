import { env } from "cloudflare:workers";
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { SpotifyClient, type RetryPolicy } from "../../src/spotify/client";
import { SpotifyError } from "../../src/spotify/errors";
import { migrate } from "../../src/db/schema";

describe("SpotifyClient", () => {
  beforeAll(async () => {
    await migrate(env.DB);
    await env.DB.prepare(
      "INSERT INTO state (key, value) VALUES ('spotify_refresh_token', 'test-refresh-token') ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run();
  });

  it("gates Spotify writes in dry_run mode", async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    const client = new SpotifyClient("id", "secret", env.DB, "dry_run");
    await client.addToPlaylist("playlist123", ["spotify:track:abc"]);
    await client.addToLikedSongs(["trackId123"]);
    await client.createPlaylist({ name: "test" });
    await client.unfollowPlaylist("playlist123");

    console.log = origLog;

    expect(logs).toHaveLength(4);
    expect(JSON.parse(logs[0]!)).toMatchObject({ would_do: "addToPlaylist" });
    expect(JSON.parse(logs[1]!)).toMatchObject({ would_do: "addToLikedSongs" });
    expect(JSON.parse(logs[2]!)).toMatchObject({ would_do: "createPlaylist" });
    expect(JSON.parse(logs[3]!)).toMatchObject({ would_do: "unfollowPlaylist" });
  });

  it("gates Spotify writes in shadow mode", async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    const client = new SpotifyClient("id", "secret", env.DB, "shadow");
    await client.addToPlaylist("playlist123", ["spotify:track:abc"]);

    console.log = origLog;

    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0]!)).toMatchObject({ would_do: "addToPlaylist" });
  });

  describe("5xx retries", () => {
    const original = globalThis.fetch;
    afterEach(() => {
      globalThis.fetch = original;
      vi.restoreAllMocks();
    });

    /** Answers Spotify API calls with `statuses` in order (then 200), and records each "METHOD path". */
    function spotify(statuses: number[]): string[] {
      const calls: string[] = [];
      vi.spyOn(console, "warn").mockImplementation(() => {});
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input instanceof Request ? input.url : input));
        if (url.hostname === "accounts.spotify.com") return Response.json({ access_token: "t", token_type: "Bearer", expires_in: 3600, scope: "" });
        calls.push(`${init?.method ?? "GET"} ${url.pathname}`);
        const status = statuses.shift() ?? 200;
        return status === 200 ? Response.json({ id: "me" }) : new Response(`error code: ${status}`, { status });
      }) as typeof fetch;
      return calls;
    }
    const client = (retry: RetryPolicy) => new SpotifyClient("id", "secret", env.DB, "live", retry);

    it("retries a GET once per delay and returns the first good response", async () => {
      const calls = spotify([502, 503, 500]);
      expect(await client({ delaysMs: [1, 1, 1], budgetMs: Infinity }).getMe()).toEqual({ id: "me" });
      expect(calls).toEqual(["GET /v1/me", "GET /v1/me", "GET /v1/me", "GET /v1/me"]);
    });

    it("gives up after the last delay with the last 5xx", async () => {
      const calls = spotify([502, 502, 502]);
      const err = await client({ delaysMs: [1, 1], budgetMs: Infinity }).getMe().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SpotifyError);
      expect(err).toMatchObject({ status: 502, body: "error code: 502" });
      expect(calls).toHaveLength(3);
    });

    it("retries a POST only once: Spotify may have applied it", async () => {
      const calls = spotify([502, 502]);
      await expect(client({ delaysMs: [1, 1, 1], budgetMs: Infinity }).addToPlaylist("p1", ["spotify:track:a"])).rejects.toMatchObject({ status: 502 });
      expect(calls).toEqual(["POST /v1/playlists/p1/tracks", "POST /v1/playlists/p1/tracks"]);
    });

    it("stops retrying once the client's budget is spent, across requests", async () => {
      const calls = spotify([502, 502, 502]);
      const sp = client({ delaysMs: [5, 5, 5], budgetMs: 7 });
      await expect(sp.getMe()).rejects.toMatchObject({ status: 502 }); // one 5 ms retry; the next would pass 7 ms
      expect(calls).toHaveLength(2);
      await expect(sp.getMe()).rejects.toMatchObject({ status: 502 }); // nothing left: fails at once
      expect(calls).toHaveLength(3);
    });

    it("doesn't retry a 4xx", async () => {
      const calls = spotify([404]);
      await expect(client({ delaysMs: [1], budgetMs: Infinity }).getMe()).rejects.toMatchObject({ status: 404 });
      expect(calls).toHaveLength(1);
    });
  });
});
