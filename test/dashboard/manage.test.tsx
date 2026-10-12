// The Manage page (/manage): the Spotify card (via syncState), problems, emails with previews,
// playlists with Recreate, the import card and recent activity. Moved from Home; nothing removed.

import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { handleDashboard } from "../../src/dashboard";
import { manageBody, type ManageView } from "../../src/dashboard/manage";
import { loadStatus } from "../../src/dashboard/status";
import { migrate } from "../../src/db/schema";
import { resetDb } from "../parity/spotify-fixture";
import { ctx, expectSafePage, get, session, settingsReady, stubSettings, testEnv } from "./helpers";

const XSS = `<script>alert("x")</script>`;
const NOW = Date.UTC(2026, 9, 11, 19); // Sun Oct 11 2026, 12:00 PDT

beforeAll(() => migrate(env.DB));
beforeEach(() => resetDb(env.DB));

async function seedHostileData() {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO playlists(playlist_id, name, artist_name, playlist_type) VALUES('pl1', ?1, ?1, 'artist')").bind(`${XSS} This Is`),
    env.DB.prepare("INSERT INTO activity(at, kind, ok, summary, detail) VALUES(?1, 'job', 0, ?2, ?2)").bind(NOW - 60_000, `Track ${XSS}`),
    env.DB.prepare("INSERT INTO state(key, value) VALUES('alert_failing:sync', ?1)").bind(JSON.stringify({ since: NOW - 3_600_000, lastSent: 0, failures: 3, lastError: `Spotify said ${XSS}` })),
    env.DB.prepare("INSERT INTO sync_runs(started_at, finished_at, status, plays_fetched, error) VALUES(datetime('now'), datetime('now'), 'fail', 0, ?1)").bind(XSS),
  ]);
}

const view = async (over: Partial<ManageView> = {}): Promise<ManageView> => ({
  session,
  status: await loadStatus(env.DB, NOW),
  values: stubSettings().values,
  writeMode: "live",
  email: { configured: true, to: "you@example.com" },
  aiAvailable: false,
  importHtml: "",
  ...over,
});

