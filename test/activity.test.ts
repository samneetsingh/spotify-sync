import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, expect, it } from "vitest";
import { logActivity, recentActivity } from "../src/activity";
import { migrate } from "../src/db/schema";
import { resetDb } from "./parity/spotify-fixture";

const NOW = Date.UTC(2026, 9, 11, 12);
beforeAll(() => migrate(env.DB));
beforeEach(() => resetDb(env.DB));

it("logs events and lists them newest first", async () => {
  await logActivity(env.DB, "job", "artist-playlists: 2 created", true, undefined, NOW - 60_000);
  await logActivity(env.DB, "email", "Weekly digest not sent", false, "binding refused", NOW);
  await logActivity(env.DB, "settings", "Weekly digest turned off", true, undefined, NOW);

  const events = await recentActivity(env.DB, 10);
  expect(events.map(({ id: _id, ...e }) => e)).toEqual([
    { at: NOW, kind: "settings", ok: true, summary: "Weekly digest turned off", detail: null },
    { at: NOW, kind: "email", ok: false, summary: "Weekly digest not sent", detail: "binding refused" },
    { at: NOW - 60_000, kind: "job", ok: true, summary: "artist-playlists: 2 created", detail: null },
  ]);
  expect(await recentActivity(env.DB, 1)).toHaveLength(1);
});

it("caps summary and detail lengths", async () => {
  await logActivity(env.DB, "import", "s".repeat(500), false, "d".repeat(5_000), NOW);
  const [event] = await recentActivity(env.DB);
  expect(event!.summary).toHaveLength(200);
  expect(event!.detail).toHaveLength(2_000);
});

it("is cleared by resetDb", async () => {
  await logActivity(env.DB, "account", "Logged in", true, undefined, NOW);
  await resetDb(env.DB);
  expect(await recentActivity(env.DB)).toEqual([]);
});
