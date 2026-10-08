import { env } from "cloudflare:workers";
import { describe, it, expect, beforeAll } from "vitest";
import { migrate } from "../../src/db/schema";

describe("D1 schema migration", () => {
  beforeAll(async () => {
    await migrate(env.DB);
  });

  it("creates all expected tables", async () => {
    const tables = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    ).all<{ name: string }>();

    const names = tables.results.map((t) => t.name).sort();
    expect(names).toContain("tracks");
    expect(names).toContain("plays");
    expect(names).toContain("artists");
    expect(names).toContain("track_artists");
    expect(names).toContain("playlists");
    expect(names).toContain("playlist_tracks");
    expect(names).toContain("playlist_removals");
    expect(names).toContain("playlist_exclusions");
    expect(names).toContain("sync_runs");
    expect(names).toContain("state");
    expect(names).toContain("schema_migrations");
    expect(names).toContain("worker_actions");
  });

  it("is idempotent — running again is a no-op", async () => {
    await migrate(env.DB);

    const versions = await env.DB.prepare(
      "SELECT version FROM schema_migrations ORDER BY version",
    ).all<{ version: number }>();

    // v7 baseline records Python's 1-7 so a rollback export doesn't re-run them.
    expect(versions.results.map((r) => r.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("state table supports key-value operations", async () => {
    await env.DB.prepare(
      "INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).bind("test_key", "test_value").run();

    const row = await env.DB.prepare(
      "SELECT value FROM state WHERE key = ?",
    ).bind("test_key").first<{ value: string }>();

    expect(row?.value).toBe("test_value");
  });
});
