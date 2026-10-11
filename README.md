# spotify-sync

A Cloudflare Worker that keeps your Spotify library tidy from your listening history:

- **Every 10 minutes**: records recently played tracks in D1, adds new tracks to **Liked Songs**, and adds tracks with enough plays to a **frequent** playlist.
- **03:00 UTC**: creates and fills **per-artist playlists** for artists you play a lot, respects tracks you remove, and stops managing playlists you delete.
- **04:00 UTC**: fills a **Hindi/Desi favorites** playlist based on artist genres.
- **08:05 UTC** (just after midnight in `TIME_ZONE`): rewrites two playlists from the whole history. **On This Day** holds each past year's most played tracks on today's date, oldest year first. **Forgotten Favorites** is a new weekly set of 50 songs you've played 20+ times but not in over a year. Both are created on their first run. The same daily run also keeps **Holiday Favorites** filled from October 1 to January 6: every song whose title marks it as a holiday song (Christmas, Jingle, Let It Snow, ...) that you've played 3+ times. It only adds, so songs you remove stay removed. Every Monday it emails a **weekly digest** of the previous Monday-to-Sunday week, and on the first of each month a **monthly recap** of the previous month, to the alert address. Both show top tracks and artists with cover art, listening by day and hour, and new finds; the recap adds genres, a 12-month trend, comebacks and throwbacks. A failed send is retried the next day.

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
- `OPENAI_API_KEY` (optional, for the [AI editor](#ai-editor-optional))

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

An expired Spotify login shows up as a failing sync. Its email has a **Reconnect Spotify** button: it opens Spotify's login and brings you back to the Worker, which saves the new refresh token and syncs right away (you then get the "recovered" email). The link works once, expires after 7 days, and only accepts the account in `SPOTIFY_USER_ID`; reminders reuse it. `npm run token` still works as the fallback. This needs the Spotify app to list `https://spotify-sync.example.com/reconnect/callback` as a redirect URI.

## Emails

All emails (digests and alerts) are built from one small component library in `src/email/` (dark theme, tables and inline styles so Gmail and Apple Mail render them the same; phone layout first, upgraded on wide screens). Keep each email under ~100 KB, since Gmail clips longer ones. A dry run logs the subject, text and full HTML of a digest without sending it: `npx wrangler dev --env test --test-scheduled --port 8788 --var PUBLIC_URL:http://localhost:8788`, then `curl "http://localhost:8788/__scheduled?cron=5+8+*+*+*"`. The vinyl record image is `public/email/vinyl.png` (source and re-render command in `scripts/vinyl.html`).

## AI editor (optional)

The digests can have an AI editor. Once per digest it makes one call to OpenAI (Responses API, `gpt-6.1-sol`, strict JSON schema) that chooses which sections and highlight cards to show (a daily streak, late-night listening, one song all day, a long session, comebacks, a genre shift, a new obsession), puts them in order, picks a colour theme, and writes the headline, lead, preheader, section headings and one-line insights. The subject line stays as code writes it.

Code computes every number, chart and card; the model only sees precomputed facts. Its plan is validated strictly: every number in its copy must appear in the input, no markup, links or emoji, length limits, required sections present. Anything wrong (API error, timeout, refusal, invalid plan, or an edited email over 100,000 bytes) sends the default email instead; the editor never fails the job. Each digest logs `{ job, editor: used | fallback | off, reason, model, ms, inputTokens, outputTokens, theme, sections }` plus the plan, so a fallback reason such as `number: lead 1,600` shows what to tune.

**Turning it on.** It runs only when both are set:

- `AI_EDITOR = "on"` in `wrangler.toml` `[vars]` (unset or anything else keeps it off; forks can leave it off).
- The `OPENAI_API_KEY` secret: `npx wrangler secret put OPENAI_API_KEY`. Use a service-account key from a dedicated OpenAI project with a monthly budget. Locally it goes in `.dev.vars`; the test environment leaves `AI_EDITOR` unset, so preview it with `--var AI_EDITOR:on` on the dry-run command above.

**What goes to OpenAI:** the digest's facts: the period, totals, top track and artist names with play counts, genres, the busiest day and peak hour, new and returning artists, throwbacks, the highlight cards' facts (with the Spotify ids of their songs or artists), the section catalog and the default copy. Nothing else from D1, and no tokens or email addresses. Requests set `store: false`, so OpenAI doesn't keep the response for later retrieval (its standard API data policy still applies).

**Switches and cost.**

- Kill switch, no deploy needed: `npx wrangler d1 execute spotify-sync --remote --command "INSERT INTO state(key,value) VALUES('editor:mode','off') ON CONFLICT(key) DO UPDATE SET value='off'"`. Delete the row to turn it back on.
- Monthly cap: `state` `editor:calls:<UTC YYYY-MM>` counts calls (before each call, dry runs included); at 10 the digests use the default layout until the next month.
- Cost: about $0.01-0.04 per digest with `gpt-6.1-sol` ($2 in / $10 out per million tokens; the first real runs used 2-3k input and 0.5-0.8k output tokens, about $0.01 each), so at most about $0.25 a month for 4-5 weekly digests and one recap; the cap bounds it at about $0.40.

**Seasonal themes** don't need the AI: a digest whose last day falls in a season gets its colours and hero greeting (Halloween Oct 15 to Nov 1, winter holidays in December, new year in January, summer Jun 21 to Aug 31); other periods stay Spotify green. With the editor on, it picks between the default and that period's seasonal theme. All themes pass the contrast checks in `src/email/themes.ts`.

## Maintenance

**Backfilling Liked Songs after an import (`/sync-full`).** The endpoint adds every track in D1 that isn't yet in Liked Songs (and qualifying frequent tracks). It is served on the custom domain (`curl -X POST https://spotify-sync.example.com/sync-full -H "Authorization: Bearer $SECRET"`, needs the `SYNC_FULL_SECRET` secret set), or run it on Cloudflare's edge against production:

```bash
npx wrangler dev --remote          # uses production bindings and .dev.vars
curl -X POST http://localhost:8787/sync-full \
  -H "Authorization: Bearer $(grep '^SYNC_FULL_SECRET=' .dev.vars | cut -d= -f2-)"
```

**History playlists.** Their ids live in the D1 `state` table (`playlist:on_this_day`, `playlist:forgotten_favorites`, `playlist:holiday`). Deleting a playlist on Spotify switches it off; so does setting its value to `off`. Deleting the row makes the next run create a fresh one. The export's per-play fields (`ms_played`, `reason_end`, `shuffle`, `skipped`, `platform`, `conn_country`, ...) are on `plays` for imported rows; API plays leave them NULL.

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
  index.ts            cron dispatcher, /sync-full and the reconnect routes; runs each job with alerts + D1 query count logging
  alerts.ts           failure / recovery / sync-gap emails
  reconnect.ts        one-click Spotify reconnect (single-use link -> Spotify login -> new refresh token)
  email/              email design system: tokens + shell (layout.ts), blocks and charts (components.ts), themes, the digest's section registry
  editor/             optional AI editor for the digests: facts, highlights, prompt, plan validation, OpenAI client
  config.ts, env.ts   typed config from wrangler.toml vars and secrets
  jobs/               sync, artist-playlists, hindi-favorites, history-playlists, holiday-playlist, digest (weekly + monthly), owned-playlists, playlist-cache backfill
public/               static files served on the custom domain (email images)
  db/                 schema migrations, bulk json_each queries, state, query counter
  spotify/            fetch-based client (token refresh, retries, write gating), types, parsers
scripts/              local tools (token, import-history, live-write-test, verify-counts)
test/                 vitest (@cloudflare/vitest-plugin); parity/ holds frozen fixtures
docs/migration/       how this was ported from the original Python/Docker service
```

The project started as a Python service on a home server (Docker + cron + SQLite). It was ported to this Worker in October 2026; the Python code is in git history before that point.
