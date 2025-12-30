## Spotify Automation

Local-first ingestion of your Spotify recently played feed into SQLite, plus an "All tracks" playlist builder. Data stays in `data/spotify.db`; playlists are built from the DB, not from live history calls.

### Prereqs
- Python 3.12+
- Spotify app with OAuth credentials:
  - Redirect URI should be HTTPS (e.g., `https://example.com/callback`). Plain `http` is only allowed for explicit loopback IPs like `http://127.0.0.1:PORT` or `http://[::1]:PORT` (not `localhost`). Add the URI to the Spotify app settings.
  - Set env vars: `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `SPOTIFY_REDIRECT_URI`, `SPOTIFY_ALL_PLAYLIST_ID` (used for cursor key + legacy mirror).
- Optional envs: `SPOTIFY_SCOPE` (default includes `user-library-modify`, `user-library-read`, `playlist-modify-private`, `user-read-recently-played`), `SPOTIFY_TOKEN_CACHE_PATH` (`data/.spotify_token_cache.json`), `SPOTIFY_FREQUENT_PLAYLIST_ID` (playlist for frequent songs), `FREQUENT_MIN_PLAYS` (default `2`), `DB_LOCAL_PATH` (`data/spotify.db`), `LOG_LEVEL`.
  Logging: `LOG_FILE` (default `data/logs/spotify.log`), `LOG_RETENTION_DAYS` (default `7`).

Copy `.env.example` (or create `.env`) with the above values; `python-dotenv` will load it.

### Bootstrap OAuth
Runs the OAuth flow and writes the token cache (refresh token included) to `SPOTIFY_TOKEN_CACHE_PATH`.
```bash
poetry run token fetch
# or: python scripts/bootstrap_oauth.py
```
You’ll be prompted to log in/approve; the token is cached for future runs.

Token helpers:
```bash
poetry run token info   # show cache path
poetry run token clear  # delete cached token
```

### Commands
```bash
# create/upgrade schema
poetry run spotify migrate

# ingest recently played + update All playlist
poetry run spotify sync
# include all DB tracks not yet in the playlist (e.g., after history import)
poetry run spotify sync --full

Note: Spotify playlists max out at ~10k items. If you hit the limit, `sync --full`
will skip additions; remove items or target another playlist.

Behavior:
- Every sync adds new tracks to **Liked Songs** (and stores them in SQLite).
- Optional frequent-playlist: set `SPOTIFY_FREQUENT_PLAYLIST_ID`; tracks with at least `FREQUENT_MIN_PLAYS` total plays (default 2) are added to that playlist.
- A legacy mirror to `SPOTIFY_ALL_PLAYLIST_ID` is maintained for dedupe/compat but can hit the 10k limit.

Logging:
- Console output plus rotating file logs at `data/logs/spotify.log` (configurable via `LOG_FILE`), rotated nightly with 7-day retention (configurable via `LOG_RETENTION_DAYS`).

# explicitly call the feature wrapper (currently same as sync)
poetry run spotify run-feature all_playlist

# cache existing playlist contents into DB (avoid duplicate adds)
poetry run spotify backfill-playlist-cache

# import a Spotify history JSON export (file or directory of JSON files)
poetry run spotify import-history path/to/history.json
poetry run spotify import-history path/to/history_folder
```
`migrate` only needs `DB_LOCAL_PATH`. `sync` requires all Spotify env vars plus a valid token cache.

### Scheduling
Run `sync` every 10–15 minutes via cron/systemd/containers/n8n. Example cron:
```
*/10 * * * * cd /path/to/spotify-automation && /usr/bin/env bash -lc 'python -m src.main sync'
```

### Development & Tests
Install deps (`pip install -e .` or use Poetry), then run:
```bash
pytest
```
No tests hit the Spotify API; they use in-memory mocks and temporary SQLite files.
