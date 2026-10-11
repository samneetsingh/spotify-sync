import { env } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { SYNC_CURSOR_KEY, loadConfig } from "../src/config";
import { migrate } from "../src/db/schema";
import { getState } from "../src/db/state";
import type { Env } from "../src/env";
import { runSync } from "../src/jobs/sync";
import { resolveSettings } from "../src/settings";
import { SpotifyClient } from "../src/spotify/client";
import { mockSpotify, resetDb } from "./parity/spotify-fixture";

describe("loadConfig", () => {
  it("takes the owner's settings; without them, the deploy config and defaults", () => {
    const deployOnly = loadConfig({ WRITE_MODE: "live", SETTINGS: '{"timeZone":"Europe/Berlin","frequentMinPlays":7}' } as Env);
    expect(deployOnly).toMatchObject({
      timeZone: "Europe/Berlin",
      frequentMinPlays: 7,
      features: { liked: false, frequent: true, artistPlaylists: true, hindiFavorites: false, onThisDay: true, forgottenFavorites: true, holiday: true },
      digests: { weekly: true, monthly: true, aiEditor: false },
    });

    const values = { ...resolveSettings([], { WRITE_MODE: "live" } as Env).values, liked: true, holiday: false, digestMonthly: false, timeZone: "Asia/Kolkata" };
    expect(loadConfig({ WRITE_MODE: "live" } as Env, values)).toMatchObject({
      timeZone: "Asia/Kolkata",
      features: { liked: true, holiday: false },
      digests: { weekly: true, monthly: false },
    });
  });

  it("never reads playlist ids or the cursor namespace from env anymore", () => {
    const cfg = loadConfig({
      WRITE_MODE: "live",
      SPOTIFY_ALL_PLAYLIST_ID: "legacy123",
      SPOTIFY_FREQUENT_PLAYLIST_ID: "freq",
      SPOTIFY_HINDI_FAVORITES_PLAYLIST_ID: "hindi",
    } as Env);
    expect(cfg).toMatchObject({ cursorKey: SYNC_CURSOR_KEY, frequentPlaylistId: null, hindiFavoritesPlaylistId: null });
    // The legacy vars still feed the deploy layer until they're removed (see test/settings.test.ts).
    expect(cfg.features.hindiFavorites).toBe(true);
  });

  it("no longer throws on an invalid time zone: it falls back (the settings page lists the problem)", () => {
    expect(loadConfig({ WRITE_MODE: "live", TIME_ZONE: "Not/A_Zone" } as Env).timeZone).toBe("UTC");
  });
});

describe("sync cursor", () => {
  let restore: (() => void) | undefined;
  beforeAll(() => migrate(env.DB));
  afterEach(() => restore?.());

  it("lives under the fixed key", async () => {
    expect(SYNC_CURSOR_KEY).toBe("cursor_after_ms:default");
    await resetDb(env.DB);
    restore = mockSpotify({
      tracks: { t1: { name: "Song", artists: [] } },
      recently_played: { default: [["2026-01-02T03:04:05.000Z", "t1"]] },
    }).restore;
    const cfg = loadConfig({ WRITE_MODE: "shadow", SPOTIFY_ALL_PLAYLIST_ID: "legacy123" } as Env);
    await runSync(cfg, env.DB, new SpotifyClient("id", "secret", env.DB, cfg.writeMode));
    // The cursor lands just past the newest play.
    expect(await getState(env.DB, SYNC_CURSOR_KEY)).toBe(String(Date.parse("2026-01-02T03:04:05.000Z") + 1));
    expect(await getState(env.DB, "cursor_after_ms:legacy123")).toBeNull();
  });
});
