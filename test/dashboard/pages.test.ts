// The dashboard router and pages: landing variants, auth gating, CSP/escaping, methods, and the
// Activity page behind the Advanced setting. The settings page's status parts are in
// settings-status.test.tsx.

import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { handleDashboard, renderPage } from "../../src/dashboard";
import { migrate } from "../../src/db/schema";
import { resetDb } from "../parity/spotify-fixture";
import { ctx, expectSafePage, fakeBinding, get, ORIGIN, post, session, settingsReady, testEnv } from "./helpers";

const XSS = `<script>alert("x")</script>`;
const NOW = Date.UTC(2026, 9, 11, 19); // Sun Oct 11 2026, 12:00 PDT

beforeAll(() => migrate(env.DB));
beforeEach(() => resetDb(env.DB));

const unclaimed = (over = {}) => testEnv({ SPOTIFY_USER_ID: "", ALERT_EMAIL: fakeBinding().binding, ...over });

describe("landing page (no session)", () => {
  it("offers Spotify login once the instance has an owner, without naming the owner", async () => {
    await env.DB.prepare("INSERT INTO state(key, value) VALUES('owner:spotify_id', 'owner-1'), ('owner:display_name', 'Sam Owner')").run();
    const res = (await handleDashboard(get("/"), unclaimed(), ctx, null))!;
    expect(res.status).toBe(200);
    const body = await expectSafePage(res);
    expect(body).toContain('href="/login"');
    expect(body).toContain("Log in with Spotify");
    expect(body).toContain("Only the owner&#39;s Spotify account can log in.");
    expect(body).not.toContain("Sam Owner");
    expect(body).not.toContain("owner-1");
    expect(body).not.toContain('aria-label="Dashboard"'); // no nav for visitors
  });

  it("counts a deploy-pinned owner as claimed", async () => {
    const body = await (await handleDashboard(get("/"), testEnv({ SPOTIFY_USER_ID: "test-user" }), ctx, null))!.text();
    expect(body).toContain("Log in with Spotify");
    expect(body).not.toContain("test-user");
  });

  it("says a setup link was emailed, with a resend form, while unclaimed", async () => {
    const body = await expectSafePage((await handleDashboard(get("/"), unclaimed(), ctx, null))!);
    expect(body).toContain("<h1>Almost ready</h1>");
    expect(body).toMatch(/<form method="post" action="\/claim\/resend">/);
    expect(body).not.toContain('href="/login"');
  });

  it("says setup isn't finished when the claim email can't work", async () => {
    for (const missing of [{ ALERT_EMAIL: undefined }, { ALERT_FROM: "" }, { PUBLIC_URL: "" }, { SPOTIFY_CLIENT_SECRET: "" }]) {
      const body = await (await handleDashboard(get("/"), unclaimed(missing), ctx, null))!.text();
      expect(body).toContain("<h1>Still being set up</h1>");
      expect(body).not.toContain("/claim/resend");
    }
  });

  it("shows known flash codes and ignores unknown ones (no user text from the URL)", async () => {
    const e = testEnv();
    const out = await (await handleDashboard(get("/?ok=logged-out"), e, ctx, null))!.text();
    expect(out).toContain(`role="status">You&#39;re logged out.`);
    const weird = await (await handleDashboard(get(`/?ok=${encodeURIComponent(XSS)}&error=nope`), e, ctx, null))!.text();
    expect(weird).not.toContain(`class="notice`);
    expect(weird).not.toContain("alert(");
  });
});

describe("owner pages without a session", () => {
  it.each(["/settings", "/activity"])("GET %s redirects to the login and back", async (path) => {
    const res = (await handleDashboard(get(`${path}?welcome=1`), testEnv(), ctx, null))!;
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe(`/login?next=${encodeURIComponent(`${path}?welcome=1`)}`);
  });

  it.each(["/settings", "/actions/sync", "/actions/preview", "/actions/playlist/recreate"])("POST %s is refused with 401 and changes nothing", async (path) => {
    const res = (await handleDashboard(post(path, { kind: "week", key: "digestWeekly", value: "false", digestWeekly: "false" }), testEnv(), ctx, null))!;
    expect(res.status).toBe(401);
    const runs = await env.DB.prepare("SELECT COUNT(*) AS n FROM sync_runs").first<{ n: number }>();
    expect(runs!.n).toBe(0);
    const settings = await env.DB.prepare("SELECT COUNT(*) AS n FROM settings").first<{ n: number }>();
    expect(settings!.n).toBe(0);
  });
});

describe("routing", () => {
  it("ignores paths it doesn't own", async () => {
    for (const path of ["/nope", "/import", "/login", "/actions/unknown", "/settings/x", "/manage", "/home"]) {
      expect(await handleDashboard(get(path), testEnv(), ctx, session)).toBeNull();
    }
  });

  it("answers the wrong method with 405 and an Allow header", async () => {
    const getAction = (await handleDashboard(get("/actions/sync"), testEnv(), ctx, session))!;
    expect(getAction.status).toBe(405);
    expect(getAction.headers.get("Allow")).toBe("POST");
    const postHome = (await handleDashboard(post("/"), testEnv(), ctx, session))!;
    expect(postHome.status).toBe(405);
    expect(postHome.headers.get("Allow")).toBe("GET, HEAD");
    const del = (await handleDashboard(new Request(`${ORIGIN}/settings`, { method: "DELETE" }), testEnv(), ctx, session))!;
    expect(del.headers.get("Allow")).toBe("GET, HEAD, POST");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM settings").first<{ n: number }>()).toEqual({ n: 0 });
    const postActivity = (await handleDashboard(post("/activity"), testEnv(), ctx, session))!;
    expect(postActivity.status).toBe(405);
    expect(postActivity.headers.get("Allow")).toBe("GET, HEAD");
  });
});

