# CLAUDE.md — spotify-automation

## Project Overview

Local-first Spotify automation system. Syncs recently-played tracks to a SQLite database, auto-generates playlists (per-artist, Hindi/Desi favorites, yearly reviews), enriches artist metadata, and manages Liked Songs. Data stays local; playlists are built from the DB, not live API calls.

**Stack**: Python 3.12, SQLite (WAL mode), Spotipy, Poetry, Docker (Alpine)

## Quick Reference

```bash
# Setup
poetry install
cp .env.example .env  # fill in Spotify credentials
poetry run spotify migrate
poetry run token fetch  # OAuth flow — opens browser

# Core commands
poetry run spotify sync               # incremental sync of recent plays
poetry run spotify sync --full         # also backfill all DB tracks to Liked Songs
poetry run spotify artist-playlists    # auto-create per-artist playlists
poetry run spotify artist-playlists --dry-run  # preview without changes
poetry run spotify hindi-favorites     # build Hindi/Desi playlist
poetry run spotify enrich              # fetch artist genres/popularity/followers
poetry run spotify import-history <path>  # import Spotify privacy export JSON
poetry run spotify backfill-playlist-cache  # cache existing playlist tracks in DB
poetry run spotify migrate             # create/upgrade schema

# Token management
poetry run token fetch     # run OAuth flow
poetry run token info      # show cache path and status
poetry run token clear     # delete cached token

# Tests
poetry run pytest                      # all tests
poetry run pytest -m "not slow"        # skip slow tests
poetry run pytest tests/test_config.py # single file
```

## Project Structure

```
src/
  main.py                 # CLI entry point (argparse dispatcher)
  token_cli.py            # Token management CLI (fetch/clear/info)
  logging_setup.py        # Rotating file + console logging
  spotify_helpers.py      # Shared: add_tracks_to_playlist, add_tracks_to_liked, extract_track_metadata
  config/
    __init__.py           # Config loader: frozen dataclasses, env > yaml > defaults
    config.yaml           # Default config values (all overridable via env vars)
  db/
    connection.py         # DB class: SQLite context manager with WAL + FK enforcement
    schema.py             # Versioned migrations (currently v7)
    queries.py            # NamedTuple row types + query helpers loading from sql/
    state.py              # Key-value state persistence (cursors, cache timestamps)
    sql/                  # 16 externalized .sql query files
  ingestion/
    spotify_client.py     # SpotifyClient protocol + get_spotify() factory
    sync_recent.py        # Core sync: fetch recently_played, update liked/frequent
    backfill_playlist.py  # Cache existing playlist contents into playlist_tracks
    enrich.py             # Batch artist metadata enrichment (genres, popularity)
    history_import.py     # Import Spotify privacy export JSON files
  features/
    artist_playlists.py   # Auto-create per-artist playlists from play data
    hindi_favorites.py    # Genre-based Hindi/Desi playlist builder
    yearly_playlists.py   # Year-in-review playlist builder
  analytics/              # Placeholder module (artist_stats.py, track_stats.py)
  utils/
    batching.py           # chunk_list() generator
    time.py               # iso8601_to_ms(), now_ms()
tests/
  conftest.py             # FakeSpotify mock, make_config() factory, autouse cache reset
  test_*.py               # 8 test files covering all modules
scripts/
  bootstrap_oauth.py      # Standalone OAuth token fetch
  deploy.sh               # SSH deploy: git pull + docker compose rebuild
  db_sync.sh              # SSH DB sync: pull/push with backups + container stop/start
  install_cron.sh         # Install local cron jobs
  run_sync.sh             # flock-guarded sync runner
  patch_artist_playlist_names.py  # One-off: strip ' – Auto' suffix
  prune_small_artist_playlists.py # One-off: remove small artist playlists
docker/
  crontab                 # */10 sync, 3am artist-playlists, 4am hindi-favorites
  entrypoint.sh           # Export env for cron, mkdir, run migration, exec CMD
```

## Architecture & Patterns

