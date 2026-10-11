// The dashboard router and pages: landing variants, auth gating, CSP/escaping, methods.

import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { handleDashboard, renderPage, ui } from "../../src/dashboard";
import { homeBody, type HomeView } from "../../src/dashboard/home";
import { loadStatus } from "../../src/dashboard/status";
import { migrate } from "../../src/db/schema";
import { resetDb } from "../parity/spotify-fixture";
import { ctx, expectSafePage, fakeBinding, get, ORIGIN, post, session, settingsReady, stubSettings, testEnv } from "./helpers";

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
    expect(body).toContain("Only the owner's Spotify account can log in.");
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
    const res = (await handleDashboard(post(path, { kind: "week", key: "holiday", digestWeekly: "false" }), testEnv(), ctx, null))!;
    expect(res.status).toBe(401);
    const runs = await env.DB.prepare("SELECT COUNT(*) AS n FROM sync_runs").first<{ n: number }>();
    expect(runs!.n).toBe(0);
  });
});

describe("routing", () => {
  it("ignores paths it doesn't own", async () => {
    for (const path of ["/nope", "/import", "/login", "/actions/unknown", "/settings/x"]) {
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
  });
});

describe("renderPage", () => {
  it("escapes the title, marks the current nav item and hides Import when asked", async () => {
    const res = renderPage({ title: XSS, session, nav: "activity", body: "<p>ok</p>", importEnabled: false });
    const body = await expectSafePage(res);
    expect(body).toContain(`<h1>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;</h1>`);
    expect(body).toContain(`<a href="/activity" aria-current="page">Activity</a>`);
    expect(body).not.toContain('href="/import"');
    expect(body).toMatch(/<form class="inline" method="post" action="\/logout">/);
    expect(renderPage({ title: "x", session, body: "" }).headers.get("Content-Type")).toBe("text/html; charset=utf-8");
  });

  it("gives every page a fresh nonce", () => {
    const nonce = (r: Response) => r.headers.get("Content-Security-Policy")!.match(/nonce-([^']+)/)![1];
    expect(nonce(renderPage({ title: "a", session: null, body: "" }))).not.toBe(nonce(renderPage({ title: "a", session: null, body: "" })));
  });

  it("ui helpers escape text but not *Html arguments", () => {
    expect(ui.card(XSS, "<b>trusted</b>", { headHtml: ui.pill("ok", XSS) })).toContain("<b>trusted</b>");
    expect(ui.card(XSS, "")).not.toContain("<script>");
    expect(ui.facts([[XSS, XSS]])).not.toContain("<script>");
    expect(ui.postButton("/actions/preview", XSS, { fields: { kind: `"><script>` } })).not.toContain("<script>");
    expect(ui.notice({ kind: "error", text: XSS })).toContain('role="alert"');
  });
});

describe("home page", () => {
  async function seedHostileData() {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO playlists(playlist_id, name, artist_name, playlist_type) VALUES('pl1', ?1, ?1, 'artist')").bind(`${XSS} This Is`),
      env.DB.prepare("INSERT INTO activity(at, kind, ok, summary, detail) VALUES(?1, 'job', 0, ?2, ?2)").bind(NOW - 60_000, `Track ${XSS}`),
      env.DB.prepare("INSERT INTO state(key, value) VALUES('alert_failing:sync', ?1)").bind(JSON.stringify({ since: NOW - 3_600_000, lastSent: 0, failures: 3, lastError: `Spotify said ${XSS}` })),
      env.DB.prepare("INSERT INTO sync_runs(started_at, finished_at, status, plays_fetched, error) VALUES(datetime('now'), datetime('now'), 'fail', 0, ?1)").bind(XSS),
    ]);
  }

  const view = async (over: Partial<HomeView> = {}): Promise<HomeView> => ({
    session,
    status: await loadStatus(env.DB, NOW),
    values: stubSettings().values,
    writeMode: "live",
    email: { configured: true, to: "you@example.com" },
    aiAvailable: false,
    envPlaylistIds: {},
    importHtml: "",
    ...over,
  });

  it("escapes Spotify names, activity and errors", async () => {
    await seedHostileData();
    const html = homeBody(await view());
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("Sync failing");
  });

  it("never reads the refresh token's value", async () => {
    const status = await loadStatus(env.DB, NOW);
    expect(status.connected).toBe(true);
    expect(JSON.stringify(status)).not.toContain("test-refresh");
  });

  it("asks to reconnect when the sync fails on Spotify's login", async () => {
    await env.DB.prepare("INSERT INTO state(key, value) VALUES('alert_failing:sync', ?1)")
      .bind(JSON.stringify({ since: NOW - 3_600_000, lastSent: 0, failures: 2, lastError: "Token refresh failed: 400 invalid_grant" }))
      .run();
    const html = homeBody(await view());
    expect(html).toContain("Disconnected");
    expect(html).toContain(`<a class="btn btn-primary" href="/login">Reconnect Spotify</a>`);
  });

  it("offers Recreate only for an owned playlist that was deleted in Spotify", async () => {
    await env.DB.prepare("INSERT INTO state(key, value) VALUES('playlist:on_this_day', 'off'), ('playlist:forgotten_favorites', 'pl-ff')").run();
    const html = homeBody(await view());
    expect(html.match(/action="\/actions\/playlist\/recreate"/g)).toHaveLength(1);
    expect(html).toContain('value="on_this_day"');
    expect(html).toContain('href="https://open.spotify.com/playlist/pl-ff"');
  });

  it("hides previews when email isn't set up in live mode and shows AI usage when available", async () => {
    await env.DB.prepare("INSERT INTO state(key, value) VALUES(?1, '3')").bind(`editor:calls:2026-10`).run();
    const html = homeBody(await view({ email: { configured: false, to: null }, aiAvailable: true, values: stubSettings({ aiEditor: true }).values }));
    expect(html).not.toContain("/actions/preview");
    expect(html).toContain("Email isn&#39;t set up");
    expect(html).toContain("3 of 10 AI edits used this month.");
  });

  it.skipIf(!settingsReady)("[integration: WP-B settings] renders through the router with the security headers", async () => {
    await seedHostileData();
    const res = (await handleDashboard(get("/"), testEnv(), ctx, session))!;
    expect(res.status).toBe(200);
    const body = await expectSafePage(res);
    expect(body).not.toContain("<script>alert");
    expect(body).toContain('aria-current="page">Home');
  });
});

describe.skipIf(!settingsReady)("[integration: WP-B settings] settings and activity pages", () => {
  it("render for a stub session with escaped content", async () => {
    await env.DB.prepare("INSERT INTO activity(at, kind, ok, summary, detail) VALUES(?1, 'job', 0, ?2, ?2)").bind(NOW, XSS).run();
    for (const path of ["/settings?welcome=1", "/activity"]) {
      const res = (await handleDashboard(get(path), testEnv(), ctx, session))!;
      expect(res.status).toBe(200);
      const body = await expectSafePage(res);
      expect(body).not.toContain("<script>alert");
    }
  });
});
