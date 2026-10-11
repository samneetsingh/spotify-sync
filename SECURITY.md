# Security

## Reporting a vulnerability

Please report security issues privately through GitHub's **Report a vulnerability** button (Security tab, private vulnerability reporting) rather than in a public issue. Include what you found, how to reproduce it, and its impact. Please allow a few days for a reply.

This is a personal project maintained in spare time, provided as is (see [LICENSE](LICENSE)); there is no bug bounty.

## Auth model

Each deployment has exactly one owner: a Spotify account.

- **Claiming.** A fresh instance has no owner. Its 10-minute cron emails a setup link to `ALERT_EMAIL_TO`, the only destination its `send_email` binding allows (one deploy config field sets both). The link carries a 256-bit single-use nonce that expires after 7 days. Whoever completes it with Spotify becomes the owner, pinned in D1 (`state` `owner:spotify_id`); the first to finish wins and the claim can't be repeated from the web. The cron sends at most 3 links. The landing page's resend button only works while unclaimed, is limited to once an hour and 5 a day, and still only emails the configured address. While a Spotify app is in development mode, Spotify itself also refuses accounts that aren't on the app's allow-list.
- **Logging in.** "Log in with Spotify" is a standard authorization-code flow with one redirect URI (`/auth/callback`). Its state value is a random 256-bit token in a short-lived (10-minute) HttpOnly cookie, compared in constant time; Spotify is only called for a matching state. The callback rejects every Spotify account except the owner's, without creating a session or changing anything. Reconnecting an expired Spotify login is the same login.
- **Sessions.** A session cookie holds 32 random bytes (`__Host-session`: HttpOnly, Secure, SameSite=Lax, Path=/). D1 stores only its SHA-256, so a database export contains no usable sessions. Sessions last 30 days (absolute), a new one is issued at every login, and one is valid only while its account is the owner. "Log out" deletes the session; "Log out everywhere" deletes them all.
- **CSRF.** Every request other than GET/HEAD must carry an `Origin` equal to the dashboard's origin (sibling subdomains are refused), or, without a usable Origin, `Sec-Fetch-Site: same-origin`. GET requests never change state, except the OAuth callback, which is bound to its state cookie.
- **Responses.** HTML gets a strict Content-Security-Policy with a per-response nonce (no inline scripts or style attributes; scripts only from the Worker's origin), `frame-ancestors 'none'`, `Referrer-Policy: same-origin` (OAuth codes and setup links never reach other sites in a Referer), `nosniff`, `no-store` and `noindex`. Everything rendered is escaped, including names and errors that come from Spotify. Login redirects (`next=`) only go to paths on the same origin.

## What a deployment exposes

A deployed Worker runs its jobs on cron triggers, which aren't reachable over HTTP. `workers.dev` and preview URLs are off, so the only public surface is the custom domain:

| Without a session | What it allows |
|---|---|
| `GET /` | A landing page: "Log in with Spotify", "Almost ready" (unclaimed) or "still being set up". It shows no owner details. |
| `GET /login` | Starts a Spotify login (no database writes); only the owner can finish it |
| `GET /claim?k=` | The emailed setup link; anything but a valid, unexpired nonce gets a 404 |
| `POST /claim/resend` | Emails the configured address a setup link, while unclaimed, within the limits above |
| `GET /auth/callback` | Completes a login or claim started from this browser |
| `GET /reconnect` | Redirects to `/login` (links in older alert emails) |
| Static files | Email images, the import page's uploader script (`/import.js`), `robots.txt` (disallows everything) |

Everything else (home, settings, activity, sync and preview actions, history import, log out everywhere) needs the owner's session: pages redirect to the login, other requests get 401. History uploads also have size and count limits, one import runs at a time, and the zip reader rejects encrypted, zip64 and oversized entries. Other paths answer 404.

To protect the Spotify and email quotas, "Sync now" won't start while a sync is running, and digest previews have a 10-minute cooldown. Optionally, a Cloudflare WAF rate-limiting rule on `/login`, `/claim` and `/auth/` limits login attempts per IP.

## Data and secrets

- `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET` and the optional `OPENAI_API_KEY` are Worker secrets (`wrangler secret put`), and locally live in `.dev.vars`, which is gitignored.
- The Spotify refresh token is stored in the D1 `state` table so the Worker can save rotated tokens. **Anyone with access to the D1 database or the Cloudflare account controls the instance**: they can read the token and change the owner. Scripts and logs never print tokens, nonces or OAuth codes. Workers' request logs (visible only to account members) do record request URLs, including single-use setup links and OAuth codes.
- A history upload (which includes the IP addresses Spotify recorded) is staged in an R2 bucket and deleted as soon as it's read, usually within minutes; a bucket lifecycle rule deletes anything left after 7 days. The plays it contains are kept in D1 like every other play.
- `deploy.config.json` (and the `DEPLOY_CONFIG` build variable) holds identifiers, not credentials: Worker and database names and ids, domain, email addresses, setting defaults. It is gitignored all the same.
