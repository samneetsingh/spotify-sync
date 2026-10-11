import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureClaimEmail, getSession, handleAuthRoutes } from "../../src/auth";
import { CLAIM_TTL_MS, readClaim } from "../../src/auth/claim";
import { recentActivity } from "../../src/activity";
import { getState } from "../../src/db/state";
import { migrate } from "../../src/db/schema";
import { claimEmail, welcomeEmail } from "../../src/emails/account";
import type { Env } from "../../src/env";
import worker from "../../src/index";
import type { SettingValues } from "../../src/settings";
import { resetDb } from "../parity/spotify-fixture";
import { NOW, ORIGIN, decodeOAuthCookie, fakeEmail, get, mockSpotify, post, setCookies, setStateRow, testCtx, testEnv, toSpotify } from "./helpers";

const original = globalThis.fetch;
beforeAll(() => migrate(env.DB));
beforeEach(() => resetDb(env.DB));
afterEach(() => {
  globalThis.fetch = original;
  vi.restoreAllMocks();
});

const DAY = 86_400_000;
const HOUR = 3_600_000;
const linkIn = (text: string | undefined) => text?.match(/https:\/\/sync\.test\/claim\?k=([0-9a-f]{64})/)?.[1];
const route = async (req: Request, e: Env, now = NOW, ctx = testCtx().ctx) => (await handleAuthRoutes(req, e, ctx, now))!;

describe("ensureClaimEmail (the 10-minute cron)", () => {
  it("emails one single-use link to ALERT_EMAIL_TO, then waits while it's pending", async () => {
    const email = fakeEmail();
    const e = testEnv({ ALERT_EMAIL: email.binding });
    expect(await ensureClaimEmail(e, env.DB, NOW)).toBe("sent");
    expect(await ensureClaimEmail(e, env.DB, NOW + 10 * 60_000)).toBe("pending");
    expect(await ensureClaimEmail(e, env.DB, NOW + CLAIM_TTL_MS - 1)).toBe("pending");

    expect(email.sent).toHaveLength(1);
    const [msg] = email.sent;
    expect(msg!.to).toBe("owner@example.com");
    expect(msg!.subject).toBe("[spotify-sync] Connect your Spotify to finish setup");
    const nonce = linkIn(msg!.text)!;
    expect(nonce).toBeDefined();
    expect(msg!.html).toContain(`https://sync.test/claim?k=${nonce}`);
    expect(msg!.subject).not.toContain(nonce);
    expect(await readClaim(env.DB)).toEqual({ nonce, expires: NOW + CLAIM_TTL_MS, sentAt: NOW, autoSends: 1, resends: { day: "", count: 0 } });
    expect((await recentActivity(env.DB, 5)).map((a) => [a.kind, a.summary])).toEqual([["email", "Sent the setup link to the owner's email"]]);
  });

  it("sends a new link after the old one expires, and stops after 3 automatic sends", async () => {
    const email = fakeEmail();
    const e = testEnv({ ALERT_EMAIL: email.binding });
    const results = [];
    for (let i = 0; i < 5; i++) results.push(await ensureClaimEmail(e, env.DB, NOW + i * (CLAIM_TTL_MS + 1)));
    expect(results).toEqual(["sent", "sent", "sent", "pending", "pending"]);
    const nonces = email.sent.map((m) => linkIn(m.text));
    expect(new Set(nonces).size).toBe(3);
    expect((await readClaim(env.DB))!.autoSends).toBe(3);
  });

  it("does nothing once there is an owner, claimed or pinned by SPOTIFY_USER_ID", async () => {
    const email = fakeEmail();
    expect(await ensureClaimEmail(testEnv({ ALERT_EMAIL: email.binding, SPOTIFY_USER_ID: "owner-id" }), env.DB, NOW)).toBe("owned");
    await setStateRow("owner:spotify_id", "owner-id");
    expect(await ensureClaimEmail(testEnv({ ALERT_EMAIL: email.binding }), env.DB, NOW)).toBe("owned");
    expect(email.sent).toEqual([]);
    expect(await getState(env.DB, "claim")).toBeNull();
  });

  it.each<[string, Partial<Env>]>([
    ["no email binding", { ALERT_EMAIL: undefined }],
    ["no sender", { ALERT_FROM: "" }],
    ["no recipient", { ALERT_EMAIL_TO: "" }],
    ["no public URL", { PUBLIC_URL: "" }],
    ["an invalid public URL", { PUBLIC_URL: "not a url" }],
    ["no Spotify client id", { SPOTIFY_CLIENT_ID: "" }],
    ["no Spotify client secret", { SPOTIFY_CLIENT_SECRET: "" }],
  ])("sends nothing with %s (a link that can't work)", async (_label, overrides) => {
    const email = fakeEmail();
    expect(await ensureClaimEmail(testEnv({ ALERT_EMAIL: email.binding, ...overrides }), env.DB, NOW)).toBe("unconfigured");
    expect(email.sent).toEqual([]);
    expect(await getState(env.DB, "claim")).toBeNull();
  });

  it("saves the claim only when the email went out, so the next run retries", async () => {
    expect(await ensureClaimEmail(testEnv({ ALERT_EMAIL: fakeEmail({ fail: true }).binding }), env.DB, NOW)).toBe("failed");
    expect(await getState(env.DB, "claim")).toBeNull();
    const email = fakeEmail();
    expect(await ensureClaimEmail(testEnv({ ALERT_EMAIL: email.binding }), env.DB, NOW + 600_000)).toBe("sent");
    expect((await readClaim(env.DB))!.autoSends).toBe(1);
  });

  it("sends one link when runs overlap (parallel cron invocations)", async () => {
    const email = fakeEmail();
    const e = testEnv({ ALERT_EMAIL: email.binding });
    const results = await Promise.all(Array.from({ length: 4 }, () => ensureClaimEmail(e, env.DB, NOW)));
    expect(results.filter((r) => r === "sent")).toHaveLength(1);
    expect(results.filter((r) => r === "pending")).toHaveLength(3);
    expect(email.sent).toHaveLength(1);
    expect(linkIn(email.sent[0]!.text)).toBe((await readClaim(env.DB))!.nonce);
    expect((await readClaim(env.DB))!.autoSends).toBe(1);
  });

  it("never logs the link", async () => {
    const lines: string[] = [];
    for (const level of ["log", "warn", "error", "info", "debug"] as const) vi.spyOn(console, level).mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(" ")));
    const email = fakeEmail();
    await ensureClaimEmail(testEnv({ ALERT_EMAIL: email.binding }), env.DB, NOW);
    const nonce = linkIn(email.sent[0]!.text)!;
    expect(lines.join("\n")).not.toContain(nonce);
  });
});

