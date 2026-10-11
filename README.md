# spotify-sync

A Cloudflare Worker that keeps your Spotify library tidy from your listening history:

- **Every 10 minutes**: records recently played tracks in D1, adds new tracks to **Liked Songs**, and adds tracks with enough plays to a **frequent** playlist.
- **03:00 UTC**: creates and fills **per-artist playlists** for artists you play a lot, respects tracks you remove, and stops managing playlists you delete.
- **04:00 UTC**: fills a **Hindi/Desi favorites** playlist based on artist genres.
- **08:05 UTC** (shortly after midnight US Pacific; see [Schedules](#schedules) to move it): rewrites two playlists from the whole history. **On This Day** holds each past year's most played tracks on today's date in `TIME_ZONE`, oldest year first. **Forgotten Favorites** is a new weekly set of 50 songs you've played 20+ times but not in over a year. Both are created on their first run. The same daily run also keeps **Holiday Favorites** filled from October 1 to January 6: every song whose title marks it as a holiday song (Christmas, Jingle, Let It Snow, ...) that you've played 3+ times. It only adds, so songs you remove stay removed. Every Monday it emails a **weekly digest** of the previous Monday-to-Sunday week, and on the first of each month a **monthly recap** of the previous month, to the alert address. Both show top tracks and artists with cover art, listening by day and hour, and new finds; the recap adds genres, a 12-month trend, comebacks and throwbacks. A failed send is retried the next day.

All state lives in a D1 database (plays, tracks, artists, playlist contents). Playlists are built from that history, not from live API calls. Failures email you, with a one-click link to reconnect Spotify when the login expires.

It began as a Python service on a home server and was ported to Workers + D1; [docs/PORTING.md](docs/PORTING.md) covers the decisions and lessons.

## Deploy your own

You need a Cloudflare account on the **Workers Paid** plan (the free plan's CPU and subrequest limits are too small for the daily jobs, and it allows only 5 cron triggers per account; one instance uses 4), Node.js 22+, and a Spotify account. Optional: a domain on Cloudflare, for reconnect links, email images and alert emails.

### 1. Install

```bash
git clone <your fork> spotify-sync && cd spotify-sync
npm install
npx wrangler login
```

### 2. Create a Spotify app

At [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard), create an app with the **Web API** and add both redirect URIs:

- `http://127.0.0.1:8888/callback`, used by `npm run token` (Spotify rejects `localhost`; use the loopback IP).
- `https://<your domain>/reconnect/callback`, used by the reconnect links in alert emails (skip it without a custom domain).

While the app is in development mode, only Spotify accounts listed under **User Management** can log in (Spotify limits development-mode apps to a few users), so add yours. Copy the client ID and secret:

```bash
cp .dev.vars.example .dev.vars   # fill in SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET
```

`.dev.vars` (gitignored) is read by `wrangler dev` and the scripts in `scripts/`.

### 3. Create the databases

```bash
npx wrangler d1 create spotify-sync        # production
npx wrangler d1 create spotify-sync-test   # used by `npm run dev` (dry run)
```

Note both database ids. If wrangler offers to add the binding to your config, decline: the template already has it.

### 4. Write your deploy config

`wrangler.toml` is a template: everything specific to your deployment is a `{{KEY}}` placeholder, filled from `deploy.config.json` (gitignored).

```bash
cp deploy.config.example.json deploy.config.json   # edit it
npm run configure                                  # writes wrangler.generated.toml (gitignored)
```

| Key | Required | Value |
|---|---|---|
| `WORKER_NAME` | yes | Worker name, e.g. `spotify-sync` |
| `D1_DATABASE_NAME`, `D1_DATABASE_ID` | yes | The production database from step 3 |
| `TEST_WORKER_NAME`, `TEST_D1_DATABASE_NAME`, `TEST_D1_DATABASE_ID` | yes | Name for the local test Worker (`npm run dev`) and the test database |
| `SPOTIFY_USER_ID` | yes | The Spotify username allowed to use reconnect links (yours: see your account overview on spotify.com); they refuse any other account |
| `CUSTOM_DOMAIN` | yes* | Hostname the Worker is served on, e.g. `spotify-sync.example.com`, in a zone on your Cloudflare account |
| `ALERT_FROM`, `ALERT_EMAIL_TO` | yes* | Sender (on a domain onboarded to Cloudflare Email Service) and recipient of alerts and digests |
| `TIME_ZONE` | no, `UTC` | IANA zone for "today" (history playlists, holiday season, digest weeks, alert times) |
| `SPOTIFY_FREQUENT_PLAYLIST_ID` | no | A playlist you created for frequently played tracks; empty = off |
| `SPOTIFY_HINDI_FAVORITES_PLAYLIST_ID` | no | A playlist you created for Hindi/Desi favorites; empty = off |
| `SPOTIFY_ALL_PLAYLIST_ID` | no | Legacy: only namespaces the sync cursor key; leave empty |
| `AI_EDITOR` | no, `off` | `on` or `off`: switch for the AI editor |

\* No custom domain? Delete the `routes` and `PUBLIC_URL` lines from `wrangler.toml`: the jobs still run, but there are no reconnect links (use `npm run token` instead) and emails lose their record image. No email? Delete the `ALERT_FROM`/`ALERT_EMAIL_TO` lines and the `[[send_email]]` block: alerts and digests are then skipped (and logged). `configure` only asks for placeholders still in the template.

Playlist ids are the last part of the playlist's share link (`open.spotify.com/playlist/<id>`). Thresholds such as `FREQUENT_MIN_PLAYS` and the cron schedules live directly in `wrangler.toml`.

### 5. Set the secrets

```bash
npx wrangler secret put SPOTIFY_CLIENT_ID -c wrangler.generated.toml       # say yes to creating the Worker
npx wrangler secret put SPOTIFY_CLIENT_SECRET -c wrangler.generated.toml
openssl rand -hex 32   # optional SYNC_FULL_SECRET for POST /sync-full; also put it in .dev.vars
npx wrangler secret put SYNC_FULL_SECRET -c wrangler.generated.toml
```

### 6. Log in to Spotify, then deploy

```bash
npm run token    # browser login; creates the schema and stores the refresh token in D1
npm run deploy   # configure + wrangler deploy
```

The first sync runs within 10 minutes and backfills the last 24 hours (Spotify's recently-played history only reaches back 50 plays). Check it in the dashboard (Workers Logs) or with `npx wrangler tail -c wrangler.generated.toml`. The refresh token lives in the D1 `state` table, not in a secret, so the Worker can save rotated tokens itself.

### 7. Optional extras

- **Your whole history.** Request your *Extended streaming history* from Spotify's privacy page, then `npm run import-history -- <export folder> --dry-run`, and again without `--dry-run`. Afterwards, `/sync-full` adds the imported tracks to Liked Songs (see [Maintenance](#maintenance)).
- **Alert and digest emails.** Onboard your domain to Cloudflare Email Service so `ALERT_FROM` can send (`npx wrangler email sending enable <domain>` or the dashboard). The binding can only send to `ALERT_EMAIL_TO`; verify that address if Cloudflare asks you to.
- **Custom domain.** Created on deploy from `CUSTOM_DOMAIN` (the hostname must be in a zone on the same account). `workers.dev` stays off.
- **Frequent and Hindi/Desi playlists.** Create the playlists yourself in Spotify and put their ids in your deploy config.
- **Holiday Favorites, On This Day, Forgotten Favorites** are created automatically. To switch one off, delete it in Spotify, or set its `state` row to `off` (see [Maintenance](#maintenance)).

### Auto-deploy with Workers Builds

To deploy on every push to `main`, connect the repository in the Cloudflare dashboard (Workers & Pages, your Worker, **Settings > Build**) and set:

| Setting | Value |
|---|---|
| Build command | `npm test && npm run configure` |
| Deploy command | `npx wrangler deploy -c wrangler.generated.toml` |
| Build variables and secrets | `DEPLOY_CONFIG` = your deploy config as one line of JSON |

```bash
node -e 'console.log(JSON.stringify(require("./deploy.config.json")))'   # the DEPLOY_CONFIG value
```

`configure` reads `DEPLOY_CONFIG` when there's no `--config` flag, and runs in the build command because Cloudflare documents build variables as available to the build (not at runtime) without saying whether the deploy command sees them; the generated file is still there when the deploy command runs. (If your deploy command does see them, `npm run deploy` works too.) Preview builds aren't useful here (preview URLs are off): turn them off, or append `-c wrangler.generated.toml` to the Preview command. Workers Builds deploys to the Worker it's connected to, so keep `WORKER_NAME` equal to that Worker's name. Runtime secrets are set once with `wrangler secret put`, not in the build.

### Running more than one instance

One fork can run several independent instances, say yours and a friend's, each with its own Worker, D1 databases, custom domain, Spotify account and alert address:

- **A deploy config per instance**, e.g. `deploy.config.friend.json` (all `deploy.config*.json` files are gitignored), with different `WORKER_NAME`, database names and ids, `CUSTOM_DOMAIN`, `SPOTIFY_USER_ID` and alert addresses.
- **Generate and use its own wrangler config:**

  ```bash
  npm run configure -- --config deploy.config.friend.json --out wrangler.friend.generated.toml
  npx wrangler deploy -c wrangler.friend.generated.toml
  npx wrangler secret put SPOTIFY_CLIENT_ID -c wrangler.friend.generated.toml   # and the other secrets
  WRANGLER_CONFIG=wrangler.friend.generated.toml npm run token -- --no-open
  WRANGLER_CONFIG=wrangler.friend.generated.toml npm run import-history -- <their export> --dry-run
  ```

  The scripts default `--db` to the production database of the config they use and print it before writing. `npm run token` stores whoever logs in, and its redirect only reaches your machine: open the printed URL in a private window and let the other person sign in there.
- **A Workers Builds project per instance:** connect the same repository to each Worker, each with its own `DEPLOY_CONFIG` build variable and the same build and deploy commands.
- **One Spotify app can serve every instance** (same client ID and secret as each Worker's secrets). Register each instance's `https://<its domain>/reconnect/callback` redirect URI, and while the app is in development mode add each person's Spotify account under **User Management**.
- **Account limits:** each instance uses 4 cron triggers and one Worker; check the [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) for your plan (Workers Paid allows 250 cron triggers per account).

## Commands

| Command | What it does |
|---|---|
| `npm test` | Unit, parity and write-mode tests (local simulated D1, mocked Spotify; the template is filled with the example config) |
| `npm run typecheck` | Type-checks the Worker and the scripts |
| `npm run configure` | Writes `wrangler.generated.toml` from `deploy.config.json` (or `DEPLOY_CONFIG`; `-- --config <file> --out <file>` for another instance) |
| `npm run dev` | Runs the Worker locally in `dry_run` against the **test** D1; trigger a job with `curl "http://localhost:8787/__scheduled?cron=*/10+*+*+*+*"` |
| `npm run deploy` | Configures and deploys to production (or let Workers Builds do it on push) |
| `npm run token` | Spotify login; creates the schema if needed and writes the refresh token to D1 (`-- --db <name>` for another database) |
| `npm run import-history -- <dir>` | Reconciles D1 with a Spotify privacy export (Extended Streaming History JSON): inside the export's span, plays become exactly its streams of 30 s or more (missing ones inserted, skips and API duplicates deleted); later plays are untouched. Then fetches artist credits and metadata. Pass the whole export folder; `--dry-run` prints the per-year diff without writing. |
| `npm run live-write-test` | Creates, fills, replaces and deletes a throwaway playlist to check real Spotify writes |

The scripts use `wrangler.generated.toml`, or the file in `WRANGLER_CONFIG`. For other wrangler commands, pass `-c wrangler.generated.toml` yourself.

## Configuration

Non-secret settings are Worker vars in `wrangler.toml` (thresholds, schedules, bindings) and your deploy config (everything per deployment). Secrets, set with `npx wrangler secret put <NAME> -c wrangler.generated.toml` and locally in `.dev.vars`:

- `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`
- `SYNC_FULL_SECRET` (only needed for `/sync-full`)
- `OPENAI_API_KEY` (optional, for the [AI editor](#ai-editor-optional))

### Write modes

`WRITE_MODE` in `wrangler.toml`:

| Mode | Spotify writes | D1 state writes |
|---|---|---|
| `live` | yes | yes |
| `shadow` | no | yes |
| `dry_run` | no | no |

In every mode the Worker still records plays and track metadata, and every Spotify write (or would-be write) is logged in the `worker_actions` table. Keep `dry_run` runs short: the sync cursor doesn't advance, and recently-played only returns the last 50 plays.

### Schedules

Cron schedules are in UTC, in `wrangler.toml` `[triggers]`. `src/index.ts` maps each exact cron string to its job, so **change both together**. Cron changes take a few minutes (up to about 30) to propagate; don't redeploy repeatedly while waiting.

## Alerts

Failures email `ALERT_EMAIL_TO` through Cloudflare Email Service:

- **A job throws:** you get an immediate alert, a reminder every 6 hours while it keeps failing, and a note when it recovers.
- **Syncs stop for more than 45 minutes:** you get a "sync resumed after a gap" email on the first run afterwards. While crons aren't firing at all, nothing can send mail; the gap email arrives once they resume.

An expired Spotify login shows up as a failing sync. Its email has a **Reconnect Spotify** button: it opens Spotify's login and brings you back to the Worker, which saves the new refresh token and syncs right away (you then get the "recovered" email). The link works once, expires after 7 days, and only accepts the account in `SPOTIFY_USER_ID`; reminders reuse it. It needs a custom domain and the `https://<your domain>/reconnect/callback` redirect URI in the Spotify app. `npm run token` always works as the fallback.

## Emails

All emails (digests and alerts) are built from one small component library in `src/email/` (dark theme, tables and inline styles so Gmail and Apple Mail render them the same; phone layout first, upgraded on wide screens). Keep each email under ~100 KB, since Gmail clips longer ones. A dry run logs the subject, text and full HTML of a digest without sending it: `npm run dev -- --port 8788 --var PUBLIC_URL:http://localhost:8788`, then `curl "http://localhost:8788/__scheduled?cron=5+8+*+*+*"`. The vinyl record image is `public/email/vinyl.png` (source and re-render command in `scripts/vinyl.html`).

## AI editor (optional)

The digests can have an AI editor. Once per digest it makes one call to OpenAI (Responses API, `gpt-6.1-sol`, strict JSON schema). The model keeps every chart that has data and adds up to three highlight cards a month (two a week) from the ones code found: a daily streak, late-night listening, one song all day, a long session, comebacks, a genre shift, a new obsession (never a card about the song of the period, which has its own section). It puts everything in order, picks a colour theme, and writes the headline, lead, preheader, section headings and one-line insights, with song titles in curly quotes. The subject line stays as code writes it.

Code computes every number, chart and card; the model only sees precomputed facts. Its plan is validated strictly: every number in its copy must appear in the input, no markup, links or emoji, length limits, every chart with data present. Anything wrong (API error, timeout, refusal, invalid plan, or an edited email over 100,000 bytes) sends the default email instead; the editor never fails the job. Each digest logs `{ job, editor: used | fallback | off, reason, model, ms, inputTokens, outputTokens, theme, sections }` plus the plan, so a fallback reason such as `number: lead 1,600` shows what to tune.

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

**Backfilling Liked Songs after an import (`/sync-full`).** The endpoint adds every track in D1 that isn't yet in Liked Songs (and qualifying frequent tracks). It is served on the custom domain (`curl -X POST https://<your domain>/sync-full -H "Authorization: Bearer $SECRET"`, needs the `SYNC_FULL_SECRET` secret set), or run it on Cloudflare's edge against production:

```bash
npx wrangler dev --remote -c wrangler.generated.toml   # uses production bindings and .dev.vars
curl -X POST http://localhost:8787/sync-full \
  -H "Authorization: Bearer $(grep '^SYNC_FULL_SECRET=' .dev.vars | cut -d= -f2-)"
```

**History and holiday playlists.** Their ids live in the D1 `state` table (`playlist:on_this_day`, `playlist:forgotten_favorites`, `playlist:holiday`). Deleting a playlist on Spotify switches it off; so does setting its value to `off`. Deleting the row makes the next run create a fresh one. For example:

```bash
npx wrangler d1 execute <D1_DATABASE_NAME> --remote -c wrangler.generated.toml \
  --command "INSERT INTO state(key, value) VALUES('playlist:holiday', 'off') ON CONFLICT(key) DO UPDATE SET value = 'off'"
```

The export's per-play fields (`ms_played`, `reason_end`, `shuffle`, `skipped`, `platform`, `conn_country`, ...) are on `plays` for imported rows; API plays leave them NULL.

**Changing or removing the Worker.** Never delete a Worker while its crons are live:

1. Set `crons = []` and deploy.
2. Wait about 15 minutes.
3. Delete the Worker.

Deleting one with live crons once left an orphaned trigger firing and stopped cron dispatch for every Worker on the account for a couple of hours (see [docs/PORTING.md](docs/PORTING.md)).

**Spotify API.** The Worker uses the long-standing endpoints: `PUT /me/tracks`, `POST /playlists/{id}/tracks`, batch `GET /artists`. The newer `/me/library` endpoints returned 400/405 when tested. Spotify has no playlist delete: "deleting" your own playlist unfollows it, which the jobs detect by its absence from `GET /me/playlists`.

**Database export / rollback.**

```bash
npx wrangler d1 export <D1_DATABASE_NAME> --remote --output=data/export.sql -c wrangler.generated.toml
sqlite3 data/restored.db < data/export.sql
scripts/verify-counts.sh data/restored.db <D1_DATABASE_NAME>   # must exit 0
```

## Layout

```
src/
  index.ts            cron dispatcher, /sync-full and the reconnect routes; runs each job with alerts + D1 query count logging
  alerts.ts           failure / recovery / sync-gap emails
  reconnect.ts        one-click Spotify reconnect (single-use link -> Spotify login -> new refresh token)
  email/              email design system: tokens + shell (layout.ts), blocks and charts (components.ts), themes, the digest's section registry
  editor/             optional AI editor for the digests: facts, highlights, prompt, plan validation, OpenAI client
  config.ts, env.ts   typed config from wrangler vars and secrets
  jobs/               sync, artist-playlists, hindi-favorites, history-playlists, holiday-playlist, digest (weekly + monthly), owned-playlists, playlist-cache backfill
  db/                 schema migrations, bulk json_each queries, state, query counter
  spotify/            fetch-based client (token refresh, retries, write gating), types, parsers
public/               static files served on the custom domain (email images)
scripts/              configure (deploy config -> wrangler config), token, import-history, live-write-test, verify-counts
test/                 vitest (@cloudflare/vitest-plugin); parity/ holds frozen fixtures
docs/PORTING.md       how this was ported from the original Python/Docker service
wrangler.toml         config template; deploy.config.example.json documents its keys
```

## License

[MIT](LICENSE). Security issues: see [SECURITY.md](SECURITY.md).
