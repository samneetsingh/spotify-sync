// Matches the Python schema at its v7 (src/db/schema.py).
const PYTHON_V7_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,

  `CREATE TABLE IF NOT EXISTS tracks (
    track_id TEXT PRIMARY KEY,
    track_uri TEXT NOT NULL,
    name TEXT,
    artists TEXT,
    album TEXT,
    duration_ms INTEGER,
    explicit INTEGER,
    first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
    popularity INTEGER,
    release_date TEXT,
    isrc TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS plays (
    played_at_ms INTEGER NOT NULL,
    track_id TEXT NOT NULL,
    track_uri TEXT NOT NULL,
    context_type TEXT,
    context_uri TEXT,
    source TEXT NOT NULL,
    inserted_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (played_at_ms, track_id),
    FOREIGN KEY (track_id) REFERENCES tracks(track_id)
  )`,

  `CREATE TABLE IF NOT EXISTS artists (
    artist_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    genres TEXT,
    popularity INTEGER,
    followers INTEGER,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,

  `CREATE TABLE IF NOT EXISTS track_artists (
    track_id TEXT NOT NULL,
    artist_id TEXT NOT NULL,
    artist_name TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (track_id, artist_id),
    FOREIGN KEY (track_id) REFERENCES tracks(track_id)
  )`,

  `CREATE TABLE IF NOT EXISTS playlists (
    playlist_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    artist_name TEXT,
    playlist_type TEXT NOT NULL DEFAULT 'artist',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,

  `CREATE TABLE IF NOT EXISTS playlist_tracks (
    playlist_id TEXT NOT NULL,
    track_id TEXT NOT NULL,
    track_uri TEXT NOT NULL,
    first_added_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (playlist_id, track_id),
    FOREIGN KEY (track_id) REFERENCES tracks(track_id)
  )`,

  `CREATE TABLE IF NOT EXISTS playlist_removals (
    playlist_id TEXT NOT NULL,
    track_id TEXT NOT NULL,
    track_uri TEXT NOT NULL,
    removed_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (playlist_id, track_id)
  )`,

  `CREATE TABLE IF NOT EXISTS playlist_exclusions (
    artist_name TEXT PRIMARY KEY,
    playlist_id TEXT,
    excluded_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,

  `CREATE TABLE IF NOT EXISTS sync_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at TEXT,
    cursor_in_ms INTEGER,
    cursor_out_ms INTEGER,
    plays_fetched INTEGER,
    tracks_added INTEGER,
    status TEXT,
    error TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,

  // Indexes
  `CREATE INDEX IF NOT EXISTS idx_plays_time ON plays(played_at_ms)`,
  `CREATE INDEX IF NOT EXISTS idx_plays_track ON plays(track_id)`,
  `CREATE INDEX IF NOT EXISTS idx_track_artists_artist ON track_artists(artist_id)`,
  `CREATE INDEX IF NOT EXISTS idx_playlist_tracks_playlist ON playlist_tracks(playlist_id)`,
  `CREATE INDEX IF NOT EXISTS idx_playlist_removals_playlist ON playlist_removals(playlist_id)`,
  `CREATE INDEX IF NOT EXISTS idx_playlists_artist ON playlists(artist_name)`,
  `CREATE INDEX IF NOT EXISTS idx_playlists_type ON playlists(playlist_type)`,
];

const WORKER_ACTIONS = [
  `CREATE TABLE IF NOT EXISTS worker_actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    job TEXT NOT NULL,
    write_mode TEXT NOT NULL,
    sync_run_id INTEGER,
    executed INTEGER NOT NULL,
    action TEXT NOT NULL,
    target TEXT,
    item_count INTEGER NOT NULL,
    items TEXT NOT NULL
  )`,
];

/** Per-play fields from the privacy export (`import-history`), named as Spotify names them. NULL for API plays. */
export const EXPORT_PLAY_FIELDS = [
  ["ms_played", "INTEGER"],
  ["platform", "TEXT"],
  ["conn_country", "TEXT"],
  ["reason_start", "TEXT"],
  ["reason_end", "TEXT"],
  ["shuffle", "INTEGER"],
  ["skipped", "INTEGER"],
  ["offline", "INTEGER"],
  ["incognito_mode", "INTEGER"],
] as const;

/**
 * The owner dashboard. Times are epoch ms.
 * - settings: dashboard overrides only (src/settings.ts); value is JSON. No row = the deploy config or default applies.
 * - sessions: login sessions; the cookie holds a random token, D1 only its SHA-256 (hex).
 * - activity: what happened (jobs, emails, account, settings, imports) for the dashboard; pruned after 90 days.
 */
const DASHBOARD = [
  `CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    spotify_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    user_agent TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    kind TEXT NOT NULL,
    ok INTEGER NOT NULL DEFAULT 1,
    summary TEXT NOT NULL,
    detail TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_activity_at ON activity(at)`,
];

