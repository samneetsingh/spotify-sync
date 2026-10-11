# CLAUDE.md — spotify-sync

Cloudflare Worker (TypeScript) + D1 that syncs recently played Spotify tracks and maintains Liked Songs, a frequent-plays playlist, per-artist playlists and a Hindi/Desi playlist. See README.md for what each job does and the operational runbooks.

## Commands

```bash
npm test              # vitest via @cloudflare/vitest-plugin (local simulated D1; never remote)
npm run typecheck     # Worker (tsconfig.json) + scripts (tsconfig.scripts.json)
npm run configure     # deploy.config.json (or DEPLOY_CONFIG / --config) -> wrangler.generated.toml
npm run dev           # configure + wrangler dev --env test (dry_run, remote TEST D1)
npm run deploy        # configure + deploy to production; normally Workers Builds deploys on push to main
npm run token         # Spotify OAuth -> refresh token into D1 state table (creates the schema if needed)
npm run import-history -- <dir> [--dry-run]
```

## Config

- `wrangler.toml` is a **template**: per-deployment values are `{{KEY}}` placeholders. `scripts/configure.mjs` (plain Node, no deps) fills them from `--config <file>`, the `DEPLOY_CONFIG` env var (Workers Builds build variable) or `deploy.config.json`, and writes `wrangler.generated.toml` (or `--out`, must be in the repo root). It validates every key and never prints values. Keys with defaults are in its `DEFAULTS`; `deploy.config.example.json` lists every key.
- Every wrangler command needs `-c wrangler.generated.toml` (npm scripts do it). `scripts/lib.ts` passes it (or `$WRANGLER_CONFIG`, for another instance) and defaults `--db` to that config's production database. Never point a script at an instance by `--db` alone when several configs exist.
- `deploy.config*.json` (except the example) and `wrangler*.generated.toml` are gitignored and must never be committed. Keep owner-specific values (ids, domains, emails, usernames) out of tracked files.
- vitest renders the template with `deploy.config.example.json` into `wrangler.example.generated.toml` (raw `{{WORKER_NAME}}` isn't a valid Worker name). Adding a placeholder means adding it to the example (and to `DEFAULTS` if optional).

## Architecture

- `src/index.ts`: `scheduled()` maps the cron string to a job (`*/10` sync, `0 3` artist-playlists, `0 4` hindi-favorites, `5 8` history-playlists + holiday-playlist + weekly-digest + monthly-recap as separate jobs; `10 3`/`10 4` are accepted too). `fetch()` serves `POST /sync-full` (Bearer `SYNC_FULL_SECRET`, constant-time compare) and the reconnect routes; static files in `public/` are served before the Worker runs. The Worker is public only via its custom domain (`CUSTOM_DOMAIN`; `workers_dev` stays off). `withJob` runs migrations, alerting and D1 query counting around every job.
- `src/jobs/*`: each job takes `(config, db, spotifyClient)`. Write-mode gating: `SpotifyClient` blocks Spotify writes unless `WRITE_MODE=live`; jobs skip D1 *state* writes (`playlist_tracks`, `state`, `playlists`, `playlist_removals`, `playlist_exclusions`) in `dry_run`. Metadata (`tracks`, `plays`, `track_artists`, `artists`, `sync_runs`) is always written.
- `src/db/queries.ts`: bulk writes bind one JSON array and expand it with `json_each` (500 rows/statement). Keep it this way; D1 caps queries per invocation (1,000) and bound parameters per query (100).
- `src/db/schema.ts`: migrations. v7 baseline equals the original Python schema and records versions 1-7 (keeps a D1 export loadable by the old Python app); Worker-only changes start at v8. v9 adds the privacy export's per-play fields to `plays` (NULL for API plays).
- Owned playlists (`src/jobs/owned-playlists.ts`: On This Day, Forgotten Favorites, Holiday Favorites) are created on first use with ids in `state` (`playlist:<key>`, `off` disables). History playlists are rewritten via `replacePlaylistItems` only when the local day/week (`TIME_ZONE`) changes; Holiday Favorites is add-only (hindi pattern), recognising songs by title.
- `src/jobs/digest.ts`: weekly digest (Mon-Sun in `TIME_ZONE`, `state` `recap:last_week` = ISO week) and monthly recap (`recap:last_month`), sent through the alert binding whenever the key is behind; only `live` sends, dry runs log the HTML. Cover art via one batch `GET /tracks?ids=` + `GET /artists?ids=` at send time; failures fall back to placeholder tiles.
- `src/editor/`: optional AI editor for the digests. Off unless `AI_EDITOR=on` and the `OPENAI_API_KEY` secret is set; `state` `editor:mode`=`off` is a runtime kill switch and `editor:calls:<UTC YYYY-MM>` caps calls at 10/month (counted in every write mode, dry runs call the model too). One OpenAI Responses API call per digest (`gpt-6.1-sol`, strict `json_schema`, `store: false`, plain fetch). The model orders every section with data (`sectionSpecs` marks them all required, so it never drops a chart), adds up to 3/2 highlight cards (`buildEditorInput` drops any about the song of the period), picks a preset theme and writes copy (song titles in “curly quotes”); code computes every number and `validatePlan` rejects any number not in the input. `planDigest` never throws; `composeDigest` in `src/jobs/digest.ts` sends the default layout on any fallback or when the edited HTML is over 100,000 bytes. The period's seasonal theme (`src/email/themes.ts`) applies with or without the editor. Tests inject `fetch` through `EditorConfig`; vitest blanks `OPENAI_API_KEY` (`test/editor/test-env.test.ts` guards it).
- `src/email/`: the email design system (`layout.ts` tokens + shell, `components.ts` blocks/charts). Email HTML only: tables, inline styles, mobile-first with one `min-width:640px` upgrade block; no SVG/JS/positioning. Keep emails < 100 KB (Gmail clips at 102 KB). The vinyl image is a pre-rendered PNG (`public/email/vinyl.png`, source `scripts/vinyl.html`); bump `VINYL_PATH`'s `?v=` when it changes.
- `src/reconnect.ts`: login-failure alerts carry a single-use 7-day link (`state` `reconnect`); `/reconnect` -> Spotify OAuth (state = nonce) -> `/reconnect/callback` saves the refresh token only if `/me` is `SPOTIFY_USER_ID`. Requires the redirect URI `https://<CUSTOM_DOMAIN>/reconnect/callback` in the Spotify app.
- `scripts/import-history.ts` treats the privacy export as the source of truth for plays (>= 30 s) inside its span: it reconciles (insert/update/delete), it doesn't append.
- Spotify refresh token lives in D1 `state` (`spotify_refresh_token`), not in a secret, so the Worker can persist rotations.
- `SPOTIFY_ALL_PLAYLIST_ID` is legacy and optional: only the namespace of the sync cursor key (`cursor_after_ms:<id>`, default `default`); nothing is written to that playlist. Deployments that set it must keep their value.
- Cron strings are hard-coded in `src/index.ts` and must match `[triggers]` in `wrangler.toml`: change both.

## Conventions

- Use the old Spotify endpoints (`PUT /me/tracks`, `POST /playlists/{id}/tracks`, batch `GET /artists?ids=`); the `/me/library` ones failed when audited.
- `artists.genres` must stay in the existing format: use `genresJson()` (Python `json.dumps` style).
- Parity fixtures in `test/parity/*.json` were generated from the original Python code and are frozen. Don't regenerate; add new behavior tests separately.
- Never log or print the refresh token or secrets. Scripts read credentials from `.dev.vars`.

## Gotchas

- **Never delete a Worker with live crons.** Set `crons = []`, deploy, wait ~15 min, then delete. Doing otherwise orphaned a trigger and stalled cron dispatch account-wide (docs/PORTING.md).
- Cron changes take minutes (up to ~30) to propagate; don't redeploy repeatedly while waiting.
- Spotify has no playlist delete: "deleting" your own playlist only unfollows it, and writes to it still succeed. Detect it by its absence from `GET /me/playlists` (`followedPlaylistIds`), not from write errors.
- The first wrangler API call after it refreshes its expired OAuth token can fail with `7403` ("account not valid"); the next call works. `scripts/lib.ts` retries that once.
- `wrangler d1 execute --file` imports are atomic per file; very large single files can fail with `D1_RESET_DO`. Chunk them.
- `wrangler.toml` top level is production. `[env.test]` binds the test D1 with `remote = true`; vitest sets `remoteBindings: false` so tests never touch a remote database.
- Workers Builds: build command `npm test && npm run configure`, deploy command `npx wrangler deploy -c wrangler.generated.toml`, build variable `DEPLOY_CONFIG` (one-line JSON). A plain `npx wrangler deploy` fails on the template.
