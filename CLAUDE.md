# CLAUDE.md — spotify-sync

Cloudflare Worker (TypeScript) + D1 that syncs recently played Spotify tracks and maintains Liked Songs, a frequent-plays playlist, per-artist playlists and a Hindi/Desi playlist. See README.md for what each job does and the operational runbooks.

## Commands

```bash
npm test              # vitest via @cloudflare/vitest-plugin (local simulated D1; never remote)
npm run typecheck     # Worker (tsconfig.json) + scripts (tsconfig.scripts.json)
npm run dev           # wrangler dev --env test (dry_run, remote TEST D1)
npm run deploy        # production; normally Workers Builds deploys on push to main
npm run token         # Spotify OAuth -> refresh token into D1 state table
npm run import-history -- <dir> [--dry-run]
```

## Architecture

- `src/index.ts`: `scheduled()` maps the cron string to a job (`*/10` sync, `0 3` artist-playlists, `0 4` hindi-favorites; `10 3`/`10 4` are accepted too). `fetch()` serves only `POST /sync-full` (Bearer `SYNC_FULL_SECRET`, constant-time compare). `withJob` runs migrations, alerting and D1 query counting around every job.
- `src/jobs/*`: each job takes `(config, db, spotifyClient)`. Write-mode gating: `SpotifyClient` blocks Spotify writes unless `WRITE_MODE=live`; jobs skip D1 *state* writes (`playlist_tracks`, `state`, `playlists`, `playlist_removals`, `playlist_exclusions`) in `dry_run`. Metadata (`tracks`, `plays`, `track_artists`, `artists`, `sync_runs`) is always written.
- `src/db/queries.ts`: bulk writes bind one JSON array and expand it with `json_each` (500 rows/statement). Keep it this way; D1 caps queries per invocation (1,000) and bound parameters per query (100).
- `src/db/schema.ts`: migrations. v7 baseline equals the original Python schema and records versions 1-7 (keeps a D1 export loadable by the old Python app); Worker-only changes start at v8.
- Spotify refresh token lives in D1 `state` (`spotify_refresh_token`), not in a secret, so the Worker can persist rotations.
- `SPOTIFY_ALL_PLAYLIST_ID` is only the namespace of the sync cursor key (`cursor_after_ms:<id>`); nothing is written to that playlist.

## Conventions

- Use the old Spotify endpoints (`PUT /me/tracks`, `POST /playlists/{id}/tracks`, batch `GET /artists?ids=`); the `/me/library` ones failed when audited.
- `artists.genres` must stay in the existing format: use `genresJson()` (Python `json.dumps` style).
- Parity fixtures in `test/parity/*.json` were generated from the original Python code and are frozen. Don't regenerate; add new behavior tests separately.
- Never log or print the refresh token or secrets. Scripts read credentials from `.dev.vars`.

## Gotchas

- **Never delete a Worker with live crons.** Set `crons = []`, deploy, wait ~15 min, then delete. Doing otherwise orphaned a trigger and stalled cron dispatch account-wide (docs/migration/PROGRESS.md, Phase 7).
- Cron changes take minutes (up to ~30) to propagate; don't redeploy repeatedly while waiting.
- `wrangler d1 execute --file` imports are atomic per file; very large single files can fail with `D1_RESET_DO`. Chunk them.
- `wrangler.toml` top level is production. `[env.test]` binds the test D1 with `remote = true`; vitest sets `remoteBindings: false` so tests never touch a remote database.