/**
 * Streaming-history imports from the dashboard (src/import). Times are epoch ms.
 * - imports: one row per import; status uploading|reading|review|applying|done|failed|cancelled|expired.
 *   files = [{n,name,size,key,done}] (R2 keys are imports/<id>/<n>.<zip|json>, never user file names);
 *   entries = {"<file n>/<entry name>": {records,skipped,short,from,to}}; applied_to = end (exclusive)
 *   of the last applied month, part of each month's atomic batch so a replayed step deletes nothing.
 * - import_plays: staged plays (>= 30 s) of the one active import, deleted as each month is applied.
 */
const IMPORTS = [
  `CREATE TABLE IF NOT EXISTS imports (
    id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    status TEXT NOT NULL,
    files TEXT NOT NULL DEFAULT '[]',
    entries TEXT NOT NULL DEFAULT '{}',
    span_from INTEGER,
    span_to INTEGER,
    preview TEXT,
    options TEXT,
    applied_to INTEGER,
    progress TEXT,
    error TEXT,
    attempt INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS import_plays (
    played_at_ms INTEGER NOT NULL,
    track_id TEXT NOT NULL,
    track_uri TEXT NOT NULL,
    name TEXT,
    artists TEXT,
    album TEXT,
    explicit INTEGER,
    ms_played INTEGER,
    platform TEXT,
    conn_country TEXT,
    reason_start TEXT,
    reason_end TEXT,
    shuffle INTEGER,
    skipped INTEGER,
    offline INTEGER,
    incognito_mode INTEGER,
    PRIMARY KEY (played_at_ms, track_id)
  )`,
];

/**
 * v12, the dashboard replacing deploy vars: the parts that need no env.
 * migrate() never sees env, so copying SPOTIFY_USER_ID, the playlist ids and TIME_ZONE / AI_EDITOR /
 * FREQUENT_MIN_PLAYS into `state` and `settings` is a one-time runtime step instead
 * (importLegacyConfig in src/runtime.ts).
 * - The sync cursor gets one fixed key, cursor_after_ms:default (Config.cursorKey). Older deployments
 *   named theirs after SPOTIFY_ALL_PLAYLIST_ID; the newest cursor_after_ms:* wins, the rest go.
 * - Liked Songs was always on: an instance that already has plays or a Spotify login keeps it on
 *   (new owners start with it off).
 * - The one-click reconnect link's `reconnect` key is gone (reconnecting is logging in now).
 */
const DASHBOARD_SETTINGS = [
  `INSERT INTO state (key, value)
    SELECT 'cursor_after_ms:default', v FROM (
      SELECT CAST(MAX(CAST(value AS INTEGER)) AS TEXT) AS v FROM state WHERE key GLOB 'cursor_after_ms:*'
    ) WHERE v IS NOT NULL
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
  `DELETE FROM state WHERE key GLOB 'cursor_after_ms:*' AND key <> 'cursor_after_ms:default'`,
  `INSERT OR IGNORE INTO settings (key, value)
    SELECT 'liked', 'true' WHERE EXISTS (SELECT 1 FROM plays) OR EXISTS (SELECT 1 FROM state WHERE key = 'spotify_refresh_token')`,
  `DELETE FROM state WHERE key = 'reconnect'`,
];

interface Migration {
  version: number;
  statements: string[];
  /** Versions to record as applied; defaults to [version]. */
  records?: number[];
}

// D1 starts at Python's v7, so v7 records 1-7: on rollback, Python's per-version
// migrate() must see all of its migrations as applied. Worker-only changes use 8+.
export const MIGRATIONS: Migration[] = [
  { version: 7, statements: PYTHON_V7_SCHEMA, records: [1, 2, 3, 4, 5, 6, 7] },
  { version: 8, statements: WORKER_ACTIONS },
  { version: 9, statements: EXPORT_PLAY_FIELDS.map(([name, type]) => `ALTER TABLE plays ADD COLUMN ${name} ${type}`) },
  { version: 10, statements: DASHBOARD },
  { version: 11, statements: IMPORTS },
  { version: 12, statements: DASHBOARD_SETTINGS },
];

export function migrationStatements(m: Migration): string[] {
  const versions = m.records ?? [m.version];
  return [
    ...m.statements,
    ...versions.map((v) => `INSERT OR IGNORE INTO schema_migrations (version) VALUES (${v})`),
  ];
}

export async function migrate(db: D1Database): Promise<void> {
  await db.prepare(PYTHON_V7_SCHEMA[0]!).run();

  const applied = await db
    .prepare("SELECT MAX(version) AS version FROM schema_migrations")
    .first<{ version: number | null }>();
  const currentVersion = applied?.version ?? 0;

  for (const m of MIGRATIONS) {
    if (m.version <= currentVersion) continue;
    try {
      await db.batch(migrationStatements(m).map((sql) => db.prepare(sql)));
    } catch (err) {
      // Two jobs starting in the same minute can both see a migration as pending; the
      // loser's batch fails (v9's ALTER TABLEs aren't idempotent). Fine if it's now applied.
      const now = await db.prepare("SELECT MAX(version) AS version FROM schema_migrations").first<{ version: number | null }>();
      if ((now?.version ?? 0) >= m.version) continue;
      throw err;
    }
    console.log(`Applied migration v${m.version}`);
  }
}
