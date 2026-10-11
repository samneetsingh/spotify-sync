// Dashboard actions: digest previews (one email through a fake binding, cooldown, recap:* untouched),
// sync now (concurrency guard, runs through withJob), and recreating a deleted playlist (whitelist).

import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { handleDashboard } from "../../src/dashboard";
import { recreatePlaylist, sendPreview, syncNow } from "../../src/dashboard/actions";
import { recentActivity } from "../../src/activity";
import { getState } from "../../src/db/state";
import { migrate } from "../../src/db/schema";
import { seed } from "../jobs/digest-helpers";
import { mockSpotify, resetDb } from "../parity/spotify-fixture";
import { ctx, fakeBinding, mockSpotifyArt, post, session, settingsReady, stubSettings, testEnv } from "./helpers";

// Wed Oct 14 2026 11:00 PDT: "last week" in Los Angeles is Mon Oct 5 - Sun Oct 11 (2026-W41).
const NOW = Date.UTC(2026, 9, 14, 18);
const MIN = 60_000;

let restore: (() => void) | undefined;
beforeAll(() => migrate(env.DB));
beforeEach(() => resetDb(env.DB));
afterEach(() => {
  restore?.();
  restore = undefined;
});

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.append(k, v);
  return f;
};
const location = (res: Response) => res.headers.get("Location");

async function seedLastWeek() {
  await seed([
    { id: "t1", name: "Song <One>", artist: ["a1", "Artist"], at: ["2026-10-06T18:00:00Z", "2026-10-07T18:00:00Z"] },
    { id: "t2", name: "Song Two", artist: ["a2", "Other"], at: ["2026-10-08T18:00:00Z"] },
  ]);
}

describe("send me a preview", () => {
  it("sends one [Preview] email of last week, logs it and leaves recap:last_week alone", async () => {
    await seedLastWeek();
    const mail = fakeBinding();
    const spotify = mockSpotifyArt();
    restore = spotify.restore;
    const live = testEnv({ WRITE_MODE: "live", ALERT_EMAIL: mail.binding });

    const res = await sendPreview(form({ kind: "week" }), live, stubSettings(), NOW);
    expect(res.status).toBe(303);
    expect(location(res)).toBe("/?ok=preview-sent");
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]!.subject).toMatch(/^\[Preview\] /);
    expect(mail.sent[0]!.to).toBe(live.ALERT_EMAIL_TO);
    expect(await getState(env.DB, "recap:last_week")).toBeNull();
    expect(await getState(env.DB, "preview:week")).toBe(String(NOW));
    expect(spotify.calls.every((c) => c.startsWith("accounts.spotify.com") || c.startsWith("api.spotify.com"))).toBe(true);
    const [event] = await recentActivity(env.DB, 1);
    expect(event).toMatchObject({ kind: "email", ok: true, summary: "Preview of the weekly digest sent (2026-W41)" });
  });

  it("allows one preview per kind every 10 minutes", async () => {
    await seedLastWeek();
    const mail = fakeBinding();
    restore = mockSpotifyArt().restore;
    const live = testEnv({ WRITE_MODE: "live", ALERT_EMAIL: mail.binding });
    await sendPreview(form({ kind: "week" }), live, stubSettings(), NOW);
    expect(location(await sendPreview(form({ kind: "week" }), live, stubSettings(), NOW + 5 * MIN))).toBe("/?error=preview-cooldown");
    expect(mail.sent).toHaveLength(1);
    // The other kind has its own cooldown (no plays last month here, so nothing to send).
    expect(location(await sendPreview(form({ kind: "month" }), live, stubSettings(), NOW + 5 * MIN))).toBe("/?error=preview-empty-month");
    expect(location(await sendPreview(form({ kind: "week" }), live, stubSettings(), NOW + 11 * MIN))).toBe("/?ok=preview-sent");
    expect(mail.sent).toHaveLength(2);
  });

  it("only logs in dry run", async () => {
    await seedLastWeek();
    const mail = fakeBinding();
    restore = mockSpotifyArt().restore;
    const res = await sendPreview(form({ kind: "week" }), testEnv({ WRITE_MODE: "dry_run", ALERT_EMAIL: mail.binding }), stubSettings(), NOW);
    expect(location(res)).toBe("/?ok=preview-logged");
    expect(mail.sent).toHaveLength(0);
  });

  it("says so when the period has no plays", async () => {
    restore = mockSpotifyArt().restore;
    const res = await sendPreview(form({ kind: "week" }), testEnv({ WRITE_MODE: "live", ALERT_EMAIL: fakeBinding().binding }), stubSettings(), NOW);
    expect(location(res)).toBe("/?error=preview-empty-week");
  });

  it("refuses without email set up in live mode, before the cooldown starts", async () => {
    const res = await sendPreview(form({ kind: "week" }), testEnv({ WRITE_MODE: "live", ALERT_EMAIL: undefined }), stubSettings(), NOW);
    expect(location(res)).toBe("/?error=email-off");
    expect(await getState(env.DB, "preview:week")).toBeNull();
  });

  it("rejects an unknown kind", async () => {
    expect((await sendPreview(form({ kind: "year" }), testEnv(), stubSettings(), NOW)).status).toBe(400);
  });

  it.skipIf(!settingsReady)("[integration: WP-B settings] works through the router", async () => {
    await seedLastWeek();
    const mail = fakeBinding();
    restore = mockSpotifyArt().restore;
    const res = (await handleDashboard(post("/actions/preview", { kind: "month" }), testEnv({ WRITE_MODE: "live", ALERT_EMAIL: mail.binding }), ctx, session))!;
    expect(res.status).toBe(303);
    expect(location(res)).toMatch(/^\/\?(ok|error)=preview-/);
  });
});