describe("POST /claim/resend", () => {
  async function sentAt(t: number, email = fakeEmail()) {
    await ensureClaimEmail(testEnv({ ALERT_EMAIL: email.binding }), env.DB, t);
    return email;
  }

  it("sends nothing within an hour of the last email, and says when that one went out", async () => {
    await sentAt(NOW);
    const email = fakeEmail();
    const res = await route(post("/claim/resend"), testEnv({ ALERT_EMAIL: email.binding }), NOW + HOUR - 1);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Check your email");
    expect(body).toContain("Sun, Oct 11, 5:00 AM PDT"); // NOW in the deploy's time zone
    expect(email.sent).toEqual([]);
  });

  it("resends after an hour, reusing the link while it has more than a day left", async () => {
    const first = await sentAt(NOW);
    const email = fakeEmail();
    const e = testEnv({ ALERT_EMAIL: email.binding });
    expect((await route(post("/claim/resend"), e, NOW + HOUR)).status).toBe(200);
    expect(linkIn(email.sent[0]!.text)).toBe(linkIn(first.sent[0]!.text));
    expect(await readClaim(env.DB)).toMatchObject({ expires: NOW + CLAIM_TTL_MS, sentAt: NOW + HOUR, autoSends: 1, resends: { day: "2026-10-11", count: 1 } });

    // Less than a day left: a fresh 7-day link.
    await route(post("/claim/resend"), e, NOW + CLAIM_TTL_MS - HOUR);
    expect(linkIn(email.sent[1]!.text)).not.toBe(linkIn(first.sent[0]!.text));
    expect((await readClaim(env.DB))!.expires).toBe(NOW + 2 * CLAIM_TTL_MS - HOUR);
  });

  it("sends at most 5 a day (UTC), then again the next day", async () => {
    const start = Date.UTC(2026, 9, 11, 0, 30);
    const email = fakeEmail();
    const e = testEnv({ ALERT_EMAIL: email.binding });
    for (let i = 0; i < 7; i++) await route(post("/claim/resend"), e, start + i * (HOUR + 1));
    expect(email.sent).toHaveLength(5);
    await route(post("/claim/resend"), e, Date.UTC(2026, 9, 12, 0, 5));
    expect(email.sent).toHaveLength(6);
  });

  it("can't be raced past the limits: parallel requests send one email", async () => {
    await sentAt(NOW);
    const email = fakeEmail();
    const e = testEnv({ ALERT_EMAIL: email.binding });
    const results = await Promise.all(Array.from({ length: 6 }, () => route(post("/claim/resend"), e, NOW + HOUR)));
    expect(results.map((r) => r.status)).toEqual(Array(6).fill(200));
    expect(email.sent).toHaveLength(1);
    expect((await readClaim(env.DB))!.resends).toEqual({ day: "2026-10-11", count: 1 });
  });

  it("keeps the previous link and limits when the resend email fails", async () => {
    await sentAt(NOW);
    const before = await getState(env.DB, "claim");
    const res = await route(post("/claim/resend"), testEnv({ ALERT_EMAIL: fakeEmail({ fail: true }).binding }), NOW + HOUR);
    expect(res.status).toBe(503);
    expect(await getState(env.DB, "claim")).toBe(before);
    const email = fakeEmail();
    expect((await route(post("/claim/resend"), testEnv({ ALERT_EMAIL: email.binding }), NOW + HOUR)).status).toBe(200);
    expect(email.sent).toHaveLength(1);
  });

  it("works after the 3 automatic sends ran out", async () => {
    const e = testEnv({ ALERT_EMAIL: fakeEmail().binding });
    for (let i = 0; i < 3; i++) await ensureClaimEmail(e, env.DB, NOW + i * (CLAIM_TTL_MS + 1));
    const later = NOW + 3 * (CLAIM_TTL_MS + 1);
    expect(await ensureClaimEmail(e, env.DB, later)).toBe("pending");
    const email = fakeEmail();
    await route(post("/claim/resend"), testEnv({ ALERT_EMAIL: email.binding }), later);
    expect(email.sent).toHaveLength(1);
    expect((await readClaim(env.DB))!.expires).toBe(later + CLAIM_TTL_MS);
  });

  it("goes to the landing page once the instance is claimed", async () => {
    await setStateRow("owner:spotify_id", "owner-id");
    const email = fakeEmail();
    const res = await route(post("/claim/resend"), testEnv({ ALERT_EMAIL: email.binding }));
    expect(res.status).toBe(303);
    expect(email.sent).toEqual([]);
  });

  it("is Origin-checked by the router and refuses GET", async () => {
    const email = fakeEmail();
    const e = testEnv({ ALERT_EMAIL: email.binding });
    const ctx = testCtx().ctx;
    expect((await worker.fetch(post("/claim/resend", { headers: { Origin: "https://evil.test" } }), e, ctx)).status).toBe(403);
    expect((await worker.fetch(new Request(`${ORIGIN}/claim/resend`, { method: "POST" }), e, ctx)).status).toBe(403);
    expect((await worker.fetch(get("/claim/resend"), e, ctx)).status).toBe(405);
    expect(email.sent).toEqual([]);
    expect((await worker.fetch(post("/claim/resend"), e, ctx)).status).toBe(200);
    expect(email.sent).toHaveLength(1);
  });
});

