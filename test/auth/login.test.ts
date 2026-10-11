import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getSession, handleAuthRoutes } from "../../src/auth";
import { recentActivity } from "../../src/activity";
import { getState } from "../../src/db/state";
import { migrate } from "../../src/db/schema";
import type { Env } from "../../src/env";
import worker from "../../src/index";
import { resetDb } from "../parity/spotify-fixture";
import { NOW, fakeEmail, get, mockSpotify, setCookies, setStateRow, sha256Hex, testCtx, testEnv, toSpotify, type SpotifyMockOptions } from "./helpers";

const original = globalThis.fetch;
beforeAll(() => migrate(env.DB));
beforeEach(async () => {
  await resetDb(env.DB);
  await setStateRow("owner:spotify_id", "owner-id");
});
afterEach(() => void (globalThis.fetch = original));

/** Runs /login?next= then the callback as `account`; returns the callback's response and its ctx. */
async function logIn(opts: SpotifyMockOptions & { next?: string; env?: Env; userAgent?: string } = {}) {
  const e = opts.env ?? testEnv();
  const start = await handleAuthRoutes(get(`/login${opts.next === undefined ? "" : `?next=${encodeURIComponent(opts.next)}`}`), e, testCtx().ctx, NOW);
  const { state, cookie } = toSpotify(start!);
  const calls = mockSpotify(opts);
  const run = testCtx();
  const res = (await handleAuthRoutes(get(`/auth/callback?code=abc&state=${state}`, cookie, opts.userAgent ? { "User-Agent": opts.userAgent } : {}), e, run.ctx, NOW))!;
  return { res, calls, ...run };
}

const sessionCount = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions").first<{ n: number }>())!.n;

describe("login as the owner", () => {
  it("starts a session, saves the new refresh token and returns to next", async () => {
    const { res, waits } = await logIn({ next: "/settings?x=1", userAgent: "Test Browser" });
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/settings?x=1");

    const cookies = setCookies(res);
    expect(cookies.get("__Host-oauth")!.raw).toContain("Max-Age=0");
    const session = cookies.get("__Host-session")!;
    expect(session.raw).toMatch(/^__Host-session=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=2592000; HttpOnly; SameSite=Lax; Secure$/);

    const row = await env.DB.prepare("SELECT token_hash, spotify_id, created_at, expires_at, user_agent FROM sessions").first();
    expect(row).toEqual({ token_hash: await sha256Hex(session.value), spotify_id: "owner-id", created_at: NOW, expires_at: NOW + 30 * 86_400_000, user_agent: "Test Browser" });
    expect(JSON.stringify(row)).not.toContain(session.value); // only the hash is stored

    expect(await getState(env.DB, "spotify_refresh_token")).toBe("new-refresh-token");
    expect(await getState(env.DB, "owner:display_name")).toBe("Owner Name");
    expect(waits).toEqual([]); // sync isn't failing: no immediate sync

    const fromCookie = await getSession(get("/", `__Host-session=${session.value}`), testEnv(), NOW + 1000);
    expect(fromCookie).toEqual({ spotifyId: "owner-id", displayName: "Owner Name", expiresAt: NOW + 30 * 86_400_000 });

    const [event] = await recentActivity(env.DB, 5);
    expect(event).toMatchObject({ kind: "account", ok: true, summary: "Logged in as Owner Name (owner-id)" });
  });

  it.each([["//evil.test"], ["/\\evil.test"], ["https://evil.test"], ["/login"]])("never redirects off-site or back into auth (next=%s)", async (next) => {
    const { res } = await logIn({ next });
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/");
  });

  it("pins the owner in D1 under the SPOTIFY_USER_ID override, so the var can be removed later", async () => {
    await env.DB.prepare("DELETE FROM state WHERE key = 'owner:spotify_id'").run();
    const e = testEnv({ SPOTIFY_USER_ID: "owner-id" });
    const { res } = await logIn({ env: e });
    expect(res.status).toBe(303);
    expect(await getState(env.DB, "owner:spotify_id")).toBe("owner-id");

    // Without the var the same session stays valid: the pin now names the owner.
    const token = setCookies(res).get("__Host-session")!.value;
    expect(await getSession(get("/", `__Host-session=${token}`), testEnv(), NOW)).not.toBeNull();
  });

  it("replaces a stale pin when the override names a different account", async () => {
    await setStateRow("owner:spotify_id", "old-owner");
    await logIn({ env: testEnv({ SPOTIFY_USER_ID: "owner-id" }) });
    expect(await getState(env.DB, "owner:spotify_id")).toBe("owner-id");
  });

  it("falls back to the account id when Spotify has no display name", async () => {
    await logIn({ displayName: null });
    expect(await getState(env.DB, "owner:display_name")).toBe("owner-id");
  });

  it("keeps at most 10 sessions, newest first", async () => {
    for (let i = 0; i < 12; i++) await logIn();
    expect(await sessionCount()).toBe(10);
  });
});