### Configuration
- **Three-tier resolution**: env var > `config.yaml` > hardcoded default
- Secrets (`SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `SPOTIFY_REDIRECT_URI`, playlist IDs) are env-var-only
- All config objects are **frozen dataclasses** — immutable after creation
- `load_config(require_spotify=False)` allows running `migrate` without Spotify credentials
- Redirect URI validation: must be HTTPS or explicit loopback IP (localhost is rejected)

### Database
- **No ORM** — raw SQL with NamedTuple wrappers (`TrackRow`, `PlayRow`, `ArtistRow`, etc.)
- SQL queries externalized in `src/db/sql/*.sql` and cached at module level
- Version-based migration system in `schema.py` with `schema_migrations` tracking table
- WAL mode + foreign keys enabled on every connection
- File permissions: 0o600 for DB, 0o700 for parent directory
- Upsert pattern (`ON CONFLICT DO UPDATE`) throughout for idempotent operations
- `state` table provides key-value persistence for cursors and cache timestamps

### Spotify API
- `SpotifyClient` **Protocol** in `spotify_client.py` — enables testing without Spotipy dependency
- Cursor-based incremental sync via `played_at_ms` stored in state table
- Respects Spotify's 10k playlist size limit (checks remaining capacity before adding)
- Batch sizes configurable: 100 for playlist adds, 50 for Liked Songs and artist fetches
- Graceful error handling for deleted/modified playlists (400/404/403)

### Testing
- **pytest** with `-v --tb=short`, markers: `slow`, `integration`
- `FakeSpotify` in conftest.py records all API calls (`add_calls`, `saved_calls`, etc.)
- Every test gets a fresh in-memory/tmp SQLite DB — no live API calls
- `_reset_config_caches` autouse fixture prevents cross-test config leakage
- `make_config(tmp_path)` and `make_config_with_freq(tmp_path)` factory functions for test configs

### Code Conventions
- `from __future__ import annotations` in all modules
- Module-level logger: `log = logging.getLogger(__name__)`
- Lazy imports inside functions to avoid circular dependencies (e.g., `backfill_playlist` in `sync_recent.py`)
- Result objects are NamedTuples or frozen dataclasses (`SyncResult`, `BackfillResult`, etc.)
- `chunk_list()` used everywhere for batch operations — never hand-roll batch loops

## Configuration Reference

### Required Environment Variables
| Variable | Description |
|----------|-------------|
| `SPOTIFY_CLIENT_ID` | Spotify app client ID |
| `SPOTIFY_CLIENT_SECRET` | Spotify app client secret |
| `SPOTIFY_REDIRECT_URI` | OAuth redirect (HTTPS or `http://127.0.0.1:PORT`) |
| `SPOTIFY_ALL_PLAYLIST_ID` | Primary "all tracks" playlist ID |

### Optional Environment Variables
| Variable | Default | Description |
|----------|---------|-------------|
| `SPOTIFY_FREQUENT_PLAYLIST_ID` | — | Playlist for tracks with 2+ plays |
| `SPOTIFY_HINDI_FAVORITES_PLAYLIST_ID` | — | Hindi/Desi favorites playlist |
| `DB_PATH` | `data/spotify.db` | SQLite database path |
| `LOG_LEVEL` | `INFO` | Logging level |
| `LOG_FILE` | `data/logs/spotify.log` | Log file path |
| `LOG_RETENTION_DAYS` | `7` | Days to keep rotated logs |
| `SPOTIFY_TOKEN_CACHE_PATH` | `data/.spotify_token_cache.json` | OAuth token cache |

### Deploy/Sync Variables (scripts only)
| Variable | Description |
|----------|-------------|
| `DB_SSH_HOST` | Remote server hostname |
| `DB_SSH_USER` | SSH username |
| `DB_SSH_KEY_PATH` | Path to SSH private key |
| `DB_REMOTE_PATH` | Remote DB file path |
| `DB_LOCAL_PATH` | Local DB file path (for db_sync.sh) |

### Artist Discovery Thresholds (all configurable via env or config.yaml)
See `ArtistDiscoveryConfig` in `src/config/__init__.py` for full list with defaults. Key ones: `ARTIST_MIN_PLAYS_PER_TRACK` (30), `ARTIST_MAX_TRACKS_PER_PLAYLIST` (50), `ARTIST_MIN_TRACKS_PER_PLAYLIST` (10).

## Deployment

### Docker (production)
```bash
docker compose up -d --build
# Container runs crond with:
#   */10 * * * *  spotify sync
#   0 3 * * *     spotify artist-playlists
#   0 4 * * *     spotify hindi-favorites
# entrypoint.sh: exports env to /etc/environment, creates dirs, runs migration
```

Two-stage Dockerfile: Poetry export in builder stage, pip install in runtime (no Poetry at runtime). Volume at `/data` for DB, logs, and token cache. Health check queries `sync_runs` for recent success.

### Remote Deploy
```bash
scripts/deploy.sh   # SSH: git pull + docker compose up -d --build + migrate
```

### Remote DB Sync
```bash
scripts/db_sync.sh pull   # download remote DB (stops container, backs up, copies, restarts)
scripts/db_sync.sh push   # upload local DB (same safety pattern)
scripts/db_sync.sh -y pull  # skip confirmation
```

## Database Schema

Core tables: `tracks`, `plays`, `artists`, `track_artists`, `playlists`, `playlist_tracks`, `playlist_removals`, `playlist_exclusions`, `sync_runs`, `state`. Schema version tracked in `schema_migrations`. See `src/db/schema.py` for all 7 migrations.

Key constraints:
- `plays` PK: `(played_at_ms, track_id)` — natural deduplication
- `playlist_tracks` PK: `(playlist_id, track_id)`
- Foreign keys enforced via PRAGMA

## Common Workflows

### After importing history
```bash
poetry run spotify import-history data/streaming-history/
poetry run spotify enrich           # backfill artist metadata
poetry run spotify sync --full      # add all DB tracks to Liked Songs
poetry run spotify artist-playlists # generate artist playlists
```

### Adding a new SQL query
1. Create `.sql` file in `src/db/sql/`
2. Add query loader in `src/db/queries.py` using `_load_sql("filename.sql")`
3. Query is auto-cached at module level after first load

### Adding a new schema migration
1. Increment `SCHEMA_VERSION` in `src/db/schema.py`
2. Append `(version, sql_string)` tuple to `MIGRATIONS` list
3. Run `poetry run spotify migrate` to apply

### Adding a new feature/playlist type
1. Create module in `src/features/`
2. Add CLI subcommand in `src/main.py`
3. Add corresponding SQL queries in `src/db/sql/` if needed
4. Follow existing pattern: accept `(cfg, db, sp)`, return a result NamedTuple