describe("GET /claim", () => {
  async function pendingNonce(t = NOW) {
    const email = fakeEmail();
    await ensureClaimEmail(testEnv({ ALERT_EMAIL: email.binding }), env.DB, t);
    return linkIn(email.sent[0]!.text)!;
  }

  it("sends a valid link to Spotify with the account picker, consuming nothing", async () => {
    const nonce = await pendingNonce();
    const res = await route(get(`/claim?k=${nonce}`), testEnv());
    expect(res.status).toBe(302);
    const { authorize, cookie } = toSpotify(res);
    expect(authorize.searchParams.get("show_dialog")).toBe("true");
    expect(authorize.searchParams.get("redirect_uri")).toBe("https://sync.test/auth/callback");
    expect(decodeOAuthCookie(cookie.split("=")[1]!)).toMatchObject({ p: "claim", k: nonce, s: authorize.searchParams.get("state") });
    expect((await readClaim(env.DB))!.nonce).toBe(nonce);
  });

  it.each([
    ["no nonce", () => "/claim"],
    ["a wrong nonce", () => `/claim?k=${"0".repeat(64)}`],
    ["a malformed nonce", () => "/claim?k=abc"],
  ])("404s %s, offering a new link", async (_label, path) => {
    await pendingNonce();
    const res = await route(get(path()), testEnv());
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).toContain("This setup link doesn&#39;t work anymore");
    expect(body).toContain('action="/claim/resend"');
  });

  it("404s an expired link", async () => {
    const nonce = await pendingNonce();
    expect((await route(get(`/claim?k=${nonce}`), testEnv(), NOW + CLAIM_TTL_MS)).status).toBe(404);
  });

  it("404s every link once the instance has an owner, without the resend form", async () => {
    const nonce = await pendingNonce();
    await setStateRow("owner:spotify_id", "owner-id");
    const res = await route(get(`/claim?k=${nonce}`), testEnv());
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("/claim/resend");
  });
});

