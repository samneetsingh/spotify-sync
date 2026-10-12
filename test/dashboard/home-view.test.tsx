// The Home view: every fixture renders safely (escaped text, no style= attributes, a CSP-clean page),
// each chart carries its summary sentence, headings go h1 (the shell's) -> h2 -> h3, and
// each empty state shows up where its data is missing.

import { describe, expect, it } from "vitest";
import type { HomeData } from "../../src/dashboard/home-data";
import { HomeView, type HomeViewProps } from "../../src/dashboard/home-view";
import { renderPage } from "../../src/dashboard/layout";
import { render } from "../../src/dashboard/render";
import { FIXTURES, fullHome } from "./fixtures/home";
import { expectSafePage, session } from "./helpers";

const XSS = `<script>alert("x")</script>`;
const ESCAPED = "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;";

const view = (data: HomeData, props: Partial<Omit<HomeViewProps, "data">> = {}) =>
  render(<HomeView data={data} writeMode="live" {...props} />);

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

  it("escapes every Spotify-supplied value", () => {
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
      art: { [t.id]: `https://i.scdn.co/image/x"><script>` },
    });
    expect(out).not.toContain("<script");
    expect(out.split(ESCAPED).length - 1).toBeGreaterThanOrEqual(8);
    expect(out).toContain(`src="https://i.scdn.co/image/x&quot;&gt;&lt;script&gt;"`);
  });

  it("gives every chart a summary sentence and no numbers table", () => {
    const out = view(fullHome());
    const charts = out.split(`<figure class="chart`).slice(1);
    expect(charts).toHaveLength(4); // week, month, year, the heatmap
    for (const c of charts) {
      const fig = c.slice(0, c.indexOf("</figure>"));
      expect(fig).toMatch(/aria-label="[^"]{12,}"/);
      expect(fig).not.toMatch(/<details|<table/);
    }
    // Year over year: this year's total, then the earlier years' (the fixture has five years of plays).
    expect(out).toMatch(/aria-label="This week so far: [\d,]+ plays\. The same week in 2025: [\d,]+, 2024: [\d,]+, 2023: [\d,]+, 2022: [\d,]+\."/);
    expect(out).toMatch(/aria-label="The last 30 days: [\d,]+ plays\. The same dates in 2025: [\d,]+, /);
    expect(out).toMatch(/aria-label="2026 so far: [\d,]+ plays\. The years before: 2025: [\d,]+, /);
    // The legend runs oldest to newest, one toggle per year.
    const legend = out.slice(out.indexOf(`<fieldset class="lc-legend">`), out.indexOf("</fieldset>", out.indexOf(`<fieldset class="lc-legend">`)));
    expect([...legend.matchAll(/<span class="lg-label">(\d+)<\/span>/g)].map((m) => m[1])).toEqual(["2022", "2023", "2024", "2025", "2026"]);
  });

  it("shows the song of the week with its cover, and the week and month tiles with their icons", () => {
    const out = view(fullHome());
    expect(out).toContain(`<a href="https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC">Midnight City</a>`);
    expect(out).toContain(`<div class="hero-cover" aria-hidden="true"><img src="https://i.scdn.co/image/`);
    expect(out).toContain(`<h2 id="week-title">This week so far</h2>`);
    expect(out).toContain(`<h2 id="month-title">October so far</h2>`);
    expect(out.match(/<div class="tile">/g)).toHaveLength(8);
    expect(out.match(/<dd class="tile-icon" aria-hidden="true">/g)).toHaveLength(8);
    expect(out).toContain(`<a class="chip chip-ok" href="/settings#spotify">Connected, synced 4 min ago</a>`);
    expect(out).not.toContain(`class="banner"`);
  });

  it("an empty instance: the first-sync hero and nothing else", () => {
    const out = view(FIXTURES.empty());
    expect(out).toContain(`<div class="home is-new">`);
    expect(out).toContain("No plays yet");
    expect(out).toContain("Your first sync runs within 10 minutes.");
    expect(out).toContain(`<div class="hero-cover" aria-hidden="true"></div>`);
    expect(out).not.toContain(`<figure class="chart`);
    expect(out.match(/<section /g)).toHaveLength(1);
  });

  it("not connected: the hero offers to connect Spotify (once; no banner saying the same)", () => {
    const out = view(FIXTURES["not-connected"]());
    expect(out).toContain(`<a class="chip chip-bad" href="/settings#spotify">Not connected</a>`);
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
    expect(out).toContain(`<a class="chip chip-bad" href="/settings#spotify">Disconnected</a>`);
    expect(out).toContain(`<a class="banner-action" href="/login">Reconnect Spotify</a>`);
  });

  it("a failing job other than the sync: the banner names it and links to the problems", () => {
    const out = view(FIXTURES["failing-job"]());
    expect(out).toContain("Artist playlists is failing.");
    expect(out).toContain(`href="/settings#problems"`);
  });

  it("a quiet week shows zeros, not a blank chart, and last week's song", () => {
    const out = view(FIXTURES["quiet-week"]());
    expect(out).toContain(`<span class="hero-when">From last week</span>`);
    expect(out).toMatch(/aria-label="This week so far: 0 plays\. The same week in 2025: /);
    // This week's line runs flat along the baseline up to today, not missing.
    const weekChart = out.slice(out.indexOf(`id="days-week-panel"`), out.indexOf(`id="days-month-panel"`));
    expect(weekChart).toMatch(/<path class="ln ln-0" d="M[\d.]+,308C/);
    expect(out).toContain(`<dd class="tile-value num">0</dd>`);
    expect(out).toContain("Play something today to start one.");
  });

  it("no art: placeholder tiles everywhere, the empty hero cover", () => {
    const out = view(FIXTURES["no-art"]());
    expect(out).not.toContain("i.scdn.co");
    expect(out).toContain(`<div class="hero-cover" aria-hidden="true"></div>`);
    expect(out.match(/art-missing/g)!.length).toBeGreaterThanOrEqual(7);
    expect(out).toContain(`class="avatar avatar-blank`);
  });

  it("no artist details: empty states for artists and genres, tracks still listed", () => {
    const out = view(FIXTURES["no-metadata"]());
    expect(out).toContain("No artist details yet");
    expect(out).toContain("No genres yet");
    expect(out).toContain(`<ol class="tracks">`);
  });

  it("has no settings or emails widgets (those live in Settings and Manage), and says when it's a dry run", () => {
    const out = view(fullHome(), { writeMode: "dry_run" });
    expect(out).not.toMatch(/<form|id="settings"|id="emails"/);
    expect(out).toContain(`<span class="pill pill-neutral">Dry run</span>`);
  });
});

describe("HomeView art lookups", () => {
  it("renders a track whose id names an Object member (e.g. from an imported export) with the placeholder", () => {
    const data = fullHome();
    const odd = { ...data.topTracks[0]!, id: "constructor" };
    const out = view({ ...data, art: {}, songOfWeek: { track: odd, lastWeek: false }, topTracks: [odd], throwbacks: [{ year: 2021, track: { ...odd, id: "toString" } }] });
    expect(out).not.toContain("function");
    expect(out).not.toMatch(/src="(?!\/)(?!https:)/);
  });
});

describe("HomeView streak", () => {
  it("shows the cap as \"400+\" when the streak fills the window", () => {
    expect(view({ ...fullHome(), streak: 400 })).toContain(">400+</span>");
    expect(view({ ...fullHome(), streak: 399 })).toContain(">399</span>");
  });
});
