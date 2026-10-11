import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getOwner, getSession, SESSION_TTL_MS } from "../../src/auth";
import { createSession, MAX_SESSIONS } from "../../src/auth/session";
import { recentActivity } from "../../src/activity";
import { migrate } from "../../src/db/schema";
import type { Env } from "../../src/env";
import worker from "../../src/index";
import { resetDb } from "../parity/spotify-fixture";
import { NOW, ORIGIN, get, post, setCookies, setStateRow, testCtx, testEnv } from "./helpers";

beforeAll(() => migrate(env.DB));
beforeEach(async () => {
  await resetDb(env.DB);
  await setStateRow("owner:spotify_id", "owner-id");
  await setStateRow("owner:display_name", "Owner Name");
});

/** A session for `spotifyId`, returned as the request's Cookie header. */
async function sessionCookie(spotifyId = "owner-id", now = NOW, e: Env = testEnv()): Promise<string> {
  const setCookie = await createSession(env.DB, e, spotifyId, null, now);
  return setCookie.split(";")[0]!;
}
const count = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions").first<{ n: number }>())!.n;

describe("getOwner", () => {
  it("prefers SPOTIFY_USER_ID, then the claimed pin, else unclaimed", async () => {
    expect(await getOwner(env.DB, testEnv({ SPOTIFY_USER_ID: "configured" }))).toEqual({ id: "configured", source: "config" });
    expect(await getOwner(env.DB, testEnv({ SPOTIFY_USER_ID: "  " }))).toEqual({ id: "owner-id", source: "claimed" });
    await env.DB.prepare("DELETE FROM state WHERE key = 'owner:spotify_id'").run();
    expect(await getOwner(env.DB, testEnv())).toBeNull();
  });
});

describe("getSession", () => {
  it("returns the owner's session until it expires (30 days, absolute)", async () => {
    const cookie = await sessionCookie();
    expect(await getSession(get("/", cookie), testEnv(), NOW + 1)).toEqual({ spotifyId: "owner-id", displayName: "Owner Name", expiresAt: NOW + SESSION_TTL_MS });
    expect(await getSession(get("/", cookie), testEnv(), NOW + SESSION_TTL_MS - 1)).not.toBeNull();
    expect(await getSession(get("/", cookie), testEnv(), NOW + SESSION_TTL_MS)).toBeNull();
  });

  it.each([
    ["no cookie", undefined],
    ["an unknown token", `__Host-session=${"A".repeat(43)}`],
    ["a malformed token", "__Host-session=abc"],
    ["the unprefixed name on an https origin", "session=whatever"],
  ])("is null for %s", async (_label, cookie) => {
    await sessionCookie();
    expect(await getSession(get("/", cookie), testEnv(), NOW)).toBeNull();
  });

  it("rejects sessions of anyone but the effective owner", async () => {
    const old = await sessionCookie("previous-owner");
    expect(await getSession(get("/", old), testEnv(), NOW)).toBeNull();
    // The override wins over the D1 pin.
    const mine = await sessionCookie("owner-id");
    expect(await getSession(get("/", mine), testEnv({ SPOTIFY_USER_ID: "someone-else" }), NOW)).toBeNull();
    expect(await getSession(get("/", old), testEnv({ SPOTIFY_USER_ID: "previous-owner" }), NOW)).not.toBeNull();
    // No owner at all: nobody is logged in.
    await env.DB.prepare("DELETE FROM state WHERE key = 'owner:spotify_id'").run();
    expect(await getSession(get("/", mine), testEnv(), NOW)).toBeNull();
  });

  it("reads the plain cookie name on an http:// dev origin", async () => {
    const dev = testEnv({ PUBLIC_URL: "http://127.0.0.1:8788" });
    const setCookie = await createSession(env.DB, dev, "owner-id", null, NOW);
    expect(setCookie).toMatch(/^session=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=2592000; HttpOnly; SameSite=Lax$/);
    expect(await getSession(get("/", setCookie.split(";")[0]), dev, NOW)).not.toBeNull();
  });
});