describe("login with another account", () => {
  it("is refused: no session, the refresh token is unchanged, and it offers to switch accounts", async () => {
    const { res } = await logIn({ account: "someone-else", displayName: "<b>Someone</b>", next: "/activity" });
    expect(res.status).toBe(403);
    const body = await res.text();
    expect(body).toContain("That&#39;s a different Spotify account");
    expect(body).toContain("&lt;b&gt;Someone&lt;/b&gt;"); // escaped
    expect(body).toContain('href="/login?switch=1&amp;next=%2Factivity"');
    expect(setCookies(res).has("__Host-session")).toBe(false);
    expect(setCookies(res).get("__Host-oauth")!.raw).toContain("Max-Age=0");
    expect(await sessionCount()).toBe(0);
    expect(await getState(env.DB, "spotify_refresh_token")).toBe("test-refresh");
    expect(await getState(env.DB, "owner:display_name")).toBeNull();
  });

  it("is refused under the SPOTIFY_USER_ID override even if D1 names that account", async () => {
    await setStateRow("owner:spotify_id", "someone-else");
    const { res } = await logIn({ account: "someone-else", env: testEnv({ SPOTIFY_USER_ID: "owner-id" }) });
    expect(res.status).toBe(403);
    expect(await sessionCount()).toBe(0);
  });

  it("goes to the landing page if the instance became unclaimed during the login", async () => {
    const e = testEnv();
    const { state, cookie } = toSpotify((await handleAuthRoutes(get("/login"), e, testCtx().ctx, NOW))!);
    await env.DB.prepare("DELETE FROM state WHERE key = 'owner:spotify_id'").run();
    mockSpotify();
    const res = (await handleAuthRoutes(get(`/auth/callback?code=abc&state=${state}`, cookie), e, testCtx().ctx, NOW))!;
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/");
    expect(await sessionCount()).toBe(0);
  });
});

describe("reconnect (log in while sync is failing)", () => {
  it("syncs right away with the new token; its success clears the failure and sends the recovered email", async () => {
    const email = fakeEmail();
    await setStateRow("alert_failing:sync", JSON.stringify({ since: NOW - 3_600_000, lastSent: NOW - 3_600_000, failures: 4, lastError: "invalid_grant" }));
    const { res, waits, settle, calls } = await logIn({ env: testEnv({ ALERT_EMAIL: email.binding }) });
    expect(res.status).toBe(303);
    expect(waits).toHaveLength(1);
    await settle();

    expect(await getState(env.DB, "alert_failing:sync")).toBeNull();
    expect(email.sent.map((m) => m.subject)).toEqual(["[spotify-sync] sync recovered"]);
    // The sync refreshed the token it was just given.
    const refresh = calls.find((c) => c.url === "https://accounts.spotify.com/api/token" && c.body?.includes("grant_type=refresh_token"));
    expect(new URLSearchParams(refresh!.body).get("refresh_token")).toBe("new-refresh-token");
    expect((await recentActivity(env.DB, 5)).map((a) => a.summary)).toContain("Logged in as Owner Name (owner-id) and reconnected Spotify");
  });

  it("doesn't sync when only another job is failing", async () => {
    await setStateRow("alert_failing:artist-playlists", JSON.stringify({ since: NOW, lastSent: NOW, failures: 1 }));
    const { waits } = await logIn();
    expect(waits).toEqual([]);
  });
});

describe("legacy reconnect links", () => {
  const ctx = {} as ExecutionContext;

  it("send /reconnect?k= (already-sent alert emails) to /login", async () => {
    const res = await worker.fetch(get(`/reconnect?k=${"a".repeat(64)}`), testEnv(), ctx);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/login");
  });

  it("no longer serve /reconnect/callback", async () => {
    const res = await worker.fetch(get("/reconnect/callback?code=x&state=y"), testEnv(), ctx);
    expect(res.status).toBe(404);
  });
});

describe("through the Worker's fetch handler", () => {
  it("routes /login and /auth/callback", async () => {
    const e = testEnv();
    const start = await worker.fetch(get("/login?next=%2Factivity"), e, testCtx().ctx);
    expect(start.status).toBe(302);
    const { state, cookie } = toSpotify(start);
    mockSpotify();
    const res = await worker.fetch(get(`/auth/callback?code=abc&state=${state}`, cookie), e, testCtx().ctx);
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/activity");
    expect(setCookies(res).has("__Host-session")).toBe(true);
  });
});
