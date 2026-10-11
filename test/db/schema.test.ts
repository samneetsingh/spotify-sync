import { env } from "cloudflare:workers";
import { describe, it, expect, beforeAll } from "vitest";
import { EXPORT_PLAY_FIELDS, migrate } from "../../src/db/schema";

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
    expect(versions.results.map((r) => r.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("v9 adds the export's per-play fields to plays", async () => {
    const cols = await env.DB.prepare("SELECT name FROM pragma_table_info('plays')").all<{ name: string }>();
    expect(cols.results.map((c) => c.name)).toEqual(expect.arrayContaining(EXPORT_PLAY_FIELDS.map(([name]) => name)));
  });

  it("tolerates another job applying the same migration first", async () => {
    // This job read version 8, then lost the race: its ALTER TABLE batch fails.
    const versions = [8, 9];
    const db = {
      prepare: (sql: string) => ({ run: async () => ({}), first: async () => ({ version: versions.shift() }), sql }),
      batch: async () => {
        throw new Error("duplicate column name: ms_played");
      },
    } as unknown as D1Database;
    await expect(migrate(db)).resolves.toBeUndefined();

    const failing = { ...db, prepare: (sql: string) => ({ run: async () => ({}), first: async () => ({ version: 8 }), sql }) } as unknown as D1Database;
    await expect(migrate(failing)).rejects.toThrow(/duplicate column/);
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
