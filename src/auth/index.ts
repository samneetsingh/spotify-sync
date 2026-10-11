// Ownership, claim, login and sessions (tasks/dashboard-plan.md sections 2 and 3).
// CONTRACT STUB from WP-0: WP-A implements every export below with these exact signatures.
// Until then the stubs throw "not implemented" only for what they own, so the router falls
// through for everything else, and the legacy one-click reconnect (src/reconnect.ts) keeps working.

import type { Env } from "../env";
import { readCookie } from "../http";
import { runSync } from "../jobs/sync";
import { handleReconnect } from "../reconnect";
import { withJob } from "../runtime";

/** The effective owner: SPOTIFY_USER_ID when set ("config"), else `state` owner:spotify_id ("claimed"). */
export interface Owner {
  id: string;
  source: "config" | "claimed";
}

/** A logged-in owner. Only the effective owner's sessions are valid. */
export interface Session {
  spotifyId: string;
  displayName: string | null;
  /** Epoch ms; sessions last 30 days (absolute). */
  expiresAt: number;
}

export type ClaimEmailResult = "owned" | "unconfigured" | "pending" | "sent";

/** Cookie base name: `__Host-session` (or `session` on an http:// dev origin, see src/http.ts). */
export const SESSION_COOKIE = "session";
export const SESSION_TTL_MS = 30 * 86_400_000;

/** Paths handleAuthRoutes answers (plus the legacy GET /reconnect, which redirects to /login). */
const AUTH_PATHS = new Set(["/login", "/claim", "/claim/resend", "/auth/callback", "/logout", "/logout/all"]);

const notImplemented = (what: string) => new Error(`not implemented: ${what} (WP-A)`);

/** The effective owner, or null while the instance is unclaimed. */
export async function getOwner(db: D1Database, env: Env): Promise<Owner | null> {
  throw notImplemented("getOwner");
}

/** The request's valid session (one D1 query), or null. */
export async function getSession(request: Request, env: Env): Promise<Session | null> {
  // No session cookie means nobody is logged in, whatever the implementation.
  if (!readCookie(request, SESSION_COOKIE, env.PUBLIC_URL)) return null;
  throw notImplemented("getSession");
}

/**
 * GET /login, GET /claim, POST /claim/resend, GET /auth/callback, POST /logout, POST /logout/all
 * and the legacy GET /reconnect; null for any other path. The router has already checked Origin
 * on non-GET requests.
 */
export async function handleAuthRoutes(request: Request, env: Env, ctx: ExecutionContext): Promise<Response | null> {
  // Legacy reconnect links (/reconnect, /reconnect/callback) until WP-A replaces them with /login.
  const reconnect = await handleReconnect(request, env, () =>
    // Sync right away with the new token; its success sends the "recovered" email.
    ctx.waitUntil(withJob(env, "sync", runSync).catch(() => {})),
  );
  if (reconnect) return reconnect;
  const { pathname } = new URL(request.url);
  if (AUTH_PATHS.has(pathname)) throw notImplemented(`${request.method} ${pathname}`);
  return null;
}

/** Called by the 10-minute sync cron: emails the single-use setup link while the instance has no owner. */
export async function ensureClaimEmail(env: Env, db: D1Database, now = Date.now()): Promise<ClaimEmailResult> {
  throw notImplemented("ensureClaimEmail");
}
