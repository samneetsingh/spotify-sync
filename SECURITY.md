# Security

## Reporting a vulnerability

Please report security issues privately through GitHub's **Report a vulnerability** button (Security tab, private vulnerability reporting) rather than in a public issue. Include what you found, how to reproduce it, and its impact. Please allow a few days for a reply.

This is a personal project maintained in spare time, provided as is (see [LICENSE](LICENSE)); there is no bug bounty.

## What a deployment exposes

A deployed Worker runs its jobs on cron triggers, which aren't reachable over HTTP. `workers.dev` and preview URLs are off, so the only public surface is the custom domain, which serves:

- **`POST /sync-full`**: requires `Authorization: Bearer <SYNC_FULL_SECRET>`, compared in constant time. Without the secret set, it always answers 401.
- **`/reconnect` and `/reconnect/callback`**: answer 404 unless the request carries the single-use nonce from a login-failure alert email. A link expires after 7 days, works once, and only saves a refresh token for the Spotify account in `SPOTIFY_USER_ID`.
- **Static files in `public/`** (images used by the emails).

Everything else answers 404.

## Secrets

- `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET` and `SYNC_FULL_SECRET` are Worker secrets (`wrangler secret put`), and locally live in `.dev.vars`, which is gitignored.
- The Spotify refresh token is stored in the D1 `state` table so the Worker can save rotated tokens. Anyone with access to the D1 database can read it; scripts never print it.
- `deploy.config.json` (and the `DEPLOY_CONFIG` build variable) holds identifiers, not credentials: Worker and database names and ids, domain, Spotify username, email addresses. It is gitignored all the same.
