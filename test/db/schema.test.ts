import { env } from "cloudflare:workers";
import { describe, it, expect, beforeAll } from "vitest";
import { EXPORT_PLAY_FIELDS, MIGRATIONS, migrate, migrationStatements } from "../../src/db/schema";

const columns = async (table: string) =>
  (await env.DB.prepare(`SELECT name FROM pragma_table_info('${table}')`).all<{ name: string }>()).results.map((c) => c.name);

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
    expect(names).toEqual(expect.arrayContaining(["settings", "sessions", "activity", "imports", "import_plays"]));
  });

  it("is idempotent — running again is a no-op", async () => {
    await migrate(env.DB);

    const versions = await env.DB.prepare(
      "SELECT version FROM schema_migrations ORDER BY version",
    ).all<{ version: number }>();

    // v7 baseline records Python's 1-7 so a rollback export doesn't re-run them.
    expect(versions.results.map((r) => r.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it("v9 adds the export's per-play fields to plays", async () => {
    const cols = await env.DB.prepare("SELECT name FROM pragma_table_info('plays')").all<{ name: string }>();
    expect(cols.results.map((c) => c.name)).toEqual(expect.arrayContaining(EXPORT_PLAY_FIELDS.map(([name]) => name)));
  });

  it("v10 adds the dashboard tables", async () => {
    expect(await columns("settings")).toEqual(["key", "value", "updated_at"]);
    expect(await columns("sessions")).toEqual(["token_hash", "spotify_id", "created_at", "expires_at", "user_agent"]);
    expect(await columns("activity")).toEqual(["id", "at", "kind", "ok", "summary", "detail"]);
    const indexes = await env.DB.prepare("SELECT name FROM pragma_index_list('activity')").all<{ name: string }>();
    expect(indexes.results.map((i) => i.name)).toContain("idx_activity_at");
  });

  it("v11 adds the import tables; staged plays carry every export field", async () => {
    expect(await columns("imports")).toEqual([
      "id", "created_at", "updated_at", "status", "files", "entries", "span_from", "span_to",
      "preview", "options", "applied_to", "progress", "error", "attempt",
    ]);
    expect(await columns("import_plays")).toEqual([
      "played_at_ms", "track_id", "track_uri", "name", "artists", "album", "explicit", ...EXPORT_PLAY_FIELDS.map(([name]) => name),
    ]);
    const pk = await env.DB.prepare("SELECT name FROM pragma_table_info('import_plays') WHERE pk > 0 ORDER BY pk").all<{ name: string }>();
    expect(pk.results.map((c) => c.name)).toEqual(["played_at_ms", "track_id"]);
  });

  describe("v12 (settings replace deploy vars; the env-free part)", () => {
    const v12 = () => env.DB.batch(migrationStatements(MIGRATIONS.find((m) => m.version === 12)!).map((sql) => env.DB.prepare(sql)));
    const state = async () =>
      Object.fromEntries((await env.DB.prepare("SELECT key, value FROM state ORDER BY key").all<{ key: string; value: string }>()).results.map((r) => [r.key, r.value]));
    const settings = async () => (await env.DB.prepare("SELECT key, value FROM settings").all<{ key: string; value: string }>()).results;
    const clear = () => env.DB.batch(["state", "settings", "plays", "tracks"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));

    it("moves the newest sync cursor to the fixed key, drops the others and the old reconnect key", async () => {
      await clear();
      await env.DB.batch([
        env.DB.prepare("INSERT INTO state (key, value) VALUES ('cursor_after_ms:YOUR_ALL_PLAYLIST_ID', '1791700000001')"),
        env.DB.prepare("INSERT INTO state (key, value) VALUES ('cursor_after_ms:default', '1700000000001')"),
        env.DB.prepare("INSERT INTO state (key, value) VALUES ('cursor_after_msXother', 'keep')"), // not a cursor key
        env.DB.prepare("INSERT INTO state (key, value) VALUES ('reconnect', '{}')"),
        env.DB.prepare("INSERT INTO state (key, value) VALUES ('spotify_refresh_token', 'r')"),
      ]);
      await v12();
      expect(await state()).toEqual({
        "cursor_after_ms:default": "1791700000001",
        cursor_after_msXother: "keep",
        spotify_refresh_token: "r",
      });
      // Replaying it changes nothing.
      await v12();
      expect((await state())["cursor_after_ms:default"]).toBe("1791700000001");
    });

    it("keeps Liked Songs on for an instance that already has data (it was always on)", async () => {
      await clear();
      await env.DB.prepare("INSERT INTO state (key, value) VALUES ('spotify_refresh_token', 'r')").run();
      await v12();
      expect(await settings()).toEqual([{ key: "liked", value: "true" }]);

      await clear();
      await env.DB.batch([
        env.DB.prepare("INSERT INTO tracks (track_id, track_uri) VALUES ('t', 'spotify:track:t')"),
        env.DB.prepare("INSERT INTO plays (played_at_ms, track_id, track_uri, source) VALUES (1, 't', 'spotify:track:t', 'recently_played')"),
        env.DB.prepare("INSERT INTO settings (key, value) VALUES ('liked', 'false')"), // never overrides a saved choice
      ]);
      await v12();
      expect(await settings()).toEqual([{ key: "liked", value: "false" }]);
    });

    it("seeds nothing on a fresh instance", async () => {
      await clear();
      await v12();
      expect(await state()).toEqual({});
      expect(await settings()).toEqual([]);
    });
  });

  it("tolerates another job applying the same migrations first", async () => {
    // This job read version 8, then lost the race: its ALTER TABLE batch fails, and every later
    // migration is already applied by the winner.
    const latest = MIGRATIONS.at(-1)!.version;
    let reads = 0;
    const db = {
      prepare: (sql: string) => ({ run: async () => ({}), first: async () => ({ version: reads++ === 0 ? 8 : latest }), sql }),
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
