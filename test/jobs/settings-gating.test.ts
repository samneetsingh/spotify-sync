// Settings reaching the jobs: withJob's one settings read, alerts and activity, the cron dispatch
// skipping switched-off jobs, Liked Songs / owned Frequent Plays and Hindi Favorites, the history
// playlists' flags, runSyncFull's limit, and the one-time import of the legacy deploy vars.
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { recentActivity } from "../../src/activity";
import { DISABLED, loadConfig, SYNC_CURSOR_KEY, type Config } from "../../src/config";
import { migrate } from "../../src/db/schema";
import { getState, setState } from "../../src/db/state";
import type { Env, WriteMode } from "../../src/env";
import { runHindiFavorites } from "../../src/jobs/hindi-favorites";
import { runHistoryPlaylists } from "../../src/jobs/history-playlists";
import { runSync, runSyncFull } from "../../src/jobs/sync";
import { alertConfig, editorConfig, emailConfig, importLegacyConfig, LEGACY_IMPORTED_KEY, withJob } from "../../src/runtime";
import { DAILY_CRON, runScheduled, SYNC_CRON } from "../../src/schedule";
import { loadSettings, resolveSettings, withoutLegacyVars, type SettingValues } from "../../src/settings";
import { SpotifyClient } from "../../src/spotify/client";
import { mockSpotify, resetDb, type Call } from "../parity/spotify-fixture";

type Sent = { subject: string; text?: string };
let sent: Sent[] = [];
const binding = { async send(m: Sent) { sent.push(m); return { messageId: "m" }; } } as unknown as SendEmail;

