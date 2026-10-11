# Porting a Python/Docker service to a Worker + D1

spotify-sync started as a Python CLI on a home server: Docker, `crond` running a sync every 10 minutes plus two daily jobs, a SQLite file, an on-disk OAuth token cache, `.env` + `config.yaml`, and SSH scripts for deploys and database copies. It was ported to this Cloudflare Worker and D1. The Python code is in the git history before the port. This page records the decisions and lessons, not the play-by-play.

## Architecture decisions

- **One Worker, several cron triggers.** `scheduled()` dispatches on the exact cron string (same UTC times as the old crontab). Every job runs inside `withJob`: migrations, alerting and a D1 query count.
- **Same schema, same data.** D1 got the Python schema unchanged. Its baseline migration (v7) equals Python's last version and records versions 1-7 as applied, so a `wrangler d1 export` can still be loaded by the old app (the rollback path). Worker-only changes start at v8.
- **State in D1, not on disk.** The refresh token moved from a JSON cache file to the `state` table, so the Worker can save rotated tokens itself. At the port, a local script (`npm run token`) ran the browser login once and seeded it; today the dashboard's "Log in with Spotify" does it (the script remains as an optional CLI login).
- **A thin fetch-based Spotify client** instead of an SDK: token refresh, one retry on 429 (honouring `Retry-After`), 401 and 5xx, and write gating in one place.
- **Config** went from `.env`/`config.yaml` to Worker vars and secrets; the Worker's vars are now a template filled per deployment (`npm run configure`). Later, everything an owner chooses moved to dashboard settings in D1, leaving the vars to infrastructure.
- **Dropped:** file permissions, rotating log files (Workers Logs instead), Docker, the SSH scripts. Local-only tools (OAuth login, privacy-export import) became Node scripts that reach D1 through `wrangler d1 execute`.

## Parity first, then improvements

- **Frozen golden fixtures.** The real Python jobs were run against small scenarios with a fake Spotify, recording each job's result, the ordered list of Spotify calls and every table afterwards (`test/parity/*.json`). The TypeScript jobs must reproduce them exactly. Python quirks were kept for parity and documented; the one real bug found (a manual add of a never-played track to an artist playlist aborted the whole run on a foreign key) was fixed as a listed divergence with its own test.
- **Query rewrites were diffed on real data first.** The artist discovery query split a comma-joined artist string with a recursive CTE; the port joins the normalized `track_artists` table instead. Old and new results were compared on a copy of the real database before switching: the differences were improvements (names containing ", " stay whole, featured artists count).
- **Byte-level details matter.** `artists.genres` is stored exactly as Python's `json.dumps` wrote it (`genresJson()`), so old and new rows compare equal.

## Write modes

`WRITE_MODE` is `live`, `shadow` or `dry_run`. The Spotify client blocks writes outside `live`; jobs skip D1 *state* writes (playlist contents, cursors, created playlists) in `dry_run`; plays and metadata are always recorded. Every Spotify write, or would-be write, is logged to `worker_actions`.

- `shadow` runs a second deployment against its own D1 alongside the old system: its state evolves as if it were live, so the two can be compared after a few days.
- `dry_run` is a smoke test only. It doesn't advance the sync cursor, and Spotify's recently-played endpoint only returns the last 50 plays, so a long dry run silently loses plays.

## Cutover and rollback

Stop the old service, take a consistent dump, load it into a fresh D1 in chunks and verify every table's row count, seed the token, deploy in `dry_run` for a cycle or two, switch to `live`, then run a full Liked Songs and frequent-playlist backfill once to repair anything missed in the gap (then the `/sync-full` endpoint; today the history import's backfill option). Rollback is the reverse: set `crons = []`, export D1, load it into a *fresh* SQLite file (loading into the old one fails on existing tables), verify counts with `scripts/verify-counts.sh`, then swap the files.

## Lessons

- **Never delete a Worker whose cron triggers are live.** Set `crons = []`, deploy, wait about 15 minutes, then delete. Deleting one with live crons left an orphaned trigger that stalled cron dispatch for every Worker on the account for a couple of hours, until it cleared on its own.
- **Cron changes take time to propagate** (minutes, up to about 30). Redeploying while waiting restarts the clock.
- **D1 limits shape the code:** 1,000 queries per invocation, 100 bound parameters per query and a maximum statement size. Bulk writes bind one JSON array and expand it with `json_each` (500 rows per statement), so a sync is a couple of dozen queries regardless of batch size. Large `wrangler d1 execute --file` imports are atomic per file and can fail with `D1_RESET_DO`: chunk them.
- **Migrations can race.** Two jobs starting in the same minute can both try to apply one; `ALTER TABLE ADD COLUMN` isn't idempotent, so `migrate()` re-checks the version after a failure.
- **Audit the Spotify API before porting.** Spotify announced replacements for several endpoints (`/me/library`, `/playlists/{id}/items`, removal of batch lookups); at the time the new ones returned 400/405 while the old ones (`PUT /me/tracks`, `POST /playlists/{id}/tracks`, batch `GET /artists` and `/tracks`) kept working and still returned genres. The Worker uses the old ones.
- **Spotify has no playlist delete.** "Deleting" your own playlist unfollows it, and writes to it still succeed. Detect it by its absence from `GET /me/playlists`, not by write errors.
- **Recently-played is a 50-play window.** Anything older (an outage, a long dry run) can only be recovered from a privacy export. The export is treated as the source of truth for plays inside its span: a play counts at 30 s or more, and API timestamps land a couple of seconds after the export's, so the import reconciles (insert, update, delete) rather than appending.
- **Plan for the Workers Paid plan.** The free plan's CPU and subrequest limits are too small for the daily jobs.
- **wrangler quirk:** the first API call after wrangler refreshes its OAuth token can fail with error 7403; the next one works (`scripts/lib.ts` retries once).
