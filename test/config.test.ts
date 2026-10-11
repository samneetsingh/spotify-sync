import { env } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_CURSOR_NAMESPACE, loadConfig } from "../src/config";
import { migrate } from "../src/db/schema";
import { getState } from "../src/db/state";
import type { Env } from "../src/env";
import { runSync } from "../src/jobs/sync";
import { SpotifyClient } from "../src/spotify/client";
import { mockSpotify, resetDb } from "./parity/spotify-fixture";

describe("SPOTIFY_ALL_PLAYLIST_ID (legacy cursor namespace)", () => {
  let restore: (() => void) | undefined;
  beforeAll(() => migrate(env.DB));
  afterEach(() => restore?.());

  it("defaults when unset or empty", () => {
    expect(DEFAULT_CURSOR_NAMESPACE).toBe("default");
    expect(loadConfig({ WRITE_MODE: "live" } as Env).allPlaylistId).toBe("default");
    expect(loadConfig({ WRITE_MODE: "live", SPOTIFY_ALL_PLAYLIST_ID: "" } as Env).allPlaylistId).toBe("default");
  });

  it("keeps a configured value, so existing deployments keep their cursor key", () => {
    expect(loadConfig({ WRITE_MODE: "live", SPOTIFY_ALL_PLAYLIST_ID: "legacy123" } as Env).allPlaylistId).toBe("legacy123");
  });

  it.each([
    [undefined, "cursor_after_ms:default"],
    ["legacy123", "cursor_after_ms:legacy123"],
  ])("sync stores its cursor under the namespace (%s)", async (allPlaylistId, key) => {
    await resetDb(env.DB);
    restore = mockSpotify({
      tracks: { t1: { name: "Song", artists: [] } },
      recently_played: { default: [["2026-01-02T03:04:05.000Z", "t1"]] },
    }).restore;
    const cfg = loadConfig({ WRITE_MODE: "shadow", SPOTIFY_ALL_PLAYLIST_ID: allPlaylistId } as Env);
    await runSync(cfg, env.DB, new SpotifyClient("id", "secret", env.DB, cfg.writeMode));
    // The cursor lands just past the newest play.
    expect(await getState(env.DB, key)).toBe(String(Date.parse("2026-01-02T03:04:05.000Z") + 1));
  });
});
