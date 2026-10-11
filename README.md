# spotify-sync

A Cloudflare Worker that keeps your Spotify library tidy from your listening history:

- **Every 10 minutes**: records recently played tracks in D1, adds new tracks to **Liked Songs**, and adds tracks with enough plays to a **frequent** playlist.
- **03:00 UTC**: creates and fills **per-artist playlists** for artists you play a lot, respects tracks you remove, and stops managing playlists you delete.
- **04:00 UTC**: fills a **Hindi/Desi favorites** playlist based on artist genres.
- **08:05 UTC** (just after midnight in `TIME_ZONE`): rewrites two playlists from the whole history. **On This Day** holds each past year's most played tracks on today's date, oldest year first. **Forgotten Favorites** is a new weekly set of 50 songs you've played 20+ times but not in over a year. Both are created on their first run.

All state lives in a D1 database (plays, tracks, artists, playlist contents). Playlists are built from that history, not from live API calls.

## Setup

```bash
npm install
cp .dev.vars.example .dev.vars   # fill in Spotify app credentials
npm run token                    # browser login; stores the refresh token in D1
npm test
```

The Spotify app's redirect URI must be a loopback URL such as `http://127.0.0.1:8888/callback` (Spotify rejects `localhost`).

## Commands

| Command | What it does |
|---|---|
| `npm test` | Unit, parity and write-mode tests (local simulated D1, mocked Spotify) |
| `npm run typecheck` | Type-checks the Worker and the scripts |
| `npm run dev` | Runs the Worker locally in `dry_run` against the **test** D1; trigger a job with `curl "http://localhost:8787/__scheduled?cron=*/10+*+*+*+*"` |
| `npm run deploy` | Deploys to production (normally done by Workers Builds on push to `main`) |
| `npm run token` | Spotify login; writes the refresh token to D1 (`-- --db <name>` for another DB) |
| `npm run import-history -- <dir>` | Reconciles D1 with a Spotify privacy export (Extended Streaming History JSON): inside the export's span, plays become exactly its streams of 30 s or more (missing ones inserted, skips and API duplicates deleted); later plays are untouched. Then fetches artist credits and metadata. Pass the whole export folder; `--dry-run` prints the per-year diff without writing. |
| `npm run live-write-test` | Creates, fills, replaces and deletes a throwaway playlist to check real Spotify writes |

## Configuration

`wrangler.toml` holds everything non-secret: cron schedules, the D1 binding, playlist IDs, thresholds (`FREQUENT_MIN_PLAYS`), and the alert email binding.

Secrets are set with `npx wrangler secret put <NAME>`:

- `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`
- `SYNC_FULL_SECRET` (only needed for `/sync-full`)

Locally, the same names go in `.dev.vars`.

The Spotify refresh token is **not** a secret binding. It lives in the D1 `state` table so the Worker can save rotated tokens itself.

**Write modes** (`WRITE_MODE` var):

| Mode | Spotify writes | D1 state writes |
|---|---|---|
| `live` | yes | yes |
| `shadow` | no | yes |
| `dry_run` | no | no |

In every mode the Worker still records plays and track metadata, and every Spotify write (or would-be write) is logged in the `worker_actions` table.

## Alerts

Failures email `ALERT_EMAIL_TO` through Cloudflare Email Service:

- **A job throws:** you get an immediate alert, a reminder every 6 hours while it keeps failing, and a note when it recovers.
- **Syncs stop for more than 45 minutes:** you get a "sync resumed after a gap" email on the first run afterwards. While crons aren't firing at all, nothing can send mail; the gap email arrives once they resume.

An expired Spotify login shows up as a failing sync, and the email tells you to run `npm run token`.

## Maintenance

**Backfilling Liked Songs after an import (`/sync-full`).** The endpoint adds every track in D1 that isn't yet in Liked Songs (and qualifying frequent tracks). The Worker has no public URL, so run it on Cloudflare's edge against production:

```bash
npx wrangler dev --remote          # uses production bindings and .dev.vars
curl -X POST http://localhost:8787/sync-full \
  -H "Authorization: Bearer $(grep '^SYNC_FULL_SECRET=' .dev.vars | cut -d= -f2-)"
```

**History playlists.** Their ids live in the D1 `state` table (`playlist:on_this_day`, `playlist:forgotten_favorites`). Deleting a playlist on Spotify switches it off; so does setting its value to `off`. Deleting the row makes the next run create a fresh one. The export's per-play fields (`ms_played`, `reason_end`, `shuffle`, `skipped`, `platform`, `conn_country`, ...) are on `plays` for imported rows; API plays leave them NULL.

**Changing or removing the Worker.** Never delete a Worker while its crons are live:

1. Set `crons = []` and deploy.
2. Wait about 15 minutes.
3. Delete the Worker.

Deleting with live crons once left an orphaned trigger firing and stopped cron dispatch for the whole account for about 2 hours (see `docs/migration/PROGRESS.md`).

**Spotify API.** The Worker uses the long-standing endpoints: `PUT /me/tracks`, `POST /playlists/{id}/tracks`, batch `GET /artists`. The newer `/me/library` endpoints returned 400/405 when tested in October 2026.

**Database export / rollback.**

```bash
npx wrangler d1 export spotify-sync --remote --output=data/export.sql
sqlite3 data/restored.db < data/export.sql
scripts/verify-counts.sh data/restored.db spotify-sync   # must exit 0
```

## Layout

```
src/
  index.ts            cron dispatcher + /sync-full; runs each job with alerts + D1 query count logging
  alerts.ts           failure / recovery / sync-gap emails
  config.ts, env.ts   typed config from wrangler.toml vars and secrets
  jobs/               sync, artist-playlists, hindi-favorites, history-playlists, playlist-cache backfill
  db/                 schema migrations, bulk json_each queries, state, query counter
  spotify/            fetch-based client (token refresh, retries, write gating), types, parsers
scripts/              local tools (token, import-history, live-write-test, verify-counts)
test/                 vitest (@cloudflare/vitest-plugin); parity/ holds frozen fixtures
docs/migration/       how this was ported from the original Python/Docker service
```

The project started as a Python service on a home server (Docker + cron + SQLite). It was ported to this Worker in October 2026; the Python code is in git history before that point.
