import { env } from "cloudflare:workers";
import { describe, it, expect, beforeAll } from "vitest";
import { SpotifyClient } from "../../src/spotify/client";
import { migrate } from "../../src/db/schema";

describe("SpotifyClient", () => {
  beforeAll(async () => {
    await migrate(env.DB);
    await env.DB.prepare(
      "INSERT INTO state (key, value) VALUES ('spotify_refresh_token', 'test-refresh-token') ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run();
  });

  it("gates Spotify writes in dry_run mode", async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    const client = new SpotifyClient("id", "secret", env.DB, "dry_run");
    await client.addToPlaylist("playlist123", ["spotify:track:abc"]);
    await client.addToLikedSongs(["trackId123"]);
    await client.createPlaylist({ name: "test" });
    await client.unfollowPlaylist("playlist123");

    console.log = origLog;

    expect(logs).toHaveLength(4);
    expect(JSON.parse(logs[0]!)).toMatchObject({ would_do: "addToPlaylist" });
    expect(JSON.parse(logs[1]!)).toMatchObject({ would_do: "addToLikedSongs" });
    expect(JSON.parse(logs[2]!)).toMatchObject({ would_do: "createPlaylist" });
    expect(JSON.parse(logs[3]!)).toMatchObject({ would_do: "unfollowPlaylist" });
  });

  it("gates Spotify writes in shadow mode", async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    const client = new SpotifyClient("id", "secret", env.DB, "shadow");
    await client.addToPlaylist("playlist123", ["spotify:track:abc"]);

    console.log = origLog;

    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0]!)).toMatchObject({ would_do: "addToPlaylist" });
  });
});