describe("claiming through /auth/callback", () => {
  async function startClaim(e = testEnv(), t = NOW) {
    const email = fakeEmail();
    await ensureClaimEmail(testEnv({ ALERT_EMAIL: email.binding }), env.DB, t);
    const nonce = linkIn(email.sent[0]!.text)!;
    return { nonce, ...toSpotify(await route(get(`/claim?k=${nonce}`), e, t)) };
  }

  it("end to end: pins the owner, saves the token, clears the claim, logs in and sends the welcome email", async () => {
    const email = fakeEmail();
    const e = testEnv({ ALERT_EMAIL: email.binding });
    // The cron sends the link; the owner opens it from the email.
    expect(await ensureClaimEmail(e, env.DB)).toBe("sent");
    const nonce = linkIn(email.sent[0]!.text)!;
    const toLogin = await worker.fetch(get(`/claim?k=${nonce}`), e, testCtx().ctx);
    expect(toLogin.status).toBe(302);
    const { state, cookie } = toSpotify(toLogin);

    const calls = mockSpotify({ account: "new-owner", displayName: "Robin" });
    const run = testCtx();
    const res = await worker.fetch(get(`/auth/callback?code=abc&state=${state}`, cookie, { "User-Agent": "Phone" }), e, run.ctx);
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/settings?welcome=1");
    expect(calls.map((c) => c.url)).toEqual(["https://accounts.spotify.com/api/token", "https://api.spotify.com/v1/me"]);

    expect(await getState(env.DB, "owner:spotify_id")).toBe("new-owner");
    expect(await getState(env.DB, "owner:display_name")).toBe("Robin");
    expect(await getState(env.DB, "spotify_refresh_token")).toBe("new-refresh-token");
    expect(await getState(env.DB, "claim")).toBeNull();

    const token = setCookies(res).get("__Host-session")!.value;
    expect(await getSession(get("/", `__Host-session=${token}`), e)).toMatchObject({ spotifyId: "new-owner", displayName: "Robin" });

    await run.settle();
    expect(email.sent.map((m) => m.subject)).toEqual(["[spotify-sync] Connect your Spotify to finish setup", "[spotify-sync] You're connected"]);
    expect(email.sent[1]!.text).toContain("Robin (new-owner)");
    expect(email.sent[1]!.text).toContain("Open your dashboard: https://sync.test/");
    const summaries = (await recentActivity(env.DB, 10)).map((a) => a.summary);
    expect(summaries).toContain("Set up spotify-sync for Robin (new-owner)");
    expect(summaries).toContain("Sent the welcome email");

    // The link was single use, and logging in now works for the new owner only.
    expect((await worker.fetch(get(`/claim?k=${nonce}`), e, testCtx().ctx)).status).toBe(404);
    expect((await worker.fetch(get("/login"), e, testCtx().ctx)).status).toBe(302);
  });

  it("refuses a link that expired between opening it and finishing the Spotify login", async () => {
    const { state, cookie } = await startClaim();
    mockSpotify({ account: "new-owner" });
    const res = await route(get(`/auth/callback?code=abc&state=${state}`, cookie), testEnv(), NOW + CLAIM_TTL_MS);
    expect(res.status).toBe(400);
    expect(await getState(env.DB, "owner:spotify_id")).toBeNull();
    expect(setCookies(res).has("__Host-session")).toBe(false);
  });

  it("keeps the link usable when the login is cancelled or Spotify fails", async () => {
    const { nonce, state, cookie } = await startClaim();
    expect((await route(get(`/auth/callback?error=access_denied&state=${state}`, cookie), testEnv())).status).toBe(400);
    expect((await readClaim(env.DB))!.nonce).toBe(nonce);
    const again = toSpotify(await route(get(`/claim?k=${nonce}`), testEnv()));
    mockSpotify({ tokenStatus: 500 });
    expect((await route(get(`/auth/callback?code=abc&state=${again.state}`, again.cookie), testEnv())).status).toBe(502);
    expect((await readClaim(env.DB))!.nonce).toBe(nonce);
    expect(await getState(env.DB, "owner:spotify_id")).toBeNull();
  });

  it("lets only one account win a race (409 for the other)", async () => {
    const a = await startClaim();
    const b = toSpotify(await route(get(`/claim?k=${a.nonce}`), testEnv()));
    mockSpotify({ accounts: { "code-a": "account-a", "code-b": "account-b" } });
    const [ra, rb] = await Promise.all([
      route(get(`/auth/callback?code=code-a&state=${a.state}`, a.cookie), testEnv()),
      route(get(`/auth/callback?code=code-b&state=${b.state}`, b.cookie), testEnv()),
    ]);
    const statuses = [ra.status, rb.status].sort();
    expect(statuses).toEqual([303, 409]);
    const winner = ra.status === 303 ? "account-a" : "account-b";
    expect(await getState(env.DB, "owner:spotify_id")).toBe(winner);
    expect((await env.DB.prepare("SELECT spotify_id FROM sessions").all()).results).toEqual([{ spotify_id: winner }]);
  });

  it("gives 409 when someone else claimed it first, without touching the token", async () => {
    const { state, cookie } = await startClaim();
    await setStateRow("owner:spotify_id", "first-owner");
    mockSpotify({ account: "second" });
    const res = await route(get(`/auth/callback?code=abc&state=${state}`, cookie), testEnv());
    expect(res.status).toBe(409);
    expect(await getState(env.DB, "spotify_refresh_token")).toBe("test-refresh");
  });

  it("just logs in the owner who already finished setup in another tab", async () => {
    const first = await startClaim();
    const second = toSpotify(await route(get(`/claim?k=${first.nonce}`), testEnv()));
    mockSpotify({ account: "new-owner" });
    expect((await route(get(`/auth/callback?code=abc&state=${first.state}`, first.cookie), testEnv())).status).toBe(303);
    const res = await route(get(`/auth/callback?code=abc&state=${second.state}`, second.cookie), testEnv());
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/");
    expect(setCookies(res).has("__Host-session")).toBe(true);
  });

  it("refuses an account other than SPOTIFY_USER_ID if the override appeared mid-claim", async () => {
    const { state, cookie } = await startClaim();
    mockSpotify({ account: "someone" });
    const res = await route(get(`/auth/callback?code=abc&state=${state}`, cookie), testEnv({ SPOTIFY_USER_ID: "owner-id" }));
    expect(res.status).toBe(403);
    expect(await getState(env.DB, "owner:spotify_id")).toBeNull();
  });
});

