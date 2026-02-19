# src/db/schema.py
SCHEMA_VERSION = 4

MIGRATIONS: list[tuple[int, str]] = [
    (
        1,
        """
        PRAGMA journal_mode=WAL;
        PRAGMA foreign_keys=ON;

        CREATE TABLE IF NOT EXISTS state (
          key        TEXT PRIMARY KEY,
          value      TEXT NOT NULL,
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS tracks (
          track_id      TEXT PRIMARY KEY,
          track_uri     TEXT NOT NULL,
          name          TEXT,
          artists       TEXT,
          album         TEXT,
          duration_ms   INTEGER,
          explicit      INTEGER,
          first_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS plays (
          played_at_ms INTEGER NOT NULL,
          track_id     TEXT NOT NULL,
          track_uri    TEXT NOT NULL,
          context_type TEXT,
          context_uri  TEXT,
          source       TEXT NOT NULL, -- recently_played | history_import
          inserted_at  TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (played_at_ms, track_id),
          FOREIGN KEY (track_id) REFERENCES tracks(track_id)
        );

        CREATE INDEX IF NOT EXISTS idx_plays_time  ON plays(played_at_ms);
        CREATE INDEX IF NOT EXISTS idx_plays_track ON plays(track_id);

        CREATE TABLE IF NOT EXISTS playlist_tracks (
          playlist_id    TEXT NOT NULL,
          track_id       TEXT NOT NULL,
          track_uri      TEXT NOT NULL,
          first_added_at TEXT NOT NULL DEFAULT (datetime('now')),
          last_seen_at   TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (playlist_id, track_id),
          FOREIGN KEY (track_id) REFERENCES tracks(track_id)
        );

        CREATE INDEX IF NOT EXISTS idx_playlist_tracks_playlist
          ON playlist_tracks(playlist_id);

        CREATE TABLE IF NOT EXISTS sync_runs (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          started_at    TEXT NOT NULL DEFAULT (datetime('now')),
          finished_at   TEXT,
          cursor_in_ms  INTEGER,
          cursor_out_ms INTEGER,
          plays_fetched INTEGER,
          tracks_added  INTEGER,
          status        TEXT, -- success | fail
          error         TEXT
        );
        """,
    ),
    (
        2,
        """
        CREATE TABLE IF NOT EXISTS playlists (
          playlist_id   TEXT PRIMARY KEY,
          name          TEXT NOT NULL,
          artist_name   TEXT,
          playlist_type TEXT NOT NULL DEFAULT 'artist',
          created_at    TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_playlists_artist
          ON playlists(artist_name);
        CREATE INDEX IF NOT EXISTS idx_playlists_type
          ON playlists(playlist_type);
        """,
    ),
    (
        3,
        """
        CREATE TABLE IF NOT EXISTS playlist_removals (
          playlist_id TEXT NOT NULL,
          track_id    TEXT NOT NULL,
          track_uri   TEXT NOT NULL,
          removed_at  TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (playlist_id, track_id)
        );

        CREATE INDEX IF NOT EXISTS idx_playlist_removals_playlist
          ON playlist_removals(playlist_id);
        """,
    ),
    (
        4,
        """
        CREATE TABLE IF NOT EXISTS playlist_exclusions (
          artist_name  TEXT PRIMARY KEY,
          playlist_id  TEXT,
          excluded_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );
        """,
    ),
]