describe("sync now", () => {
  const spotify = { recently_played: { default: [] }, tracks: {}, artists: {}, playlist_items: {}, playlist_total: {} };

  it("refuses while a sync started in the last 2 minutes hasn't finished, without calling Spotify", async () => {
    await env.DB.prepare("INSERT INTO sync_runs(started_at, status) VALUES(datetime('now', '-30 seconds'), 'running')").run();
    const mock = mockSpotify(spotify);
    restore = mock.restore;
    const res = await syncNow(testEnv());
    expect(location(res)).toBe("/?error=sync-busy");
    expect(mock.calls).toEqual([]);
  });

  it("runs the sync job (an older unfinished run doesn't block it) and logs it", async () => {
    await env.DB.prepare("INSERT INTO sync_runs(started_at, status) VALUES(datetime('now', '-10 minutes'), 'running')").run();
    const mock = mockSpotify(spotify);
    restore = mock.restore;
    const res = await syncNow(testEnv({ ALERT_EMAIL: fakeBinding().binding }));
    expect(location(res)).toBe("/?ok=synced");
    expect(mock.calls.some((c) => c.op === "recently_played")).toBe(true);
    const runs = await env.DB.prepare("SELECT status FROM sync_runs ORDER BY id").all<{ status: string }>();
    expect(runs.results.map((r) => r.status)).toEqual(["running", "success"]);
    const [event] = await recentActivity(env.DB, 1);
    expect(event).toMatchObject({ kind: "job", ok: true, summary: "Sync now: 0 new plays" });
  });

  it("reports a failed sync, which withJob records like a cron failure", async () => {
    const mock = mockSpotify({ ...spotify, recently_played_error: true });
    restore = mock.restore;
    const mail = fakeBinding();
    const res = await syncNow(testEnv({ ALERT_EMAIL: mail.binding }));
    expect(location(res)).toBe("/?error=sync-failed");
    expect(await getState(env.DB, "alert_failing:sync")).not.toBeNull();
    const [event] = await recentActivity(env.DB, 1);
    expect(event).toMatchObject({ kind: "job", ok: false, summary: "Sync now failed" });
  });
});

describe("recreate a deleted playlist", () => {
  it("forgets an owned playlist that was switched off, so its job creates it again", async () => {
    await env.DB.prepare("INSERT INTO state(key, value) VALUES('playlist:on_this_day', 'off')").run();
    const res = await recreatePlaylist(form({ key: "on_this_day" }), testEnv());
    expect(location(res)).toBe("/?ok=recreate");
    expect(await getState(env.DB, "playlist:on_this_day")).toBeNull();
    const [event] = await recentActivity(env.DB, 1);
    expect(event!.summary).toBe("On This Day will be recreated at its next run");
  });

  it("leaves a live playlist id alone", async () => {
    await env.DB.prepare("INSERT INTO state(key, value) VALUES('playlist:holiday', 'pl-holiday')").run();
    await recreatePlaylist(form({ key: "holiday" }), testEnv());
    expect(await getState(env.DB, "playlist:holiday")).toBe("pl-holiday");
    expect(await recentActivity(env.DB)).toEqual([]);
  });

  it.each(["spotify_refresh_token", "owner:spotify_id", "../holiday", "", "artist"])("only accepts whitelisted keys (%j)", async (key) => {
    await env.DB.prepare("INSERT OR REPLACE INTO state(key, value) VALUES('playlist:artist', 'off')").run();
    const res = await recreatePlaylist(form({ key }), testEnv());
    expect(res.status).toBe(400);
    expect(await getState(env.DB, "spotify_refresh_token")).toBe("test-refresh");
    expect(await getState(env.DB, "playlist:artist")).toBe("off");
  });
});
