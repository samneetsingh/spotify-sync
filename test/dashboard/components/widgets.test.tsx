// Home's other components: the hero cover, covers and rows, stat tiles and deltas, the status chip and
// banner, and the empty state.

import { describe, expect, it } from "vitest";
import { ArtistAvatar, Cover, HeroCover, TrackRow } from "../../../src/dashboard/components/music";
import { delta, StatTile } from "../../../src/dashboard/components/stats";
import { Banner, EmptyState, StatusChip, statusText } from "../../../src/dashboard/components/status";
import type { HomeStatus } from "../../../src/dashboard/home-data";
import { render } from "../../../src/dashboard/render";

const XSS = `<script>alert("x")</script>`;
const ESCAPED = "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;";
const NOW = Date.parse("2026-10-08T22:30:00Z");
const run = (minutesAgo: number) => ({ id: 1, startedAt: NOW - minutesAgo * 60_000 - 5_000, finishedAt: NOW - minutesAgo * 60_000, status: "success", playsFetched: 2, tracksAdded: 0, error: null });

describe("Hero cover and covers", () => {
  it("HeroCover: the square album cover, or the empty tile (its CSS background) without one", () => {
    expect(render(<HeroCover cover="https://i.scdn.co/image/abc" />)).toBe(
      `<div class="hero-cover" aria-hidden="true"><img src="https://i.scdn.co/image/abc" width="280" height="280" alt="" decoding="async"/></div>`,
    );
    expect(render(<HeroCover />)).toBe(`<div class="hero-cover" aria-hidden="true"></div>`);
  });

  it("Cover: a fixed-size lazy image with an empty alt, or the missing-art tile", () => {
    expect(render(<Cover url="https://i.scdn.co/image/x" size={48} />)).toBe(
      `<img class="cover cover-48" src="https://i.scdn.co/image/x" width="48" height="48" loading="lazy" decoding="async" alt=""/>`,
    );
    expect(render(<Cover size={56} round />)).toBe(`<span class="cover cover-56 round art-missing" aria-hidden="true"></span>`);
  });

  it("TrackRow: a Spotify link with the rank for screen readers, escaped text, the count", () => {
    const out = render(<TrackRow rank={2} track={{ id: "t1", name: XSS, artists: XSS, plays: 7 }} max={10} />);
    expect(out).toContain(`<a class="track-name" href="https://open.spotify.com/track/t1"><span class="vh">2. </span>${ESCAPED}</a>`);
    expect(out).toContain(`<span class="track-artist">${ESCAPED}</span>`);
    expect(out).toContain(`<span class="track-plays num">7 plays</span>`);
    expect(out).toContain(`width="70%"`);
    expect(out).toContain("art-missing");
  });

  it("ArtistAvatar: the photo, or the escaped initial", () => {
    expect(render(<ArtistAvatar name="M83" url="https://i.scdn.co/image/a" size={56} />)).toContain(`class="avatar cover-56"`);
    expect(render(<ArtistAvatar name="  nilüfer" />)).toBe(`<span class="avatar avatar-blank cover-40" aria-hidden="true">N</span>`);
    expect(render(<ArtistAvatar name="<b>" />)).toContain(">&lt;<");
  });
});

describe("StatTile and delta", () => {
  it("says the change in words and an arrow", () => {
    expect(delta(112, 100)).toEqual({ dir: "up", text: "12%" });
    expect(delta(88, 100)).toEqual({ dir: "down", text: "12%" });
    expect(delta(5, 5)).toEqual({ dir: "same", text: "Same" });
    expect(delta(1000, 999)).toEqual({ dir: "same", text: "Same" });
    expect(delta(3, 0)).toEqual({ dir: "up", text: "from 0" });
    expect(delta(0, 0)).toEqual({ dir: "same", text: "Same" });
  });

  it("renders the value, the label and the delta (read as 'up 12%')", () => {
    expect(render(<StatTile label="Plays" value="1,204" delta={{ dir: "up", text: "12%" }} />)).toBe(
      `<div class="tile"><dt>Plays</dt><dd class="tile-value num">1,204</dd><dd class="tile-delta"><span class="delta delta-up"><span aria-hidden="true">↑ </span><span class="vh">up </span>12%</span></dd></div>`,
    );
  });

  it("adds a decorative icon square when asked", () => {
    const out = render(<StatTile label="Hours" value="4.2" icon="clock" />);
    expect(out).toMatch(/^<div class="tile"><dt>Hours<\/dt><dd class="tile-value num">4.2<\/dd><dd class="tile-icon" aria-hidden="true"><svg class="icon" viewBox="0 0 24 24"[^>]*aria-hidden="true"[^>]*><circle /);
    expect(out).not.toContain("style=");
  });
});

describe("StatusChip and Banner", () => {
  const ok: HomeStatus = { connected: true, lastRun: run(4), lastSuccess: run(4), failing: [] };

  it("the chip links to the Spotify card in Settings and says when the last sync finished", () => {
    expect(render(<StatusChip status={ok} now={NOW} />)).toBe(`<a class="chip chip-ok" href="/settings#spotify">Connected, synced 4 min ago</a>`);
    expect(statusText({ ...ok, lastRun: run(90), lastSuccess: run(90) }, NOW)).toBe("Sync delayed, last synced 2 h ago");
    expect(statusText({ ...ok, lastRun: null, lastSuccess: null }, NOW)).toBe("Waiting for first sync");
    expect(render(<StatusChip status={{ ...ok, connected: false }} now={NOW} />)).toBe(`<a class="chip chip-bad" href="/settings#spotify">Not connected</a>`);
  });

  it("no banner while everything works", () => {
    expect(render(<div>{Banner({ status: ok, now: NOW })}</div>)).toBe("<div></div>");
  });

  it("asks to connect, to reconnect after a login error, or points at the failing jobs", () => {
    const notConnected = render(<Banner status={{ ...ok, connected: false }} now={NOW} />);
    expect(notConnected).toContain(`<div class="banner" role="alert">`);
    expect(notConnected).toContain(`<a class="banner-action" href="/login">Connect Spotify</a>`);

    const login = { job: "sync", since: NOW - 3_600_000, failures: 6, lastError: "invalid_grant: Refresh token revoked" };
    const relogin = render(<Banner status={{ ...ok, failing: [login] }} now={NOW} />);
    expect(relogin).toContain("Spotify&#39;s login expired or was revoked");
    expect(relogin).toContain(`<a class="banner-action" href="/login">Reconnect Spotify</a>`);

    const jobs = render(
      <Banner
        status={{
          ...ok,
          failing: [
            { job: "sync", since: 0, failures: 3, lastError: "Spotify 502" },
            { job: "artist-playlists", since: 0, failures: 1, lastError: null },
            { job: "weekly-digest", since: 0, failures: 1, lastError: null },
          ],
        }}
        now={NOW}
      />,
    );
    expect(jobs).toContain("The last 3 syncs failed. Artist playlists and Weekly digest are failing.");
    expect(jobs).toContain(`<a class="banner-action" href="/settings#problems">See problems</a>`);
  });
});

describe("EmptyState", () => {
  it("says what's missing and what happens next, escaped", () => {
    const out = render(<EmptyState title={XSS} action={<a href="/login">Connect</a>}>{XSS}</EmptyState>);
    expect(out).toContain(`<p class="empty-title">${ESCAPED}</p><p class="empty-text">${ESCAPED}</p><div class="empty-action"><a href="/login">Connect</a></div>`);
  });
});
