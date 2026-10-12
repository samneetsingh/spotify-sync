# spotify-sync

[![CI](https://github.com/samneetsingh/spotify-sync/actions/workflows/ci.yml/badge.svg)](https://github.com/samneetsingh/spotify-sync/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A Cloudflare Worker that keeps your Spotify library tidy from your listening history, with a small dashboard on your own domain:

- **Every 10 minutes**: records recently played tracks in D1, adds tracks with enough plays to a **Frequent Plays** playlist and, if you switch it on, adds every track you play to **Liked Songs**.
- **03:00 UTC**: creates and fills **per-artist playlists** for artists you play a lot, respects tracks you remove, and stops managing playlists you delete.
- **04:00 UTC**: fills a **Hindi Favorites** playlist based on artist genres (off unless you switch it on).
- **08:05 UTC** (shortly after midnight US Pacific; see [Schedules](#schedules) to move it): rewrites two playlists from the whole history. **On This Day** holds each past year's most played tracks on today's date in your time zone, oldest year first. **Forgotten Favorites** is a new weekly set of 50 songs you've played 20+ times but not in over a year. The same daily run also keeps **Holiday Favorites** filled from October 1 to January 6: every song whose title marks it as a holiday song (Christmas, Jingle, Let It Snow, ...) that you've played 3+ times. It only adds, so songs you remove stay removed. Every Monday it emails a **weekly digest** of the previous Monday-to-Sunday week, and on the first of each month a **monthly recap** of the previous month. Both show top tracks and artists with cover art, listening by day and hour, and new finds; the recap adds genres, a 12-month trend, comebacks and throwbacks. A failed send is retried the next day.

The Worker creates every playlist it manages the first time it needs it. All state lives in a D1 database (plays, tracks, artists, playlist contents, settings). Playlists are built from that history, not from live API calls.

**The dashboard** (`https://<your domain>/`) is where the owner logs in with Spotify, switches features on and off, previews the digests, sees what ran and what failed, syncs on demand, and imports their full listening history from Spotify's privacy export. Failures email you; reconnecting an expired Spotify login is just logging in again.

It began as a Python service on a home server and was ported to Workers + D1; [docs/PORTING.md](docs/PORTING.md) covers the decisions and lessons.

## Deploy your own

You need:

- A Cloudflare account on the **Workers Paid** plan. The free plan's CPU and subrequest limits are too small for the daily jobs and the history import, and it allows only 5 cron triggers per account; one instance uses 4.
- A domain in a zone on that account, for the dashboard and email links.
- That domain (or another one on the account) onboarded to Cloudflare Email Service for sending, for the setup link, alerts and digests.
- Node.js 22+ and a Spotify account.

### 1. Install

```bash
git clone <your fork> spotify-sync && cd spotify-sync
npm install
npx wrangler login
```

### 2. Create a Spotify app

At [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard), create an app with the **Web API** and add one redirect URI:

- `https://<your domain>/auth/callback`

The setup link, logging in and reconnecting all use it. For local development you can also add `http://127.0.0.1:8788/auth/callback` (Spotify rejects `localhost`; use the loopback IP).

While the app is in development mode, only Spotify accounts listed under **User Management** can log in (Spotify limits development-mode apps to a few users), so add yours. Copy the client ID and secret:

```bash
cp .dev.vars.example .dev.vars   # fill in SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET
```

`.dev.vars` (gitignored) is read by `wrangler dev` and the scripts in `scripts/`.

### 3. Create the databases and the import bucket

```bash
npx wrangler d1 create spotify-sync        # production
npx wrangler d1 create spotify-sync-test   # used by `npm run dev` (dry run)
npx wrangler r2 bucket create spotify-sync-imports
npx wrangler r2 bucket lifecycle add spotify-sync-imports delete-imports imports/ --expire-days 7
```

Note both database ids. If wrangler offers to add a binding to your config, decline: the template already has them. The bucket is named `<WORKER_NAME>-imports` and only holds uploaded exports for the minutes it takes to read them; the lifecycle rule deletes anything left behind after 7 days. Skip it if you set `"imports": false` (see [History import](#history-import)).

### 4. Write your deploy config

`wrangler.toml` is a template: everything specific to your deployment is a `{{KEY}}` placeholder, filled from `deploy.config.json` (gitignored).

```bash
cp deploy.config.example.json deploy.config.json   # edit it
npm run configure                                  # writes wrangler.generated.toml (gitignored)
```

| Key | Required | Value |
|---|---|---|
| `WORKER_NAME` | no (default `spotify-sync`) | Worker name; set it for a second instance on the same account. The import bucket and Workflow are named after it. |
| `D1_DATABASE_NAME`, `D1_DATABASE_ID` | yes | The production database from step 3 |
| `TEST_WORKER_NAME`, `TEST_D1_DATABASE_NAME`, `TEST_D1_DATABASE_ID` | yes | Name for the local test Worker (`npm run dev`) and the test database |
| `CUSTOM_DOMAIN` | yes | Hostname the Worker is served on, e.g. `spotify-sync.example.com`, in a zone on your Cloudflare account |
| `ALERT_FROM` | yes | Sender address, on a domain onboarded to Cloudflare Email Service |
| `ALERT_EMAIL_TO` | yes | Your inbox: the setup link, alerts and digests go here, and only here |
| `settings` | no | First-run defaults for the dashboard settings, e.g. `{"timeZone": "Europe/Berlin", "liked": true}` (see [Settings](#settings)) |
| `imports` | no, `true` | `false` leaves out the R2 bucket and the Workflow and hides the history import |

`configure` turns these into the Worker's runtime vars:

| Var | Value |
|---|---|
| `WRITE_MODE` | `live` (see [Write modes](#write-modes)) |
| `PUBLIC_URL` | `https://<CUSTOM_DOMAIN>`: the dashboard, its Spotify login, email links and images |
| `ALERT_FROM`, `ALERT_EMAIL_TO` | As above. The `send_email` binding gets the same `ALERT_EMAIL_TO` as its only allowed destination, so the two can't diverge. |
| `SETTINGS` | Your `settings` object as JSON |

Everything you choose day to day (playlists, emails, time zone, AI editor) is a dashboard setting, and the Worker keeps its own ids (owner, playlists, sync cursor) in D1. No custom domain? Delete the `routes` and `PUBLIC_URL` lines from `wrangler.toml`: the crons still run (connect Spotify with `npm run token`), but there's no dashboard, no Spotify login and no email images.

### 5. Set the secrets

```bash
npx wrangler secret put SPOTIFY_CLIENT_ID -c wrangler.generated.toml       # say yes to creating the Worker
npx wrangler secret put SPOTIFY_CLIENT_SECRET -c wrangler.generated.toml
npx wrangler secret put OPENAI_API_KEY -c wrangler.generated.toml          # optional: the AI editor
```

### 6. Deploy and claim it

```bash
npm run deploy   # configure + wrangler deploy
```

The custom domain is created on deploy. Open `https://<your domain>`: it says **Almost ready**. Within 10 minutes the Worker emails `ALERT_EMAIL_TO` a setup link (check spam). Click **Connect Spotify** and log in: whoever completes the link with Spotify becomes the owner, so it goes only to the address you configured, works once, and expires after 7 days. The cron sends it at most 3 times; the landing page's **Resend** button sends another (once an hour, 5 a day).

You land on **Settings** with a welcome banner and get a welcome email. Review the defaults; the first sync runs within 10 minutes and backfills the last 24 hours (Spotify's recently-played history only reaches back 50 plays). From then on, `https://<your domain>` shows **Log in with Spotify**, and only the owner's Spotify account can log in.

The Spotify refresh token lives in the D1 `state` table, not in a secret, so the Worker can save rotated tokens itself. Watch the jobs in Workers Logs or with `npx wrangler tail -c wrangler.generated.toml`.

**Without email**, delete the `ALERT_FROM` and `ALERT_EMAIL_TO` lines and the `[[send_email]]` block from `wrangler.toml` (`configure` then stops asking for them). Alerts and digests are skipped, and there's no setup link: the landing page says the developer still needs to finish setup. Pin yourself as the owner in D1, then use **Log in with Spotify**:

```bash
npx wrangler d1 execute <D1_DATABASE_NAME> --remote -c wrangler.generated.toml \
  --command "INSERT INTO state(key, value) VALUES('owner:spotify_id', '<your Spotify username>')"
```

Your username is on your Spotify account overview. The tables are created by the Worker's first run (a cron or a page view), so open the domain once first.

**Optional, from the command line:** `npm run token` runs the Spotify login on your machine and saves the refresh token to D1, so the jobs run without the dashboard (e.g. without a custom domain). It needs `SPOTIFY_REDIRECT_URI` (default `http://127.0.0.1:8888/callback`) registered in the Spotify app. It doesn't make anyone the owner: with email set up, the setup link still goes out.

### 7. Optional extras

- **Your whole history.** Request your *Extended streaming history* from Spotify's privacy page, then upload it from the dashboard's Settings page (see [History import](#history-import)).
- **Email Service.** Onboard your sending domain with `npx wrangler email sending enable <domain>` or the dashboard. The binding can only send to `ALERT_EMAIL_TO`; verify that address if Cloudflare asks you to.
- **Rate limiting.** A Cloudflare WAF rate-limiting rule on `/login`, `/claim` and `/auth/` (the free plan includes one rule per zone) limits login attempts per IP. The Worker already rate-limits the only unauthenticated action that sends email.

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

### Upgrading

Instances deployed before the dashboard had more deploy config keys: `SPOTIFY_USER_ID`, `SPOTIFY_ALL_PLAYLIST_ID`, `SPOTIFY_FREQUENT_PLAYLIST_ID`, `SPOTIFY_HINDI_FAVORITES_PLAYLIST_ID`, `TIME_ZONE`, `FREQUENT_MIN_PLAYS` and `AI_EDITOR`. The Worker now keeps these in D1: on its first run with them it copies them once (owner, playlist ids, and the settings that would otherwise change), so behaviour stays the same. The order matters:

1. **Spotify app:** add the redirect URI `https://<your domain>/auth/callback`.
2. **R2:** create the bucket `<WORKER_NAME>-imports` and its lifecycle rule (step 3 above) before deploying, or set `"imports": false`.
3. **Deploy this version with your current deploy config, unchanged.** `configure` warns that it rendered the pre-dashboard keys as vars; that's expected.
4. **Wait for the first cron** (within 10 minutes), then log in at `https://<your domain>`, switch on **Advanced** in Settings and check **Activity** for "Moved the deploy config's settings into the dashboard: ...". (`wrangler tail` shows `{"legacyConfig":"imported"}`.) Settings now shows your previous behaviour, each with a **Reset** button.
5. **Then remove those keys** from your deploy config (and paste the smaller `DEPLOY_CONFIG` into Workers Builds), and redeploy. Nothing changes.
6. **Clean up:** remove the old `https://<your domain>/reconnect/callback` redirect URI and the `SYNC_FULL_SECRET` secret (`npx wrangler secret delete SYNC_FULL_SECRET -c wrangler.generated.toml`); `POST /sync-full` is gone. Old reconnect links in alert emails now open the login.

Don't skip step 4. Without the copied values, the instance would look unclaimed (and email a setup link), fall back to UTC and the default settings, and create a second Frequent Plays playlist. Your history needs no migration, and Liked Songs stays on for instances that already have plays.

### Running more than one instance

One fork can run several independent instances, say yours and a friend's, each with its own Worker, D1 database, import bucket, custom domain, sender, Spotify account and inbox. One Spotify app and one Cloudflare account can serve them all. For each extra instance:

1. **Spotify app:** add `https://<their domain>/auth/callback`. While the app is in development mode, add the email of their Spotify account under **User Management**.
2. **Email:** onboard their domain to Email Service for sending, and give the instance its own sender on it (e.g. `spotify-sync@<their domain>`). Check the domain's sending DNS records (SPF, DKIM, DMARC) in the Email Service dashboard, and verify their inbox as a destination address if Cloudflare asks. Optional: an Email Routing rule forwarding the sender address to their inbox, so replies reach them.
3. **D1 and R2:** `npx wrangler d1 create <name>`, then create `<name>-imports` and its lifecycle rule as in step 3. Bucket and Workflow names are unique per account, which is why they derive from `WORKER_NAME`.
4. **A deploy config**, e.g. `deploy.config.friend.json` (all `deploy.config*.json` files are gitignored): their `WORKER_NAME`, database, `CUSTOM_DOMAIN`, `ALERT_FROM` (the new sender), `ALERT_EMAIL_TO` (their inbox), and `settings` for their defaults, e.g. `{"timeZone": "America/Los_Angeles"}`. The `TEST_*` keys can repeat yours. No Spotify ids are needed.
5. **Secrets** on their Worker: the same `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET`, and `OPENAI_API_KEY` if they get the AI editor.
6. **Deploy**, either with its own Workers Builds project (same repository, build and deploy commands, their `DEPLOY_CONFIG`; non-production builds off), or locally:

   ```bash
   npm run configure -- --config deploy.config.friend.json --out wrangler.friend.generated.toml
   npx wrangler secret put SPOTIFY_CLIENT_ID -c wrangler.friend.generated.toml   # and the other secrets
   npx wrangler deploy -c wrangler.friend.generated.toml
   ```

   The scripts take the config from `WRANGLER_CONFIG` (e.g. `WRANGLER_CONFIG=wrangler.friend.generated.toml npm run import-history -- <export> --dry-run`), default `--db` to that config's production database, and print it before writing.
7. **Check** that `https://<their domain>` says **Almost ready**; the setup email goes out at the next 10-minute cron. Tell them to expect it (and to check spam). Once they've connected, confirm their landing page shows **Log in with Spotify**.

Each instance uses 4 cron triggers and one Worker; check the [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) for your plan (Workers Paid allows 250 cron triggers per account).

## The dashboard

| Page | What's there |
|---|---|
| Home | Your listening at a glance: song of the week, this week and month so far (with changes against the same point last week and month), top tracks, artists and genres, listening by day (this week, the last 30 days or the last 12 months), when you listen, your streak and best day, what's new to you and a throwback. A status chip shows whether syncing is healthy and links to Settings |
| Settings | Most used first: problems (failing jobs with their last error, only while there are any); every [setting](#settings) with where its value comes from, and under it what it's doing: a playlist's link (or **Recreate** for one you deleted in Spotify), a digest's next send and **Send me a preview**, the AI edits used; then Spotify status and **Sync now** (on top while Spotify needs you), the [history import](#history-import) and, with **Advanced** on, **Reconnect Spotify** / **Log out everywhere**. Advanced also shows problem alerts and the time zone |
| Activity | With **Advanced** on: recent syncs, jobs, emails, logins and setting changes, and the latest Spotify changes |

**Who can log in.** The owner is the Spotify account that completed the setup link, pinned in D1 (`state` `owner:spotify_id`). **Log in with Spotify** accepts only that account and saves its fresh refresh token, so logging in also reconnects an expired Spotify login. Sessions last 30 days; **Log out** ends this one, **Log out everywhere** all of them. To reset the owner, delete `owner:spotify_id` and the `sessions` rows in D1: the next cron emails a new setup link, and whoever completes it becomes the owner (until then the jobs keep using the old Spotify login).

## Settings

| Setting | Default | What it does |
|---|---|---|
| `liked` | off | Add every track you play to Liked Songs. Turning it on asks for confirmation: existing likes are untouched, and turning it off later doesn't remove what it added. |
| `frequent` | on | Frequent Plays playlist |
| `frequentMinPlays` | 5 | Plays a song needs to join Frequent Plays (2-100) |
| `artistPlaylists` | on | Per-artist playlists |
| `hindiFavorites` | off | Hindi Favorites playlist |
| `onThisDay`, `forgottenFavorites`, `holiday` | on | History and holiday playlists |
| `alerts` | on | Failure, recovery and sync-gap emails (shown with `advanced` on) |
| `digestWeekly`, `digestMonthly` | on | Weekly digest, monthly recap |
| `aiEditor` | off | The digests' [AI editor](#ai-editor-optional); shown only when `OPENAI_API_KEY` is set |
| `timeZone` | `UTC` | When your day and week start: history playlists, the holiday season, digests, times in emails and on the dashboard (shown with `advanced` on) |
| `advanced` | off | Shows the Activity page, problem alerts, the time zone and the account controls on the dashboard |

**Precedence**, per setting: a value changed on the dashboard, then the deploy config's `settings` (the `SETTINGS` var), then the default above. The dashboard stores only values that differ from the layer below, and **Reset** removes one, so a later change to the deploy config or the defaults applies again. An invalid value never breaks a job: it's skipped for the next layer and listed at the top of the Settings page. Jobs read the settings once per run; changes apply from the next run.

## History import

Spotify's recently-played API only reaches back 50 plays. For everything before, request **Extended streaming history** at spotify.com/account/privacy (it can take up to 30 days), then open **History import** on the dashboard's Settings page:

1. **Upload** the zip Spotify emails you (up to 300 MB), or the `Streaming_History_Audio_*.json` files inside it (up to 40). Keep the tab open while it uploads; that's the only part that needs it.
2. The Worker reads it in the background and emails you when it's **ready to review**: per year, the plays it will add, complete (adding the export's details to plays it already has) and remove. It warns if the export looks like another account's, or would remove many previously imported plays.
3. **Import** applies it month by month. Optionally it also backfills **Frequent Plays** (on by default) and **Liked Songs** (off by default, with the same confirmation as the setting). You get an email when it's done; the next nightly run builds artist playlists from the full history.

Inside the export's span, plays become exactly its streams of 30 seconds or more: missing ones are inserted, shorter ones and the live sync's less precise copies are removed, and plays after the span are untouched. The same rules as `npm run import-history` (both use `src/import/parse.ts` and `plan.ts`).

**What it needs:**

- **The R2 bucket** `<WORKER_NAME>-imports` with its lifecycle rule (prefix `imports/`, delete after 7 days). Uploads are deleted as soon as they're read, so the raw export (which includes IP addresses) stays there for minutes; the rule is the backstop. R2 also aborts unfinished multipart uploads after 7 days by default.
- **Workflows**: the `ImportWorkflow` class, deployed with the Worker as `<WORKER_NAME>-import`. Nothing to create.
- **Workers Paid**, which the project needs anyway: a full import is a couple of hundred Workflow steps, some needing several seconds of CPU.

Cost on Workers Paid is effectively zero (minutes of R2 storage, a few hundred Workflow steps, and a few million D1 rows written, inside the included 50 million). `"imports": false` in the deploy config leaves out the bucket and the Workflow and hides the history import; `npm run import-history` still works from the command line.

## Commands

| Command | What it does |
|---|---|
| `npm test` | Unit, parity and write-mode tests (local simulated D1, R2 and Workflows, mocked Spotify; the template is filled with the example config) |
| `npm run typecheck` | Type-checks the Worker and the scripts |
| `npm run configure` | Writes `wrangler.generated.toml` from `deploy.config.json` (or `DEPLOY_CONFIG`; `-- --config <file> --out <file>` for another instance) |
| `npm run dev` | Runs the Worker locally in `dry_run` against the **test** D1 (R2, Workflows and email simulated). Trigger a job with `curl "http://localhost:8787/__scheduled?cron=*/10+*+*+*+*"`. For the dashboard: `npm run dev -- --port 8788 --var PUBLIC_URL:http://127.0.0.1:8788` |
| `npm run deploy` | Configures and deploys to production (or let Workers Builds do it on push) |
| `npm run token` | Optional: Spotify login from the command line; creates the schema if needed and writes the refresh token to D1 (`-- --db <name>` for another database) |
| `npm run import-history -- <dir>` | The history import from the command line: reconciles D1 with the export's JSON files in `<dir>` (pass the whole folder), then fetches artist credits and metadata. `--dry-run` prints the per-year diff without writing. |
| `npm run live-write-test` | Creates, fills, replaces and deletes a throwaway playlist to check real Spotify writes |

The scripts use `wrangler.generated.toml`, or the file in `WRANGLER_CONFIG`. For other wrangler commands, pass `-c wrangler.generated.toml` yourself.

## Configuration

Runtime vars come from your deploy config (see [step 4](#4-write-your-deploy-config)); bindings, crons and the template's structure live in `wrangler.toml`. Secrets, set with `npx wrangler secret put <NAME> -c wrangler.generated.toml` and locally in `.dev.vars`:

- `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`
- `OPENAI_API_KEY` (optional, for the [AI editor](#ai-editor-optional))

### Write modes

`WRITE_MODE` (`live` in production, `dry_run` in the test environment):

| Mode | Spotify writes | D1 state writes |
|---|---|---|
| `live` | yes | yes |
| `shadow` | no | yes |
| `dry_run` | no | no |

In every mode the Worker still records plays and track metadata, and every Spotify write (or would-be write) is logged in the `worker_actions` table. Digests and previews are only sent in `live`; other modes log them. Keep `dry_run` runs short: the sync cursor doesn't advance, and recently-played only returns the last 50 plays.

### Schedules

Cron schedules are in UTC, in `wrangler.toml` `[triggers]`. `src/schedule.ts` maps each exact cron string to its jobs, so **change both together**. Cron changes take a few minutes (up to about 30) to propagate; don't redeploy repeatedly while waiting.

## Alerts

With the `alerts` setting on, failures email `ALERT_EMAIL_TO` through Cloudflare Email Service:

- **A job throws:** you get an immediate alert, a reminder every 6 hours while it keeps failing, and a note when it recovers. The dashboard shows the failing job and its last error.
- **Syncs stop for more than 45 minutes:** you get a "sync resumed after a gap" email on the first run afterwards. While crons aren't firing at all, nothing can send mail; the gap email arrives once they resume.

An expired Spotify login shows up as a failing sync. Its email has a **Reconnect Spotify** button that opens the dashboard's Spotify login: logging in saves the new refresh token and, while the sync is failing, syncs right away (you then get the "recovered" email).

## Emails

All emails (digests, alerts, the setup and welcome emails, import updates) are built from one small component library in `src/email/` (dark theme, tables and inline styles so Gmail and Apple Mail render them the same; phone layout first, upgraded on wide screens). Keep each email under ~100 KB, since Gmail clips longer ones. **Send me a preview** on the dashboard sends last week's digest or last month's recap marked "[Preview]" without affecting the real ones. A dry run logs the subject, text and full HTML instead of sending: `npm run dev -- --port 8788 --var PUBLIC_URL:http://127.0.0.1:8788`, then `curl "http://127.0.0.1:8788/__scheduled?cron=5+8+*+*+*"`. Locally, `wrangler dev` writes every email it would send to a file under `.wrangler/tmp/email/` and logs the path. The vinyl record image is `public/email/vinyl.png` (source and re-render command in `scripts/vinyl.html`).

## AI editor (optional)

The digests can have an AI editor. Once per digest it makes one call to OpenAI (Responses API, `gpt-6.1-sol`, strict JSON schema). The model keeps every chart that has data and adds up to three highlight cards a month (two a week) from the ones code found: a daily streak, late-night listening, one song all day, a long session, comebacks, a genre shift, a new obsession (never a card about the song of the period, which has its own section). It puts everything in order, picks a colour theme, and writes the headline, lead, preheader, section headings and one-line insights, with song titles in curly quotes. The subject line stays as code writes it.

Code computes every number, chart and card; the model only sees precomputed facts. Its plan is validated strictly: every number in its copy must appear in the input, no markup, links or emoji, length limits, every chart with data present. Anything wrong (API error, timeout, refusal, invalid plan, or an edited email over 100,000 bytes) sends the default email instead; the editor never fails the job. Each digest logs `{ job, editor: used | fallback | off, reason, model, ms, inputTokens, outputTokens, theme, sections }` plus the plan, so a fallback reason such as `number: lead 1,600` shows what to tune.

**Turning it on.** Set the `OPENAI_API_KEY` secret (`npx wrangler secret put OPENAI_API_KEY -c wrangler.generated.toml`); the Settings page then shows **AI editor for digests**. Without the key the setting is hidden and off. Use a service-account key from a dedicated OpenAI project with a monthly budget. Locally the key goes in `.dev.vars`, and the setting follows the test database's settings (off until you switch it on in the local dashboard).

**What goes to OpenAI:** the digest's facts: the period, totals, top track and artist names with play counts, genres, the busiest day and peak hour, new and returning artists, throwbacks, the highlight cards' facts (with the Spotify ids of their songs or artists), the section catalog and the default copy. Nothing else from D1, and no tokens or email addresses. Requests set `store: false`, so OpenAI doesn't keep the response for later retrieval (its standard API data policy still applies).

**Switches and cost.**

- Kill switch, no deploy needed: `npx wrangler d1 execute <D1_DATABASE_NAME> --remote -c wrangler.generated.toml --command "INSERT INTO state(key,value) VALUES('editor:mode','off') ON CONFLICT(key) DO UPDATE SET value='off'"`. Delete the row to turn it back on.
- Monthly cap: `state` `editor:calls:<UTC YYYY-MM>` counts calls (before each call, dry runs and previews included); at 10 the digests use the default layout until the next month. The dashboard shows how many are used.
- Cost: about $0.01-0.04 per digest with `gpt-6.1-sol` ($2 in / $10 out per million tokens; the first real runs used 2-3k input and 0.5-0.8k output tokens, about $0.01 each), so at most about $0.25 a month for 4-5 weekly digests and one recap; the cap bounds it at about $0.40.

**Seasonal themes** don't need the AI: a digest whose last day falls in a season gets its colours and hero greeting (Halloween Oct 15 to Nov 1, winter holidays in December, new year in January, summer Jun 21 to Aug 31); other periods stay Spotify green. With the editor on, it picks between the default and that period's seasonal theme. All themes pass the contrast checks in `src/email/themes.ts`.

## Maintenance

**Playlists the Worker created.** Their ids live in the D1 `state` table (`playlist:frequent`, `playlist:hindi`, `playlist:on_this_day`, `playlist:forgotten_favorites`, `playlist:holiday`). Deleting one in Spotify switches it off (the daily runs notice it's gone); the dashboard then offers **Recreate**, which makes the next run create a fresh one. To stop one without deleting it, switch its setting off.

**Liked Songs and Frequent Plays for old plays.** The history import's options backfill both from your whole history.

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
  index.ts            entry: scheduled() -> schedule.ts; fetch() -> Origin check, auth, import, dashboard, 404
  schedule.ts         cron -> jobs, the setup-email/connected gate, housekeeping
  runtime.ts          withJob (migrations, settings, alerts, activity, D1 query count), email configs, legacy config import
  settings.ts         the settings registry, precedence, load/save
  auth/               owner, setup link (claim), Spotify login (one OAuth callback), sessions
  dashboard/          server-rendered TSX pages (landing, home, settings, activity), their data, actions, styles
  import/             history import: upload routes, zip reader, parser, staging, review, apply, Workflow, emails
  http.ts             security headers, CSP nonce, cookies, CSRF (Origin) check
  activity.ts         the dashboard's activity log
  alerts.ts           failure / recovery / sync-gap emails
  emails/             account emails (setup link, welcome)
  email/              email design system: tokens + shell (layout.ts), blocks and charts (components.ts), themes, the digest's section registry
  editor/             optional AI editor for the digests: facts, highlights, prompt, plan validation, OpenAI client
  config.ts, env.ts   typed config from vars, secrets and settings
  jobs/               sync, artist-playlists, hindi-favorites, history-playlists, holiday-playlist, digest (weekly + monthly), owned-playlists, playlist-cache backfill
  db/                 schema migrations, bulk json_each queries, state, query counter
  spotify/            fetch-based client (token refresh, retries, write gating), types, parsers
public/               static files served before the Worker: email images, import.js (the uploader), robots.txt
scripts/              configure (deploy config -> wrangler config), token, import-history, live-write-test, verify-counts
test/                 vitest (@cloudflare/vitest-plugin); parity/ holds frozen fixtures
docs/PORTING.md       how this was ported from the original Python/Docker service
wrangler.toml         config template; deploy.config.example.json documents its keys
```

## License

[MIT](LICENSE). Security issues: see [SECURITY.md](SECURITY.md).