describe("createSession", () => {
  it("drops expired sessions and keeps the newest 10", async () => {
    await sessionCookie("owner-id", NOW - SESSION_TTL_MS - 1); // already expired at NOW
    for (let i = 0; i < 12; i++) await sessionCookie("owner-id", NOW + i);
    expect(await count()).toBe(MAX_SESSIONS);
    const oldest = await env.DB.prepare("SELECT MIN(created_at) AS t FROM sessions").first<{ t: number }>();
    expect(oldest!.t).toBe(NOW + 2);
  });
});

describe("logout", () => {
  const ctx = testCtx().ctx;

  it("POST /logout ends this session only and clears the cookie", async () => {
    const mine = await sessionCookie();
    const other = await sessionCookie();
    const res = await worker.fetch(post("/logout", { cookie: mine }), testEnv(), ctx);
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/");
    expect(setCookies(res).get("__Host-session")!.raw).toBe("__Host-session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure");
    expect(await getSession(get("/", mine), testEnv())).toBeNull();
    expect(await getSession(get("/", other), testEnv())).not.toBeNull();
  });

  it("POST /logout without a session still clears the cookie", async () => {
    const res = await worker.fetch(post("/logout"), testEnv(), ctx);
    expect(res.status).toBe(303);
    expect(setCookies(res).get("__Host-session")!.raw).toContain("Max-Age=0");
  });

  it("POST /logout/all ends every session and logs it", async () => {
    const mine = await sessionCookie();
    await sessionCookie();
    await sessionCookie();
    const res = await worker.fetch(post("/logout/all", { cookie: mine }), testEnv(), ctx);
    expect(res.status).toBe(303);
    expect(await count()).toBe(0);
    expect(setCookies(res).get("__Host-session")!.raw).toContain("Max-Age=0");
    expect((await recentActivity(env.DB, 5)).map((a) => [a.kind, a.summary])).toEqual([["account", "Logged out everywhere"]]);
  });

  it("POST /logout/all needs a valid session", async () => {
    await sessionCookie();
    const res = await worker.fetch(post("/logout/all", { cookie: `__Host-session=${"A".repeat(43)}` }), testEnv(), ctx);
    expect(res.status).toBe(401);
    expect(await count()).toBe(1);
  });

  it.each([
    ["no Origin or Sec-Fetch-Site", { Origin: "" }],
    ["another site", { Origin: "https://evil.test" }],
    ["a sibling subdomain", { Origin: "https://evil.sync.test" }],
    ["http instead of https", { Origin: "http://sync.test" }],
    ["a cross-site fetch without Origin", { Origin: "", "Sec-Fetch-Site": "cross-site" }],
    ["a same-site fetch without Origin", { Origin: "", "Sec-Fetch-Site": "same-site" }],
  ])("is refused (403) from %s, logging nobody out", async (_label, headers) => {
    const mine = await sessionCookie();
    const h: Record<string, string> = { Cookie: mine };
    for (const [k, v] of Object.entries(headers)) if (v) h[k] = v;
    for (const path of ["/logout", "/logout/all"]) {
      const res = await worker.fetch(new Request(`${ORIGIN}${path}`, { method: "POST", headers: h }), testEnv(), ctx);
      expect(res.status).toBe(403);
    }
    expect(await count()).toBe(1);
  });

  it("accepts Sec-Fetch-Site: same-origin when the browser sends no Origin", async () => {
    const mine = await sessionCookie();
    const res = await worker.fetch(new Request(`${ORIGIN}/logout`, { method: "POST", headers: { Cookie: mine, "Sec-Fetch-Site": "same-origin" } }), testEnv(), ctx);
    expect(res.status).toBe(303);
    expect(await count()).toBe(0);
  });

  it("only answers POST", async () => {
    const mine = await sessionCookie();
    for (const path of ["/logout", "/logout/all"]) {
      const res = await worker.fetch(get(path, mine), testEnv(), ctx);
      expect(res.status).toBe(405);
      expect(res.headers.get("Allow")).toBe("POST");
    }
    expect(await count()).toBe(1);
  });
});