describe("manage page rendering", () => {
  it("shows the cards in order, with Sync now", async () => {
    const html = manageBody(await view({ importHtml: `<section class="card" id="import-card"><h2>Import</h2></section>` }));
    const ids = [...html.matchAll(/<section class="card" id="([^"]+)"/g)].map((m) => m[1]);
    expect(ids).toEqual(["spotify", "emails", "playlists", "import-card", "recent"]);
    expect(html).toMatch(/<form class="inline" method="post" action="\/actions\/sync"><button type="submit" class="btn btn-primary">Sync now<\/button><\/form>/);
    expect(html).toContain(`<a class="btn btn-secondary" href="/activity">All activity</a>`);
  });

  it("escapes Spotify names, activity, errors and the account's name; the import card goes in as built", async () => {
    await seedHostileData();
    const html = manageBody(await view({ session: { ...session, displayName: XSS }, importHtml: "<section class=\"card\" id=\"import\"><b>trusted</b></section>" }));
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("Sync failing");
    expect(html).toContain(`<h2 id="problems-title">Problems</h2><span class="pill pill-bad">1 failing</span>`);
    expect(html).toContain("<b>trusted</b>");
  });

  it("never reads the refresh token's value", async () => {
    const status = await loadStatus(env.DB, NOW);
    expect(status.connected).toBe(true);
    expect(JSON.stringify(status)).not.toContain("test-refresh");
  });

  it("offers Connect without a token and Reconnect when the sync fails on Spotify's login", async () => {
    await env.DB.prepare("INSERT INTO state(key, value) VALUES('alert_failing:sync', ?1)")
      .bind(JSON.stringify({ since: NOW - 3_600_000, lastSent: 0, failures: 2, lastError: "Token refresh failed: 400 invalid_grant" }))
      .run();
    const html = manageBody(await view());
    expect(html).toContain(`<span class="pill pill-bad">Disconnected</span>`);
    expect(html).toContain(`<a class="btn btn-primary" href="/login">Reconnect Spotify</a>`);
    expect(html).toContain(`<button type="submit" class="btn btn-secondary">Sync now</button>`);

    await env.DB.prepare("DELETE FROM state WHERE key = 'spotify_refresh_token'").run();
    const off = manageBody(await view());
    expect(off).toContain(`<a class="btn btn-primary" href="/login">Connect Spotify</a>`);
    expect(off).not.toContain("/actions/sync");
  });

  it("offers Recreate only for an owned playlist that was deleted in Spotify", async () => {
    await env.DB.prepare("INSERT INTO state(key, value) VALUES('playlist:on_this_day', 'off'), ('playlist:forgotten_favorites', 'pl-ff')").run();
    const html = manageBody(await view());
    expect(html.match(/action="\/actions\/playlist\/recreate"/g)).toHaveLength(1);
    expect(html).toContain('value="on_this_day"');
    expect(html).toContain(`aria-label="Recreate On This Day"`);
    expect(html).toContain('href="https://open.spotify.com/playlist/pl-ff"');
  });

  it("lists artist playlists in a <details>, escaped", async () => {
    await env.DB.prepare("INSERT INTO playlists(playlist_id, name, artist_name, playlist_type) VALUES('pl1', ?1, ?1, 'artist')").bind(`${XSS} This Is`).run();
    const html = manageBody(await view());
    expect(html).toContain(`<details><summary>Artist playlists (1)</summary><ul class="tags"><li><a href="https://open.spotify.com/playlist/pl1">&lt;script&gt;`);
  });

  it("hides previews when email isn't set up in live mode and shows AI usage when available", async () => {
    await env.DB.prepare("INSERT INTO state(key, value) VALUES(?1, '3')").bind(`editor:calls:2026-10`).run();
    const html = manageBody(await view({ email: { configured: false, to: null }, aiAvailable: true, values: stubSettings({ aiEditor: true }).values }));
    expect(html).not.toContain("/actions/preview");
    expect(html).toContain("Email isn&#39;t set up");
    expect(html).toContain("3 of 10 AI edits used this month.");
  });

  it("offers a preview of each digest, and shows when the next one goes out", async () => {
    const html = manageBody(await view());
    expect(html).toContain(`aria-label="Send me a preview of the weekly digest"`);
    expect(html).toContain(`aria-label="Send me a preview of the monthly recap"`);
    expect(html).toContain("Next: ");
    const off = manageBody(await view({ values: stubSettings({ digestWeekly: false }).values }));
    expect(off).toContain("Off. Turn it on in Settings.");
  });
});

describe("GET /manage", () => {
  it("needs a session (to the login and back)", async () => {
    const res = (await handleDashboard(get("/manage?ok=synced"), testEnv(), ctx, null))!;
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe(`/login?next=${encodeURIComponent("/manage?ok=synced")}`);
  });

  it.skipIf(!settingsReady)("renders through the router with the security headers, the nav and the flash", async () => {
    await seedHostileData();
    const res = (await handleDashboard(get("/manage?ok=synced"), testEnv(), ctx, session))!;
    expect(res.status).toBe(200);
    const body = await expectSafePage(res);
    expect(body).toContain("<title>Manage · spotify-sync</title>");
    expect(body).toContain(`<a href="/manage" aria-current="page">Manage</a>`);
    expect(body).toContain(`role="status">Sync finished.`);
    for (const id of ["spotify", "problems", "emails", "playlists", "recent"]) expect(body).toContain(`<section class="card" id="${id}"`);
    expect(body).not.toContain("<script>alert");
  });

  it.skipIf(!settingsReady)("ignores unknown flash codes", async () => {
    const body = await (await handleDashboard(get(`/manage?error=${encodeURIComponent(XSS)}`), testEnv(), ctx, session))!.text();
    expect(body).not.toContain(`class="notice`);
    expect(body).not.toContain("alert(");
  });
});
