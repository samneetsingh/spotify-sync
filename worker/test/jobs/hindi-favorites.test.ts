import { env } from "cloudflare:workers";
import { afterEach, beforeAll, expect, it } from "vitest";
import { migrate } from "../../src/db/schema";
import { runHindiFavorites } from "../../src/jobs/hindi-favorites";
import { SpotifyClient } from "../../src/spotify/client";
import { FAMILIES, mockSpotify, resetDb, scenarioConfig } from "../parity/spotify-fixture";

let restore: (() => void) | undefined;
beforeAll(() => migrate(env.DB));
afterEach(() => restore?.());

it("skips without calling Spotify when no playlist is configured", async () => {
  await resetDb(env.DB);
  const mock = mockSpotify({});
  restore = mock.restore;
  const sc = FAMILIES.find((f) => f.family === "hindi")!.fixtures.scenarios[0];
  const cfg = { ...scenarioConfig(sc.config), hindiFavoritesPlaylistId: null };
  expect(await runHindiFavorites(cfg, env.DB, new SpotifyClient("id", "secret", env.DB, "live"))).toBeNull();
  expect(mock.calls).toEqual([]);
});
