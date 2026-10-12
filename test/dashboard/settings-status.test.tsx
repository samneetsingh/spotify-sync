// The settings page's live state: the Spotify card (via syncState), problems, the Advanced-only
// Account card, and the status lines under the settings (digest previews and next sends, playlist
// links and Recreate, artist playlists, AI usage), whose buttons post forms outside the settings form.

import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { handleDashboard } from "../../src/dashboard";
import { settingsBody, type SettingsView } from "../../src/dashboard/settings";
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

const view = async (over: Partial<SettingsView> = {}): Promise<SettingsView> => ({
  session,
  settings: stubSettings(),
  env: testEnv(),
  status: await loadStatus(env.DB, NOW),
  writeMode: "live",
  email: { configured: true, to: "you@example.com" },
  ...over,
});
const page = async (over: Partial<SettingsView> = {}) => settingsBody(await view(over));

describe("settings page status", () => {
  it("puts the settings first and the Spotify card after them, with Sync now; Log out always, the rest of sign-in with Advanced", async () => {
    const html = await page();
    const ids = [...html.matchAll(/<section class="card" id="([^"]+)"/g)].map((m) => m[1]);
    expect(ids).toEqual(["spotify", "account"]);
    expect(html.indexOf(`id="spotify"`)).toBeGreaterThan(html.indexOf(`<form method="post" action="/settings" id="settings"`));
    expect(html).toMatch(/<form class="inline" method="post" action="\/actions\/sync"><button type="submit" class="btn btn-primary">Sync now<\/button><\/form>/);
    expect(html).toContain(`<form class="inline" method="post" action="/logout">`);
    expect(html).not.toContain("/logout/all");
    expect(html).not.toContain(`href="/login?next=%2Fsettings"`);
    const advanced = await page({ settings: stubSettings({ advanced: true }) });
    expect([...advanced.matchAll(/<section class="card" id="([^"]+)"/g)].map((m) => m[1])).toEqual(["spotify", "account"]);
    expect(advanced).toContain(`action="/logout/all"`);
    expect(advanced).toContain(`href="/login?next=%2Fsettings"`);
  });

  it("escapes Spotify names, errors and the account's name; links the problems to Activity only with Advanced", async () => {
    await seedHostileData();
    const html = await page({ session: { ...session, displayName: XSS }, settings: stubSettings({ artistPlaylists: true }) });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("Sync failing");
    expect(html).toContain(`<h2 id="problems-title">Problems</h2><span class="pill pill-bad">1 failing</span>`);
    expect(html.indexOf(`id="problems"`)).toBeLessThan(html.indexOf(`id="spotify"`));
    expect(html).not.toContain(`<a href="/activity"`);
    expect(await page({ settings: stubSettings({ advanced: true }) })).toContain(`<a class="btn btn-secondary" href="/activity">See activity</a>`);
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
    const html = await page();
    expect(html).toContain(`<span class="pill pill-bad">Disconnected</span>`);
    expect(html).toContain(`<a class="btn btn-primary" href="/login">Reconnect Spotify</a>`);
    expect(html).toContain(`<button type="submit" class="btn btn-secondary">Sync now</button>`);

    // The Spotify card moves above the settings while it needs the owner.
    expect(html.indexOf(`id="spotify"`)).toBeLessThan(html.indexOf(`id="settings"`));

    await env.DB.prepare("DELETE FROM state WHERE key = 'spotify_refresh_token'").run();
    const off = await page();
    expect(off.indexOf(`id="spotify"`)).toBeLessThan(off.indexOf(`id="settings"`));
    expect(off).toContain(`<a class="btn btn-primary" href="/login">Connect Spotify</a>`);
    expect(off).not.toContain("/actions/sync");
  });

  it("offers Recreate under a deleted playlist's setting, through a form outside the settings form", async () => {
    await env.DB.prepare("INSERT INTO state(key, value) VALUES('playlist:on_this_day', 'off'), ('playlist:forgotten_favorites', 'pl-ff')").run();
    const html = await page();
    expect(html.match(/action="\/actions\/playlist\/recreate"/g)).toHaveLength(1);
    expect(html).toContain(`<form id="recreate-on_this_day" method="post" action="/actions/playlist/recreate" hidden=""><input type="hidden" name="key" value="on_this_day"/></form>`);
    expect(html.indexOf(`id="recreate-on_this_day"`)).toBeGreaterThan(html.indexOf("</form>"));
    const onThisDay = html.slice(html.indexOf(`id="s-onThisDay"`), html.indexOf(`id="s-forgottenFavorites"`));
    expect(onThisDay).toContain(`<button type="submit" form="recreate-on_this_day" class="btn btn-secondary btn-small" aria-label="Recreate On This Day">Recreate</button>`);
    expect(html).toContain('href="https://open.spotify.com/playlist/pl-ff"');
  });

  it("lists artist playlists in a popover modal opened by a non-submitting button, escaped", async () => {
    await env.DB.prepare("INSERT INTO playlists(playlist_id, name, artist_name, playlist_type) VALUES('pl1', ?1, ?1, 'artist')").bind(`${XSS} This Is`).run();
    const html = await page();
    expect(html).toContain(`<button type="button" class="btn btn-secondary btn-small" popovertarget="artist-playlists">View 1 artist playlist</button>`);
    expect(html).toContain(`<div id="artist-playlists" class="modal" popover="auto" role="dialog" aria-labelledby="artist-playlists-title">`);
    expect(html).toContain(`popovertarget="artist-playlists" popovertargetaction="hide">Close</button>`);
    expect(html).toContain(`<ul class="modal-list"><li><a href="https://open.spotify.com/playlist/pl1">&lt;script&gt;`);
    expect(html).not.toContain("<details>");
  });

  it("hides previews when email isn't set up in live mode and shows AI usage with a key", async () => {
    await env.DB.prepare("INSERT INTO state(key, value) VALUES(?1, '3')").bind(`editor:calls:2026-10`).run();
    const html = await page({ email: { configured: false, to: null }, env: testEnv({ OPENAI_API_KEY: "sk-test" }), settings: stubSettings({ aiEditor: true }) });
    expect(html).not.toContain("/actions/preview");
    expect(html).toContain("Email isn&#39;t set up");
    expect(html).toContain("3 of 10 AI edits used this month.");
  });

  it("offers a preview of each digest that's on, and shows when the next one goes out", async () => {
    const html = await page();
    // The button goes under the "Next:" line (its own row), not beside it.
    expect(html).toContain(`<span>Next: Mon, Oct 12, covering Oct 5–11.</span><div class="status-action"><button type="submit" form="preview-week" class="btn btn-secondary btn-small" aria-label="Send me a preview of the weekly digest">Send me a preview</button></div>`);
    expect(html).toContain(`aria-label="Send me a preview of the monthly recap"`);
    expect(html).toContain(`<form id="preview-week" method="post" action="/actions/preview" hidden=""><input type="hidden" name="kind" value="week"/></form>`);
    expect(html).toContain("Next: Mon, Oct 12, covering Oct 5–11.");
    const off = await page({ settings: stubSettings({ digestWeekly: false }) });
    expect(off).not.toContain(`form="preview-week"`);
  });
});

describe("GET /manage is gone", () => {
  it("isn't a dashboard route any more", async () => {
    expect(await handleDashboard(get("/manage"), testEnv(), ctx, session)).toBeNull();
  });
});

describe.skipIf(!settingsReady)("GET /settings through the router", () => {
  it("renders with the security headers, the nav and an action's flash", async () => {
    await seedHostileData();
    const res = (await handleDashboard(get("/settings?ok=synced"), testEnv(), ctx, session))!;
    expect(res.status).toBe(200);
    const body = await expectSafePage(res);
    expect(body).toMatch(/<a href="\/settings" aria-current="page">(?:(?!<\/a>)[\s\S])*Settings<\/a>/);
    expect(body).not.toContain(`<a href="/activity"`); // Advanced is off: no Activity tab
    expect(body).toContain(`role="status">Sync finished.`);
    for (const id of ["spotify", "problems"]) expect(body).toContain(`<section class="card" id="${id}"`);
    expect(body).not.toContain("<script>alert");
  });

  it("ignores unknown flash codes", async () => {
    const body = await (await handleDashboard(get(`/settings?error=${encodeURIComponent(XSS)}`), testEnv(), ctx, session))!.text();
    expect(body).not.toContain(`class="notice`);
    expect(body).not.toContain("alert(");
  });
});
