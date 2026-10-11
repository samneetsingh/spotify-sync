import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getState, setState } from "../src/db/state";
import { migrate } from "../src/db/schema";
import type { Env } from "../src/env";
import worker from "../src/index";
import { RECONNECT_TTL_MS, handleReconnect, reconnectLink } from "../src/reconnect";
import { resetDb } from "./parity/spotify-fixture";

const NOW = Date.UTC(2026, 9, 11, 12);
const testEnv = (overrides: Partial<Env> = {}): Env =>
  ({
    ...(env as unknown as Env),
    PUBLIC_URL: "https://sync.test",
    SPOTIFY_USER_ID: "test-user",
    SPOTIFY_CLIENT_ID: "cid",
    SPOTIFY_CLIENT_SECRET: "csecret",
    ...overrides,
  }) as Env;
const get = (path: string) => new Request(`https://sync.test${path}`);

/** Spotify's token endpoint and /me, recording what was asked. */
function mockSpotifyLogin(opts: { account?: string; tokenStatus?: number; refreshToken?: string | null } = {}) {
  const calls: Array<{ url: string; body?: string }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: init?.body ? String(init.body) : undefined });
    if (url === "https://accounts.spotify.com/api/token") {
      if (opts.tokenStatus && opts.tokenStatus !== 200) return new Response('{"error":"invalid_grant"}', { status: opts.tokenStatus });
      const refresh = opts.refreshToken === undefined ? "new-refresh-token" : opts.refreshToken;
      return Response.json({ access_token: "access", token_type: "Bearer", expires_in: 3600, scope: "", ...(refresh ? { refresh_token: refresh } : {}) });
    }
    if (url === "https://api.spotify.com/v1/me") return Response.json({ id: opts.account ?? "test-user", display_name: "Test User" });
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;
  return calls;
}

const original = globalThis.fetch;
beforeAll(() => migrate(env.DB));
beforeEach(async () => {
  await resetDb(env.DB);
  await setState(env.DB, "spotify_refresh_token", "old-token");
});
afterEach(() => void (globalThis.fetch = original));

async function pendingNonce(): Promise<string> {
  const link = await reconnectLink(env.DB, "https://sync.test", NOW);
  return new URL(link).searchParams.get("k")!;
}

async function callback(query: string, onConnected = () => {}) {
  return (await handleReconnect(get(`/reconnect/callback?${query}`), testEnv(), onConnected, NOW))!;
}

describe("GET /reconnect", () => {
  it("sends a valid link to Spotify's login with the nonce as state", async () => {
    const nonce = await pendingNonce();
    const res = (await handleReconnect(get(`/reconnect?k=${nonce}`), testEnv(), () => {}, NOW))!;
    expect(res.status).toBe(302);
    const login = new URL(res.headers.get("Location")!);
    expect(login.origin + login.pathname).toBe("https://accounts.spotify.com/authorize");
    expect(login.searchParams.get("state")).toBe(nonce);
    expect(login.searchParams.get("client_id")).toBe("cid");
    expect(login.searchParams.get("redirect_uri")).toBe("https://sync.test/reconnect/callback");
    expect(login.searchParams.get("scope")).toContain("user-read-recently-played");
  });

  it.each([
    ["no nonce", "/reconnect"],
    ["a wrong nonce", `/reconnect?k=${"0".repeat(64)}`],
  ])("404s %s", async (_label, path) => {
    await pendingNonce();
    const res = (await handleReconnect(get(path), testEnv(), () => {}, NOW))!;
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("link doesn&#39;t work anymore");
  });

  it("404s an expired link, and everything when no public URL or account is configured", async () => {
    const nonce = await pendingNonce();
    expect((await handleReconnect(get(`/reconnect?k=${nonce}`), testEnv(), () => {}, NOW + RECONNECT_TTL_MS + 1))!.status).toBe(404);
    expect((await handleReconnect(get(`/reconnect?k=${nonce}`), testEnv({ PUBLIC_URL: "" }), () => {}, NOW))!.status).toBe(404);
    expect((await handleReconnect(get(`/reconnect?k=${nonce}`), testEnv({ SPOTIFY_USER_ID: "" }), () => {}, NOW))!.status).toBe(404);
  });

  it("ignores other paths", async () => {
    expect(await handleReconnect(get("/sync-full"), testEnv(), () => {}, NOW)).toBeNull();
  });
});

describe("GET /reconnect/callback", () => {
  it("saves the new refresh token for the right account, once", async () => {
    const nonce = await pendingNonce();
    const calls = mockSpotifyLogin();
    let connected = 0;
    const res = await callback(`code=abc&state=${nonce}`, () => connected++);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("You&#39;re reconnected");
    expect(await getState(env.DB, "spotify_refresh_token")).toBe("new-refresh-token");
    expect(await getState(env.DB, "reconnect")).toBeNull();
    expect(connected).toBe(1);
    expect(new URLSearchParams(calls[0]!.body)).toEqual(
      new URLSearchParams({ grant_type: "authorization_code", code: "abc", redirect_uri: "https://sync.test/reconnect/callback" }),
    );

    expect((await callback(`code=abc&state=${nonce}`)).status).toBe(404); // single use
  });

  it("refuses a different Spotify account and keeps the link usable", async () => {
    const nonce = await pendingNonce();
    mockSpotifyLogin({ account: "someone-else" });
    const res = await callback(`code=abc&state=${nonce}`);
    expect(res.status).toBe(403);
    expect(await getState(env.DB, "spotify_refresh_token")).toBe("old-token");
    expect(await getState(env.DB, "reconnect")).not.toBeNull();
  });

  it("keeps the link when the login is cancelled or Spotify fails", async () => {
    const nonce = await pendingNonce();
    expect((await callback(`error=access_denied&state=${nonce}`)).status).toBe(400);
    mockSpotifyLogin({ tokenStatus: 400 });
    expect((await callback(`code=abc&state=${nonce}`)).status).toBe(502);
    mockSpotifyLogin({ refreshToken: null });
    expect((await callback(`code=abc&state=${nonce}`)).status).toBe(502);
    expect(await getState(env.DB, "spotify_refresh_token")).toBe("old-token");
    expect(await getState(env.DB, "reconnect")).not.toBeNull();
  });

  it("404s a wrong state without calling Spotify", async () => {
    await pendingNonce();
    const calls = mockSpotifyLogin();
    expect((await callback(`code=abc&state=${"f".repeat(64)}`)).status).toBe(404);
    expect(calls).toEqual([]);
  });
});

it("routes /reconnect through the Worker's fetch handler", async () => {
  const nonce = await pendingNonce();
  const res = await worker.fetch(get(`/reconnect?k=${nonce}`), testEnv(), {} as ExecutionContext);
  expect(res.status).toBe(302);
  expect((await worker.fetch(get("/reconnect"), testEnv(), {} as ExecutionContext)).status).toBe(404);
});