/** A D1 binding wrapper (a new object, so per-binding memos start over) that sees every SQL string. */
function dbProxy(onPrepare: (sql: string) => void = () => {}): D1Database {
  return new Proxy(env.DB, {
    get(target, prop) {
      if (prop === "prepare") return (sql: string) => (onPrepare(sql), target.prepare(sql));
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

const testEnv = (overrides: Partial<Env> = {}): Env =>
  ({
    ...(env as unknown as Env),
    SPOTIFY_CLIENT_ID: "id",
    SPOTIFY_CLIENT_SECRET: "secret",
    WRITE_MODE: "live",
    SETTINGS: "{}",
    OPENAI_API_KEY: "",
    ALERT_EMAIL: binding,
    ALERT_FROM: "spotify-sync@example.com",
    ALERT_EMAIL_TO: "owner@example.com",
    PUBLIC_URL: "https://sync.test",
    ...overrides,
  }) as Env;

const setSettings = (values: Partial<SettingValues>) =>
  env.DB.batch(Object.entries(values).map(([k, v]) => env.DB.prepare("INSERT INTO settings (key, value) VALUES (?1, ?2)").bind(k, JSON.stringify(v))));
const configWith = (values: Partial<SettingValues>, mode: WriteMode = "live"): Config =>
  loadConfig(testEnv({ WRITE_MODE: mode }), { ...resolveSettings([], testEnv()).values, ...values });
const client = (cfg: Config) => new SpotifyClient("id", "secret", env.DB, cfg.writeMode);

/** fetch that records each URL and fails: nothing may reach Spotify. */
function noSpotify(): string[] {
  const urls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    urls.push(String(input instanceof Request ? input.url : input));
    throw new Error("network disabled in this test");
  }) as typeof fetch;
  return urls;
}

const originalFetch = globalThis.fetch;
let restore: (() => void) | undefined;
beforeAll(() => migrate(env.DB));
beforeEach(async () => {
  sent = [];
  await resetDb(env.DB); // also seeds a refresh token
  await setState(env.DB, "owner:spotify_id", "owner-1");
});
afterEach(() => {
  restore?.();
  restore = undefined;
  globalThis.fetch = originalFetch;
});

async function seedPlays(plays: Array<[trackId: string, playedAtMs: number]>) {
  const ids = [...new Set(plays.map(([id]) => id))];
  await env.DB.batch([
    ...ids.map((id) => env.DB.prepare("INSERT OR IGNORE INTO tracks (track_id, track_uri, name) VALUES (?1, 'spotify:track:' || ?1, ?1)").bind(id)),
    ...plays.map(([id, at]) => env.DB.prepare("INSERT INTO plays (played_at_ms, track_id, track_uri, source) VALUES (?1, ?2, 'spotify:track:' || ?2, 'history_import')").bind(at, id)),
  ]);
}

describe("withJob", () => {
  it("reads the settings once and builds the job's Config from them", async () => {
    await setSettings({ timeZone: "America/Los_Angeles", holiday: false, liked: true });
    let settingsReads = 0;
    const e = testEnv({ DB: dbProxy((sql) => void (/\bFROM settings\b/i.test(sql) && settingsReads++)) });
    const cfg = await withJob(e, "probe", async (c) => c);
    expect(settingsReads).toBe(1);
    expect(cfg).toMatchObject({ timeZone: "America/Los_Angeles", features: { holiday: false, liked: true, frequent: true } });
  });

  it("a job switched off clears its failure state without a 'recovered' email or activity", async () => {
    await setState(env.DB, "alert_failing:probe", JSON.stringify({ since: 1, lastSent: 1, failures: 2 }));
    expect(await withJob(testEnv(), "probe", async () => DISABLED)).toBe(DISABLED);
    expect(await getState(env.DB, "alert_failing:probe")).toBeNull();
    expect(sent).toEqual([]);
    expect(await recentActivity(env.DB)).toEqual([]);

    // The same failure state with the job on: it recovers, with the email.
    await setState(env.DB, "alert_failing:probe", JSON.stringify({ since: 1, lastSent: 1, failures: 2 }));
    await withJob(testEnv(), "probe", async () => ({ done: 1 }));
    expect(sent.map((m) => m.subject)).toEqual(["[spotify-sync] probe recovered"]);
  });

  it("with alerts off, records the failure but sends nothing", async () => {
    await setSettings({ alerts: false });
    await expect(withJob(testEnv(), "artist-playlists", async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(JSON.parse((await getState(env.DB, "alert_failing:artist-playlists"))!)).toMatchObject({ failures: 1, lastSent: 0, lastError: "boom" });
    expect(sent).toEqual([]);
    expect(await recentActivity(env.DB)).toMatchObject([{ kind: "job", ok: false, summary: "Artist playlists failed", detail: "boom" }]);
  });

  it("logs what a job did to the activity log; never the 10-minute sync, nor a job with nothing to do", async () => {
    await withJob(testEnv(), "artist-playlists", async () => ({ artistsProcessed: 2, playlistsCreated: 1 }));
    await withJob(testEnv(), "weekly-digest", async () => ({ period: "2026-W41", sent: true }));
    await withJob(testEnv(), "holiday-playlist", async () => null);
    await withJob(testEnv(), "history-playlists", async () => ({ onThisDay: null, forgottenFavorites: null }));
    await withJob(testEnv(), "sync", async () => ({ playsFetched: 3 }));
    expect((await recentActivity(env.DB)).map((a) => a.summary)).toEqual([
      "Weekly digest for 2026-W41: sent",
      "Artist playlists: artists processed 2, playlists created 1",
    ]);
  });

  it("email, alert and editor configs follow the settings", () => {
    const e = testEnv({ OPENAI_API_KEY: "sk-test" });
    const values = { ...resolveSettings([], e).values, timeZone: "Asia/Tokyo", alerts: false, aiEditor: true };
    expect(emailConfig(e, values)).toMatchObject({ binding, timeZone: "Asia/Tokyo", to: "owner@example.com" });
    expect(alertConfig(e, values)).toMatchObject({ binding: undefined, timeZone: "Asia/Tokyo", to: "owner@example.com" });
    expect(alertConfig(e, { ...values, alerts: true }).binding).toBe(binding);
    expect(editorConfig(e, values)).toEqual({ enabled: true, apiKey: "sk-test" });
    expect(editorConfig(testEnv(), values)).toEqual({ enabled: false, apiKey: null });
    // A job's Config carries the same values.
    const cfg = loadConfig(e, values);
    expect(emailConfig(e, cfg).timeZone).toBe("Asia/Tokyo");
    expect(editorConfig(e, cfg.digests).enabled).toBe(true);
  });
});

describe("cron dispatch", () => {
  const failing = (job: string) => setState(env.DB, `alert_failing:${job}`, JSON.stringify({ since: 1, lastSent: 1, failures: 1 }));
  const ALL_OFF: Partial<SettingValues> = {
    artistPlaylists: false,
    hindiFavorites: false,
    onThisDay: false,
    forgottenFavorites: false,
    holiday: false,
    digestWeekly: false,
    digestMonthly: false,
  };
  const daily = ["history-playlists", "holiday-playlist", "weekly-digest", "monthly-recap"];

  it("skips every switched-off job without calling Spotify, clearing old failures quietly", async () => {
    await setSettings(ALL_OFF);
    for (const job of ["artist-playlists", "hindi-favorites", ...daily]) await failing(job);
    const urls = noSpotify();
    for (const cron of ["0 3 * * *", "0 4 * * *", DAILY_CRON]) await runScheduled(cron, testEnv(), {} as ExecutionContext);
    expect(urls).toEqual([]);
    expect(sent).toEqual([]);
    const left = await env.DB.prepare("SELECT key FROM state WHERE key LIKE 'alert_failing:%'").all();
    expect(left.results).toEqual([]);
  });

  it("runs a digest that's on (no plays: nothing to send, so the old failure recovers)", async () => {
    await setSettings({ ...ALL_OFF, digestWeekly: true });
    await failing("weekly-digest");
    await failing("monthly-recap");
    noSpotify();
    await runScheduled(DAILY_CRON, testEnv(), {} as ExecutionContext);
    expect(sent.map((m) => m.subject)).toEqual(["[spotify-sync] weekly-digest recovered"]);
  });
});

describe("sync: Liked Songs and Frequent Plays", () => {
  const T0 = Date.UTC(2026, 9, 1);
  const recently = (...plays: Array<[string, string]>) => ({
    tracks: Object.fromEntries(plays.map(([, id]) => [id, { name: id, artists: [] }])),
    recently_played: { default: plays },
    artists: {},
    playlist_items: {},
    playlist_total: {},
    my_playlists: [],
  });
  const ops = (calls: Call[]) => calls.filter((c) => c.op !== "recently_played").map((c) => [c.op, c.playlist_id ?? c.name ?? c.ids]);

  it("adds played songs to Liked Songs only when the setting is on", async () => {
    let mock = mockSpotify(recently(["2026-10-02T00:00:00.000Z", "t1"]));
    restore = mock.restore;
    await runSync(configWith({ liked: false, frequent: false }), env.DB, client(configWith({})));
    expect(mock.calls.filter((c) => c.op === "liked_add")).toEqual([]);
    mock.restore();

    await env.DB.prepare("DELETE FROM state WHERE key = ?1").bind(SYNC_CURSOR_KEY).run();
    mock = mockSpotify(recently(["2026-10-02T00:00:00.000Z", "t1"]));
    restore = mock.restore;
    await runSync(configWith({ liked: true, frequent: false }), env.DB, client(configWith({})));
    expect(mock.calls.filter((c) => c.op === "liked_add")).toEqual([{ op: "liked_add", ids: ["t1"] }]);
  });

  it("creates the owned Frequent Plays once it has songs (live), then keeps using it", async () => {
    const cfg = configWith({ frequentMinPlays: 2 });
    await seedPlays([["t1", T0]]);
    let mock = mockSpotify(recently(["2026-10-02T00:00:00.000Z", "t2"]));
    restore = mock.restore;
    await runSync(cfg, env.DB, client(cfg)); // t2 has one play: nothing to add, nothing created
    expect(ops(mock.calls)).toEqual([]);
    expect(await getState(env.DB, "playlist:frequent")).toBeNull();
    mock.restore();

    mock = mockSpotify(recently(["2026-10-03T00:00:00.000Z", "t1"]));
    restore = mock.restore;
    await runSync(cfg, env.DB, client(cfg));
    expect(ops(mock.calls)).toEqual([["create_playlist", "Frequent Plays"], ["playlist_total", "created-1"], ["playlist_add", "created-1"]]);
    expect(await getState(env.DB, "playlist:frequent")).toBe("created-1");
    mock.restore();

    mock = mockSpotify(recently(["2026-10-04T00:00:00.000Z", "t1"]));
    restore = mock.restore;
    await runSync(cfg, env.DB, client(cfg)); // already cached as added: the daily cache refresh only
    expect(ops(mock.calls)).toEqual([["playlist_items", "created-1"]]);
  });

  it("dry run: a placeholder playlist is never saved, read or marked", async () => {
    const cfg = configWith({ frequentMinPlays: 2 }, "dry_run");
    await seedPlays([["t1", T0]]);
    const mock = mockSpotify(recently(["2026-10-03T00:00:00.000Z", "t1"]));
    restore = mock.restore;
    const result = await runSync(cfg, env.DB, client(cfg));
    expect(result.frequentAdded).toBe(1);
    expect(ops(mock.calls)).toEqual([]); // creating and adding are blocked; nothing reads the placeholder
    expect(await getState(env.DB, "playlist:frequent")).toBeNull();
    const actions = await env.DB.prepare("SELECT action, target, executed FROM worker_actions ORDER BY id").all();
    expect(actions.results).toEqual([
      { action: "createPlaylist", target: null, executed: 0 },
      { action: "addToPlaylist", target: "would-create:Frequent Plays", executed: 0 },
    ]);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM playlist_tracks").first<{ n: number }>())!.n).toBe(0);
  });

  it("leaves Frequent Plays alone when it's off in settings or deleted in Spotify", async () => {
    await seedPlays([["t1", T0]]);
    for (const [values, stored] of [[{ frequent: false }, null], [{}, "off"]] as const) {
      await env.DB.prepare("DELETE FROM state WHERE key IN (?1, ?2)").bind(SYNC_CURSOR_KEY, "playlist:frequent").run();
      if (stored) await setState(env.DB, "playlist:frequent", stored);
      const cfg = configWith({ ...values, frequentMinPlays: 2 });
      const mock = mockSpotify(recently(["2026-10-03T00:00:00.000Z", "t1"]));
      restore = mock.restore;
      expect((await runSync(cfg, env.DB, client(cfg))).frequentAdded).toBe(0);
      expect(ops(mock.calls)).toEqual([]);
      mock.restore();
    }
  });
});

describe("hindi-favorites: owned playlist and the Frequent Plays check", () => {
  async function seedHindi() {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO artists (artist_id, name, genres) VALUES ('a1', 'Arijit', '[\"filmi\"]')"),
      env.DB.prepare("INSERT INTO tracks (track_id, track_uri, name) VALUES ('h1', 'spotify:track:h1', 'Song')"),
      env.DB.prepare("INSERT INTO track_artists (track_id, artist_id, artist_name) VALUES ('h1', 'a1', 'Arijit')"),
      ...[1, 2, 3, 4, 5].map((i) => env.DB.prepare("INSERT INTO plays (played_at_ms, track_id, track_uri, source) VALUES (?1, 'h1', 'spotify:track:h1', 'history_import')").bind(i)),
    ]);
  }
  const spotify = (myPlaylists: string[] = []) => ({ tracks: {}, artists: {}, playlist_items: {}, playlist_total: {}, my_playlists: myPlaylists });

  it("creates Hindi Favorites on the first run with the setting on, then reuses it", async () => {
    await seedHindi();
    const cfg = configWith({ hindiFavorites: true });
    let mock = mockSpotify(spotify());
    restore = mock.restore;
    expect(await runHindiFavorites(cfg, env.DB, client(cfg))).toEqual({ tracksAdded: 1, tracksConsidered: 1 });
    expect(mock.calls.map((c) => c.op)).toEqual(["create_playlist", "playlist_items", "playlist_add"]);
    expect(mock.calls[0]).toMatchObject({ name: "Hindi Favorites", public: false });
    expect(await getState(env.DB, "playlist:hindi")).toBe("created-1");
    mock.restore();

    mock = mockSpotify(spotify(["created-1"]));
    restore = mock.restore;
    expect(await runHindiFavorites(cfg, env.DB, client(cfg))).toEqual({ tracksAdded: 0, tracksConsidered: 1 });
    expect(mock.calls.map((c) => c.op)).toEqual(["my_playlists", "playlist_items"]);
  });

  it("dry run: works on a placeholder without saving or reading it", async () => {
    await seedHindi();
    const cfg = configWith({ hindiFavorites: true }, "dry_run");
    const mock = mockSpotify(spotify());
    restore = mock.restore;
    expect(await runHindiFavorites(cfg, env.DB, client(cfg))).toEqual({ tracksAdded: 1, tracksConsidered: 1 });
    expect(mock.calls).toEqual([]);
    expect(await getState(env.DB, "playlist:hindi")).toBeNull();
  });

  it("switches Frequent Plays off once it's gone from the library, even with Hindi Favorites off", async () => {
    const cfg = configWith({});
    await setState(env.DB, "playlist:frequent", "freqX");
    let mock = mockSpotify(spotify(["freqX"]));
    restore = mock.restore;
    expect(await runHindiFavorites(cfg, env.DB, client(cfg))).toBe(DISABLED);
    expect(await getState(env.DB, "playlist:frequent")).toBe("freqX");
    mock.restore();

    mock = mockSpotify(spotify(["something-else"]));
    restore = mock.restore;
    expect(await runHindiFavorites(cfg, env.DB, client(cfg))).toBe(DISABLED);
    expect(await getState(env.DB, "playlist:frequent")).toBe("off");
  });
});

it("history playlists: each runs only with its own setting", async () => {
  const now = Date.UTC(2026, 9, 11, 15);
  await seedPlays([["old", Date.UTC(2020, 9, 11, 18)], ["old", Date.UTC(2020, 9, 12, 18)]]);
  const base = configWith({ onThisDay: false });
  const cfg = { ...base, historyPlaylists: { ...base.historyPlaylists, forgottenMinPlays: 2 } };
  const mock = mockSpotify({ my_playlists: [] });
  restore = mock.restore;
  expect(await runHistoryPlaylists(cfg, env.DB, client(cfg), now)).toEqual({ onThisDay: null, forgottenFavorites: 1 });
  expect(mock.calls.filter((c) => c.op === "create_playlist").map((c) => c.name)).toEqual(["Forgotten Favorites"]);
  expect(await getState(env.DB, "playlist:on_this_day")).toBeNull();
});

describe("runSyncFull", () => {
  beforeEach(() => seedPlays([["t1", 1], ["t1", 2], ["t2", 3], ["t2", 4], ["t3", 5], ["t4", 6], ["t5", 7]]));
  const spotify = () => ({ tracks: {}, artists: {}, playlist_items: {}, playlist_total: {}, my_playlists: [] });

  it("adds Liked Songs only with the explicit opt-in and the setting on", async () => {
    const mock = mockSpotify(spotify());
    restore = mock.restore;
    const on = configWith({ liked: true, frequent: false });
    expect(await runSyncFull(on, env.DB, client(on), { limit: 100 })).toEqual({ likedAdded: 0, frequentAdded: 0, remaining: 0 });
    const off = configWith({ liked: false, frequent: false });
    expect(await runSyncFull(off, env.DB, client(off), { liked: true })).toEqual({ likedAdded: 0, frequentAdded: 0, remaining: 0 });
    expect(mock.calls).toEqual([]);
  });

  it("works through the backlog `limit` tracks at a time, Liked Songs first", async () => {
    const cfg = configWith({ liked: true, frequentMinPlays: 2 });
    const mock = mockSpotify(spotify());
    restore = mock.restore;
    expect(await runSyncFull(cfg, env.DB, client(cfg), { limit: 2, liked: true })).toEqual({ likedAdded: 2, frequentAdded: 0, remaining: 5 });
    expect(await runSyncFull(cfg, env.DB, client(cfg), { limit: 4, liked: true })).toEqual({ likedAdded: 3, frequentAdded: 1, remaining: 1 });
    expect(await runSyncFull(cfg, env.DB, client(cfg), { limit: 4, liked: true })).toEqual({ likedAdded: 0, frequentAdded: 1, remaining: 0 });
    expect(mock.calls.filter((c) => c.op === "create_playlist")).toHaveLength(1);
    expect(await getState(env.DB, "playlist:frequent")).toBe("created-1");
    await expect(runSyncFull(cfg, env.DB, client(cfg), { limit: 0 })).rejects.toThrow(/positive integer/);
  });

  it("records each Frequent Plays batch once Spotify took it, so a retry after a failed batch adds no duplicates", async () => {
    await setState(env.DB, "playlist:frequent", "freqX");
    const cfg: Config = { ...configWith({ liked: false, frequentMinPlays: 1 }), addBatchSize: 2 };
    const mock = mockSpotify(spotify());
    restore = mock.restore;
    const served = globalThis.fetch;
    let posts = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      // The second batch fails (a 400 isn't retried by the client).
      if (init?.method === "POST" && url.endsWith("/v1/playlists/freqX/tracks") && ++posts === 2) {
        return new Response(JSON.stringify({ error: { status: 400, message: "boom" } }), { status: 400 });
      }
      return served(input, init);
    }) as typeof fetch;
    const added = () => mock.calls.filter((c) => c.op === "playlist_add").flatMap((c) => c.uris as string[]);

    await expect(runSyncFull(cfg, env.DB, client(cfg), { limit: 100 })).rejects.toThrow();
    expect(added()).toHaveLength(2);
    // The retried step (the import's backfill) adds only the rest.
    expect(await runSyncFull(cfg, env.DB, client(cfg), { limit: 100 })).toMatchObject({ frequentAdded: 3, remaining: 0 });
    expect(added()).toHaveLength(5);
    expect(new Set(added()).size).toBe(5);
  });

  it("reports nothing remaining in dry run, where another call couldn't progress", async () => {
    const cfg = configWith({ liked: true, frequentMinPlays: 2 }, "dry_run");
    const mock = mockSpotify(spotify());
    restore = mock.restore;
    expect(await runSyncFull(cfg, env.DB, client(cfg), { limit: 2, liked: true })).toEqual({ likedAdded: 2, frequentAdded: 0, remaining: 0 });
    expect(mock.calls).toEqual([]);
  });
});

