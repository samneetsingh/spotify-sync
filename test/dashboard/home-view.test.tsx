// The Home view: every fixture renders safely (escaped text, no style= attributes, a CSP-clean page),
// each chart carries its summary and numbers table, headings go h1 (the shell's) -> h2 -> h3, and
// each empty state shows up where its data is missing.

import { describe, expect, it } from "vitest";
import type { HomeData } from "../../src/dashboard/home-data";
import { HomeView, type HomeViewProps } from "../../src/dashboard/home-view";
import { renderPage } from "../../src/dashboard/layout";
import { render } from "../../src/dashboard/render";
import { FIXTURES, fullHome, NOW } from "./fixtures/home";
import { expectSafePage, session, stubSettings } from "./helpers";

const XSS = `<script>alert("x")</script>`;
const ESCAPED = "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;";

const view = (data: HomeData, props: Partial<Omit<HomeViewProps, "data">> = {}) =>
  render(<HomeView data={data} settings={stubSettings().values} aiAvailable={false} writeMode="live" {...props} />);

/** Heading levels in document order. */
const headings = (html: string) => [...html.matchAll(/<h([1-6])[\s>]/g)].map((m) => Number(m[1]));

describe("HomeView", () => {
  it("renders every fixture as a safe page: CSP nonce, no style=, one h1, headings in order", async () => {
    for (const [name, make] of Object.entries(FIXTURES)) {
      const res = renderPage({ title: "Home", session, nav: "home", layout: "wide", hideTitle: true, body: view(make()) });
      const body = await expectSafePage(res);
      expect(body, name).toContain(`<main id="main" class="wide hide-title"><h1>Home</h1><div class="home`);
      const levels = headings(body);
      expect(levels[0], name).toBe(1);
      expect(levels.filter((l) => l === 1), name).toHaveLength(1);
      for (let i = 1; i < levels.length; i++) expect(levels[i]! - levels[i - 1]!, `${name}: h${levels[i - 1]} -> h${levels[i]}`).toBeLessThanOrEqual(1);
      expect(levels.slice(1).every((l) => l >= 2), name).toBe(true);
    }
  });

  it("escapes every Spotify- and digest-supplied value", () => {
    const data = fullHome();
    const t = { ...data.topTracks[0]!, name: XSS, artists: XSS };
    const out = view({
      ...data,
      songOfWeek: { track: t, lastWeek: false },
      topTracks: [t, ...data.topTracks.slice(1)],
      topArtists: [{ ...data.topArtists[0]!, name: XSS }],
      genres: [{ genre: XSS, plays: 3 }],
      newToYou: { ...data.newToYou, newArtists: [{ id: "a", name: XSS, plays: 1 }] },
      throwbacks: [{ year: 2025, track: t }],
      digests: { ...data.digests, last: { kind: "week", subject: XSS, period: XSS, sentAt: NOW - 86_400_000 } },
      art: { [t.id]: `https://i.scdn.co/image/x"><script>` },
    });
    expect(out).not.toContain("<script");
    expect(out.split(ESCAPED).length - 1).toBeGreaterThanOrEqual(10);
    expect(out).toContain(`src="https://i.scdn.co/image/x&quot;&gt;&lt;script&gt;"`);
  });

  it("gives every chart a summary sentence and a numbers table", () => {
    const out = view(fullHome());
    const charts = out.split(`<figure class="chart`).slice(1);
    expect(charts).toHaveLength(4); // week, month, year, the heatmap
    for (const c of charts) {
      const fig = c.slice(0, c.indexOf("</figure>"));
      expect(fig).toMatch(/aria-label="[^"]{12,}"/);
      expect(fig).toContain(`<details class="numbers"><summary>Show the numbers</summary><div class="table-wrap"><table>`);
    }
    expect(out).toMatch(/aria-label="This week: [\d,]+ plays so far, most on \w{3}, Oct \d+ \(\d+\)\."/);
    expect(out).toMatch(/aria-label="The last 12 months: [\d,]+ plays, most in \w+ \d{4} \([\d,]+\)\."/);
  });

  it("shows the song of the week on the record, with the week and month tiles", () => {
    const out = view(fullHome());
    expect(out).toContain(`<a href="https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC">Midnight City</a>`);
    expect(out).toContain(`class="vinyl-cover" src="https://i.scdn.co/image/`);
    expect(out).toContain(`<h2 id="week-title">This week so far</h2>`);
    expect(out).toContain(`<h2 id="month-title">October so far</h2>`);
    expect(out.match(/<div class="tile">/g)).toHaveLength(8);
    expect(out).toContain(`<a class="chip chip-ok" href="/manage">Connected, synced 4 min ago</a>`);
    expect(out).not.toContain(`class="banner"`);
  });

  it("an empty instance: the first-sync hero, no charts, the next digest date and the settings", () => {
    const out = view(FIXTURES.empty());
    expect(out).toContain(`<div class="home is-new">`);
    expect(out).toContain("No plays yet");
    expect(out).toContain("Your first sync runs within 10 minutes.");
    expect(out).toContain(`<span class="vinyl-cover vinyl-blank"></span>`);
    expect(out).not.toContain(`<figure class="chart`);
    expect(out).toContain("No digest yet. The first one goes out Mon, Oct 12.");
    expect(out).toContain(`id="settings"`);
  });

  it("not connected: the hero offers to connect Spotify (once; no banner saying the same)", () => {
    const out = view(FIXTURES["not-connected"]());
    expect(out).toContain(`<a class="chip chip-bad" href="/manage">Not connected</a>`);
    expect(out).toContain(`<a class="btn btn-primary" href="/login">Connect Spotify</a>`);
    expect(out).not.toContain(`class="banner"`);
    expect(out.match(/Connect Spotify/g)).toHaveLength(1);
  });

  it("not connected with plays already saved: the banner offers to connect", () => {
    const data = fullHome();
    const out = view({ ...data, status: { ...data.status, connected: false } });
    expect(out).toContain(`<a class="banner-action" href="/login">Connect Spotify</a>`);
    expect(out).toContain("Midnight City");
  });

  it("a login error: the red banner asks to reconnect", () => {
    const out = view(FIXTURES["login-error"]());
    expect(out).toContain(`<a class="chip chip-bad" href="/manage">Disconnected</a>`);
    expect(out).toContain(`<a class="banner-action" href="/login">Reconnect Spotify</a>`);
  });

  it("a failing job other than the sync: the banner names it and links to the problems", () => {
    const out = view(FIXTURES["failing-job"]());
    expect(out).toContain("Artist playlists is failing.");
    expect(out).toContain(`href="/manage#problems"`);
  });

  it("a quiet week shows zeros, not a blank chart, and last week's song", () => {
    const out = view(FIXTURES["quiet-week"]());
    expect(out).toContain(`<span class="hero-when">From last week</span>`);
    expect(out).toContain(`aria-label="This week: no plays yet."`);
    const weekChart = out.slice(out.indexOf(`id="days-week-panel"`), out.indexOf(`id="days-month-panel"`));
    expect(weekChart.match(/class="col-zero"/g)!.length).toBeGreaterThanOrEqual(4);
    expect(out).toContain(`<dd class="tile-value num">0</dd>`);
    expect(out).toContain("Play something today to start one.");
  });

  it("no art: placeholder tiles everywhere, the apricot label on the record", () => {
    const out = view(FIXTURES["no-art"]());
    expect(out).not.toContain("i.scdn.co");
    expect(out).toContain(`<span class="vinyl-cover vinyl-blank"></span>`);
    expect(out.match(/art-missing/g)!.length).toBeGreaterThanOrEqual(7);
    expect(out).toContain(`class="avatar avatar-blank`);
  });

  it("no artist details: empty states for artists and genres, tracks still listed", () => {
    const out = view(FIXTURES["no-metadata"]());
    expect(out).toContain("No artist details yet");
    expect(out).toContain("No genres yet");
    expect(out).toContain(`<ol class="tracks">`);
  });

  it("the settings widget: switches post their key, Liked off links to Settings, AI editor only with a key", () => {
    const off = view(fullHome());
    expect(off).toContain(`<a href="/settings#s-liked">Turn on in Settings</a>`);
    expect(off).not.toContain(`value="aiEditor"`);
    const on = view(fullHome(), { settings: stubSettings({ liked: true, digestWeekly: false }).values, aiAvailable: true });
    expect(on).toContain(`<input type="hidden" name="key" value="liked"/><input type="hidden" name="value" value="false"/>`);
    expect(on).toContain(`<input type="hidden" name="key" value="digestWeekly"/><input type="hidden" name="value" value="true"/>`);
    expect(on).toContain(`value="aiEditor"`);
  });

  it("the emails widget: the latest digest, the next sends (Off when switched off), and dry-run wording", () => {
    const out = view(fullHome(), { settings: stubSettings({ digestMonthly: false }).values, writeMode: "dry_run" });
    expect(out).toContain("Your week: 284 plays, led by “Blinding Lights”");
    expect(out).toContain("Weekly digest for Sep 28 – Oct 4, sent Mon, Oct 5 (4 days ago)");
    expect(out).toContain(`<dt>Weekly digest</dt><dd>Mon, Oct 12<span class="sub">Covers Oct 5–11</span></dd>`);
    expect(out).toContain(`<dt>Monthly recap</dt><dd><span class="muted">Off</span></dd>`);
    expect(out).toContain("Dry run: digests are written to the Worker log");
    expect(out).toContain(`<span class="pill pill-neutral">Dry run</span>`);
  });
});