describe("account emails", () => {
  const settings: SettingValues = {
    liked: false,
    frequent: true,
    frequentMinPlays: 5,
    artistPlaylists: true,
    hindiFavorites: false,
    onThisDay: true,
    forgottenFavorites: true,
    holiday: true,
    alerts: true,
    digestWeekly: true,
    digestMonthly: false,
    aiEditor: false,
    timeZone: "America/Los_Angeles",
  };

  it("claim: the host, a button that works once for 7 days, and a reassuring note", () => {
    const m = claimEmail({ publicUrl: "https://spotify.example.com", link: "https://spotify.example.com/claim?k=abc" });
    expect(m.subject).toBe("[spotify-sync] Connect your Spotify to finish setup");
    expect(m.text).toContain("spotify-sync is running at spotify.example.com");
    expect(m.text).toContain("Connect Spotify: https://spotify.example.com/claim?k=abc");
    expect(m.html).toContain("Works once, for 7 days.");
    expect(m.html).toContain("Almost ready");
    expect(m.text).toContain("nothing happens unless the link is used");
  });

  it("welcome: account, schedule, what's on (Liked Songs spelled out), dashboard link and the import tip; escaped", () => {
    const m = welcomeEmail({ publicUrl: "https://spotify.example.com", account: { id: "x1", displayName: "<Robin>" }, settings });
    expect(m.subject).toBe("[spotify-sync] You're connected");
    expect(m.html).toContain("&lt;Robin&gt; (x1)");
    expect(m.html).not.toContain("<Robin>");
    expect(m.text).toContain("Liked Songs: Off. When on, every track you play is added to your Liked Songs");
    expect(m.text).toContain("Frequent Plays: On: songs with 5+ plays");
    expect(m.text).toContain("Monthly recap: Off");
    expect(m.text).toContain("Syncs: Every 10 minutes");
    expect(m.html).toContain('href="https://spotify.example.com/"');
    expect(m.text).toContain("Extended streaming history");

    const on = welcomeEmail({ publicUrl: "https://spotify.example.com", account: { id: "x1", displayName: null }, settings: { ...settings, liked: true } });
    expect(on.text).toContain("Liked Songs: On: every track you play is added to your Liked Songs");
    const unknown = welcomeEmail({ publicUrl: "https://spotify.example.com", account: { id: "x1", displayName: null }, settings: null });
    expect(unknown.text).toContain("See Settings on the dashboard");
  });
});
