import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { handleAuthRoutes } from "../../src/auth";
import { safeNext } from "../../src/auth/oauth";
import { getState } from "../../src/db/state";
import { migrate } from "../../src/db/schema";
import type { Env } from "../../src/env";
import { resetDb } from "../parity/spotify-fixture";
import { NOW, decodeOAuthCookie, get, mockSpotify, setCookies, setStateRow, testCtx, testEnv, toSpotify } from "./helpers";

const original = globalThis.fetch;
beforeAll(() => migrate(env.DB));
beforeEach(async () => {
  await resetDb(env.DB);
  await setStateRow("owner:spotify_id", "owner-id");
});
afterEach(() => void (globalThis.fetch = original));

const route = async (req: Request, e: Env = testEnv(), now = NOW) => (await handleAuthRoutes(req, e, testCtx().ctx, now))!;

describe("safeNext", () => {
  it.each([
    ["/settings", "/settings"],
    ["/activity?page=2#top", "/activity?page=2#top"],
    ["/%2F%2Fevil.test", "/%2F%2Fevil.test"], // stays a path on this origin
    ["/a/../settings", "/settings"],
  ])("keeps the same-origin path %s", (input, expected) => {
    expect(safeNext(input)).toBe(expected);
  });

  it.each([
    [null],
    [""],
    ["settings"],
    ["//evil.test"],
    ["/\\evil.test"],
    ["/\t/evil.test"],
    ["/\n/evil.test"],
    ["https://evil.test/"],
    ["javascript:alert(1)"],
    ["/login?next=/settings"],
    ["/auth/callback?code=x"],
    ["/claim?k=abc"],
    ["/logout"],
    [`/${"a".repeat(600)}`],
  ])("falls back to / for %j", (input) => {
    expect(safeNext(input)).toBe("/");
  });
});