describe("one-time import of the legacy deploy vars", () => {
  /** An instance deployed before the dashboard (ids made up). */
  const legacyEnv = (overrides: Partial<Env> = {}) =>
    testEnv({
      SPOTIFY_USER_ID: "legacy-owner",
      SPOTIFY_ALL_PLAYLIST_ID: "all1",
      SPOTIFY_FREQUENT_PLAYLIST_ID: "freq1",
      SPOTIFY_HINDI_FAVORITES_PLAYLIST_ID: "hindi1",
      TIME_ZONE: "America/Los_Angeles",
      AI_EDITOR: "on",
      OPENAI_API_KEY: "sk-test",
      ...overrides,
    });
  const settingRows = async () =>
    Object.fromEntries((await env.DB.prepare("SELECT key, value FROM settings").all<{ key: string; value: string }>()).results.map((r) => [r.key, r.value]));

  beforeEach(() => env.DB.prepare("DELETE FROM state WHERE key = 'owner:spotify_id'").run());

  it("moves ids into state and settings into rows, so dropping the vars changes nothing", async () => {
    const e = legacyEnv();
    await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('liked', 'true')").run(); // v12 did this
    const before = (await loadSettings(env.DB, e)).values;

    expect(await importLegacyConfig(env.DB, e)).toEqual([
      "the owner's Spotify account",
      "the Frequent Plays playlist",
      "the Hindi Favorites playlist",
      "Hindi Favorites: on",
      "AI editor for digests: on",
      "Time zone: America/Los_Angeles",
    ]);
    expect(await getState(env.DB, "owner:spotify_id")).toBe("legacy-owner");
    expect(await getState(env.DB, "playlist:frequent")).toBe("freq1");
    expect(await getState(env.DB, "playlist:hindi")).toBe("hindi1");
    expect(await getState(env.DB, LEGACY_IMPORTED_KEY)).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(await settingRows()).toEqual({ liked: "true", hindiFavorites: "true", aiEditor: "true", timeZone: '"America/Los_Angeles"' });
    // The behaviour once the deploy config drops the vars (the OpenAI key is a secret, it stays):
    expect((await loadSettings(env.DB, withoutLegacyVars(e))).values).toEqual(before);
    expect((await recentActivity(env.DB, 1))[0]!.summary).toMatch(/^Moved the deploy config's settings into the dashboard: the owner's Spotify account;/);

    // Once only.
    expect(await importLegacyConfig(env.DB, legacyEnv({ TIME_ZONE: "Asia/Tokyo" }))).toBeNull();
    expect((await settingRows()).timeZone).toBe('"America/Los_Angeles"');
  });

  it("never overwrites a newer owner pin or a saved setting", async () => {
    await setState(env.DB, "owner:spotify_id", "pinned-by-login");
    await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('timeZone', '\"Europe/Paris\"')").run();
    await importLegacyConfig(env.DB, legacyEnv());
    expect(await getState(env.DB, "owner:spotify_id")).toBe("pinned-by-login");
    expect((await settingRows()).timeZone).toBe('"Europe/Paris"');
  });

  it("keeps Frequent Plays off for an instance that had no frequent playlist", async () => {
    await importLegacyConfig(env.DB, legacyEnv({ SPOTIFY_FREQUENT_PLAYLIST_ID: "" }));
    expect(await settingRows()).toMatchObject({ frequent: "false" });
    expect(await getState(env.DB, "playlist:frequent")).toBeNull();
  });

  it("treats an absent frequent playlist id like an empty one (the old template's default)", async () => {
    await importLegacyConfig(env.DB, legacyEnv({ SPOTIFY_FREQUENT_PLAYLIST_ID: undefined }));
    expect(await settingRows()).toMatchObject({ frequent: "false" });
    expect(await getState(env.DB, "playlist:frequent")).toBeNull();
    // So the next sync doesn't create a Frequent Plays playlist.
    expect((await loadSettings(env.DB, testEnv())).values.frequent).toBe(false);
  });

  it("leaves Frequent Plays on without an id when its playlist is already known, or the deploy config chose", async () => {
    await setState(env.DB, "playlist:frequent", "known1");
    await importLegacyConfig(env.DB, legacyEnv({ SPOTIFY_FREQUENT_PLAYLIST_ID: undefined }));
    expect(await settingRows()).not.toHaveProperty("frequent");

    await env.DB.batch([env.DB.prepare("DELETE FROM state WHERE key IN ('playlist:frequent', ?1)").bind(LEGACY_IMPORTED_KEY), env.DB.prepare("DELETE FROM settings")]);
    await importLegacyConfig(env.DB, legacyEnv({ SPOTIFY_FREQUENT_PLAYLIST_ID: undefined, SETTINGS: '{"frequent": true}' }));
    expect(await settingRows()).not.toHaveProperty("frequent");
  });

  it("a fresh instance gets its ids but keeps the new defaults", async () => {
    await env.DB.prepare("DELETE FROM state").run(); // no plays, no Spotify login
    await importLegacyConfig(env.DB, legacyEnv());
    expect(await settingRows()).toEqual({});
    expect(await getState(env.DB, "playlist:frequent")).toBe("freq1");
  });

  it("does nothing (not even the flag) without legacy vars", async () => {
    expect(await importLegacyConfig(env.DB, testEnv())).toBeNull();
    expect(await getState(env.DB, LEGACY_IMPORTED_KEY)).toBeNull();
  });

  it("runs before the first job, so the sync uses the imported playlist instead of creating one", async () => {
    await seedPlays([["t1", Date.UTC(2026, 9, 1)]]);
    const mock = mockSpotify({
      tracks: { t1: { name: "t1", artists: [] } },
      recently_played: { default: [["2026-10-03T00:00:00.000Z", "t1"]] },
      artists: {},
      playlist_items: {},
      playlist_total: {},
      my_playlists: [],
    });
    restore = mock.restore;
    await runScheduled(SYNC_CRON, legacyEnv({ DB: dbProxy(), FREQUENT_MIN_PLAYS: "2" }), {} as ExecutionContext);
    expect(mock.calls.map((c) => [c.op, c.playlist_id])).toEqual([
      ["playlist_items", "freq1"],
      ["recently_played", undefined],
      ["playlist_total", "freq1"],
      ["playlist_add", "freq1"],
    ]);
  });
});