describe("renderPage", () => {
  it("escapes the title, marks the current nav item, and has no Import item (it lives in Settings)", async () => {
    const res = renderPage({ title: XSS, session, nav: "activity", body: "<p>ok</p>", showActivity: true });
    const body = await expectSafePage(res);
    expect(body).toContain(`<h1>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;</h1>`);
    expect(body).toMatch(/<a href="\/activity" aria-current="page">(?:(?!<\/a>)[\s\S])*Activity<\/a>/);
    expect(body).not.toContain('href="/import"');
    expect(body).not.toContain(`action="/logout"`); // in Settings, not the shell
    expect(renderPage({ title: "x", session, body: "" }).headers.get("Content-Type")).toBe("text/html; charset=utf-8");
  });

  it("gives every page a fresh nonce", () => {
    const nonce = (r: Response) => r.headers.get("Content-Security-Policy")!.match(/nonce-([^']+)/)![1];
    expect(nonce(renderPage({ title: "a", session: null, body: "" }))).not.toBe(nonce(renderPage({ title: "a", session: null, body: "" })));
  });
});

describe("home page", () => {
  it("renders the new Home with the flash and the status chip; no Spotify call without art to fetch", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (() => Promise.reject(new Error("unexpected fetch"))) as typeof fetch;
    try {
      const res = (await handleDashboard(get("/?ok=saved"), testEnv(), ctx, session))!;
      expect(res.status).toBe(200);
      const body = await expectSafePage(res);
      expect(body).toMatch(/aria-current="page">(?:(?!<\/a>)[\s\S])*Home<\/a>/);
      expect(body).toContain("<h1>Home</h1>");
      expect(body).toContain(`role="status">Settings saved.`);
      expect(body).not.toContain('id="settings"');
      expect(body).toContain('href="/settings"');
      expect(body).not.toContain('<a href="/activity"');
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe.skipIf(!settingsReady)("[integration: WP-B settings] every page", () => {
  it("renders for a stub session with escaped content and no style= attributes", async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO activity(at, kind, ok, summary, detail) VALUES(?1, 'job', 0, ?2, ?2)").bind(NOW, XSS),
      env.DB.prepare("INSERT INTO sync_runs(started_at, finished_at, status, plays_fetched, error) VALUES(datetime('now'), datetime('now'), 'fail', 0, ?1)").bind(XSS),
      env.DB.prepare("INSERT INTO playlists(playlist_id, name, artist_name, playlist_type) VALUES('pl1', ?1, ?1, 'artist')").bind(XSS),
      env.DB.prepare("INSERT INTO settings(key, value, updated_at) VALUES('advanced', 'true', datetime('now'))"), // the Activity page
    ]);
    const evil = { ...session, displayName: XSS };
    for (const path of ["/", "/settings?welcome=1", "/activity"]) {
      const res = (await handleDashboard(get(path), testEnv(), ctx, evil))!;
      expect(res.status).toBe(200);
      const body = await expectSafePage(res);
      expect(body).not.toContain("<script>alert");
    }
  });

  it("shows the Activity page and its nav item only with the Advanced setting on", async () => {
    const e = testEnv({ SETTINGS: "{}" });
    const off = (await handleDashboard(get("/activity"), e, ctx, session))!;
    expect(off.status).toBe(303);
    expect(off.headers.get("Location")).toBe("/settings#s-advanced");
    expect(await (await handleDashboard(get("/settings"), e, ctx, session))!.text()).not.toContain('<a href="/activity"');

    await env.DB.prepare("INSERT INTO settings(key, value, updated_at) VALUES('advanced', 'true', datetime('now'))").run();
    const on = (await handleDashboard(get("/activity"), e, ctx, session))!;
    expect(on.status).toBe(200);
    expect(await on.text()).toMatch(/<a href="\/activity" aria-current="page">(?:(?!<\/a>)[\s\S])*Activity<\/a>/);
    for (const path of ["/", "/settings"]) expect(await (await handleDashboard(get(path), e, ctx, session))!.text()).toMatch(/<a href="\/activity">(?:(?!<\/a>)[\s\S])*Activity<\/a>/);
  });

  it("renders every landing state without style= attributes", async () => {
    const states = [testEnv({ SPOTIFY_USER_ID: "owner-1" }), unclaimed(), unclaimed({ ALERT_EMAIL: undefined })];
    const titles: string[] = [];
    for (const e of states) titles.push((await expectSafePage((await handleDashboard(get("/"), e, ctx, null))!)).match(/<h1>([^<]+)<\/h1>/)![1]);
    expect(titles).toEqual(["Your music, kept in sync", "Almost ready", "Still being set up"]);
  });
});