describe("GET /login", () => {
  it("sends the owner to Spotify's login with a state cookie, writing nothing to D1", async () => {
    const before = await env.DB.prepare("SELECT COUNT(*) AS n FROM state").first<{ n: number }>();
    const res = await route(get("/login?next=%2Fsettings"));
    expect(res.status).toBe(302);
    const { authorize, state } = toSpotify(res);
    expect(authorize.origin + authorize.pathname).toBe("https://accounts.spotify.com/authorize");
    expect(Object.fromEntries(authorize.searchParams)).toEqual({
      response_type: "code",
      client_id: "cid",
      scope: "user-read-recently-played playlist-modify-private user-library-modify user-library-read",
      redirect_uri: "https://sync.test/auth/callback",
      state,
      show_dialog: "false",
    });
    expect(state).toMatch(/^[0-9a-f]{64}$/);

    const cookie = setCookies(res).get("__Host-oauth")!;
    expect(cookie.raw).toMatch(/^__Host-oauth=[A-Za-z0-9_-]+; Path=\/; Max-Age=600; HttpOnly; SameSite=Lax; Secure$/);
    const contents = decodeOAuthCookie(cookie.value);
    expect(contents).toMatchObject({ s: state, p: "login", n: "/settings" });
    expect(contents.e).toBe(NOW + 600_000);
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");

    const after = await env.DB.prepare("SELECT COUNT(*) AS n FROM state").first<{ n: number }>();
    expect(after!.n).toBe(before!.n);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions").first<{ n: number }>()).toEqual({ n: 0 });
  });

  it("asks Spotify to show the account picker for switch=1, and sanitizes next", async () => {
    const res = await route(get("/login?switch=1&next=%2F%2Fevil.test"));
    expect(toSpotify(res).authorize.searchParams.get("show_dialog")).toBe("true");
    expect(decodeOAuthCookie(setCookies(res).get("__Host-oauth")!.value).n).toBe("/");
  });

  it("uses a fresh state for every login", async () => {
    const a = toSpotify(await route(get("/login"))).state;
    const b = toSpotify(await route(get("/login"))).state;
    expect(a).not.toBe(b);
  });

  it("works for an owner pinned by SPOTIFY_USER_ID with nothing in D1", async () => {
    await env.DB.prepare("DELETE FROM state WHERE key = 'owner:spotify_id'").run();
    expect((await route(get("/login"), testEnv({ SPOTIFY_USER_ID: "owner-id" }))).status).toBe(302);
  });

  it("goes to the landing page while the instance is unclaimed", async () => {
    await env.DB.prepare("DELETE FROM state WHERE key = 'owner:spotify_id'").run();
    const res = await route(get("/login"));
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/");
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it("explains instead of redirecting when the Spotify app or public URL isn't configured", async () => {
    expect((await route(get("/login"), testEnv({ PUBLIC_URL: undefined }))).status).toBe(503);
    expect((await route(get("/login"), testEnv({ SPOTIFY_CLIENT_SECRET: "" }))).status).toBe(503);
  });

  it("drops __Host- and Secure on an http:// dev origin", async () => {
    const res = await route(get("/login"), testEnv({ PUBLIC_URL: "http://127.0.0.1:8788" }));
    const raw = res.headers.getSetCookie()[0]!;
    expect(raw).toMatch(/^oauth=/);
    expect(raw).not.toContain("Secure");
    expect(new URL(res.headers.get("Location")!).searchParams.get("redirect_uri")).toBe("http://127.0.0.1:8788/auth/callback");
  });

  it("refuses other methods", async () => {
    const res = await route(new Request("https://sync.test/login", { method: "POST" }));
    expect(res.status).toBe(405);
  });
});

describe("GET /auth/callback errors", () => {
  async function started(next = "/") {
    return toSpotify(await route(get(`/login?next=${encodeURIComponent(next)}`)));
  }
  const clearsOAuth = (res: Response) => expect(setCookies(res).get("__Host-oauth")?.raw).toContain("Max-Age=0");

  it("rejects a callback without the state cookie, before calling Spotify", async () => {
    const calls = mockSpotify();
    const { state } = await started();
    const res = await route(get(`/auth/callback?code=abc&state=${state}`));
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("That login took too long");
    clearsOAuth(res);
    expect(calls).toEqual([]);
  });

  it("rejects an expired state cookie", async () => {
    const calls = mockSpotify();
    const { state, cookie } = await started();
    const res = await route(get(`/auth/callback?code=abc&state=${state}`, cookie), testEnv(), NOW + 600_001);
    expect(res.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it.each([
    ["a different state", (s: string) => `state=${s.replace(/^./, s[0] === "a" ? "b" : "a")}&code=abc`],
    ["no state", () => "code=abc"],
    ["an empty state", () => "state=&code=abc"],
  ])("rejects %s with zero Spotify calls", async (_label, query) => {
    const calls = mockSpotify();
    const { state, cookie } = await started();
    const res = await route(get(`/auth/callback?${query(state)}`, cookie));
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("didn&#39;t match");
    clearsOAuth(res);
    expect(calls).toEqual([]);
  });

  it("rejects a tampered or garbage cookie", async () => {
    const calls = mockSpotify();
    const { state } = await started();
    for (const value of ["not-base64!", btoa('{"s":"x","p":"login","e":99999999999999}'), btoa("[]")]) {
      const res = await route(get(`/auth/callback?code=abc&state=${state}`, `__Host-oauth=${value}`));
      expect(res.status).toBe(400);
    }
    expect(calls).toEqual([]);
  });

  it("reports a cancelled login without calling Spotify", async () => {
    const calls = mockSpotify();
    const { state, cookie } = await started();
    const res = await route(get(`/auth/callback?error=access_denied&state=${state}`, cookie));
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Login cancelled");
    expect(calls).toEqual([]);
  });

  it.each([
    ["the code exchange fails (4xx)", { tokenStatus: 400 }],
    ["the code exchange fails (5xx)", { tokenStatus: 503 }],
    ["/me fails", { meStatus: 401 }],
    ["Spotify sends no refresh token", { refreshToken: null }],
  ])("answers 502 when %s, changing nothing", async (_label, opts) => {
    mockSpotify(opts);
    const { state, cookie } = await started();
    const res = await route(get(`/auth/callback?code=abc&state=${state}`, cookie));
    expect(res.status).toBe(502);
    clearsOAuth(res);
    expect(setCookies(res).has("__Host-session")).toBe(false);
    expect(await getState(env.DB, "spotify_refresh_token")).toBe("test-refresh");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions").first<{ n: number }>()).toEqual({ n: 0 });
  });

  it("exchanges the code with the one redirect URI", async () => {
    const calls = mockSpotify();
    const { state, cookie } = await started();
    await route(get(`/auth/callback?code=abc&state=${state}`, cookie));
    expect(calls.map((c) => c.url)).toEqual(["https://accounts.spotify.com/api/token", "https://api.spotify.com/v1/me"]);
    expect(Object.fromEntries(new URLSearchParams(calls[0]!.body))).toEqual({
      grant_type: "authorization_code",
      code: "abc",
      redirect_uri: "https://sync.test/auth/callback",
    });
  });
});
