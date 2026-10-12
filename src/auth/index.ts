// Ownership, claim, login and sessions.
//
// Routes (handleAuthRoutes; the router has already checked Origin on everything but GET/HEAD):
// - GET  /login?next=&switch=1  owner only; 302 to Spotify (the __Host-oauth cookie carries state)
// - GET  /claim?k=              the emailed setup link; 302 to Spotify while unclaimed, else 404
// - POST /claim/resend          rate-limited setup email (once an hour, 5 a day), only while unclaimed
// - GET  /auth/callback         the one OAuth redirect URI: claim, login and reconnect
// - POST /logout, /logout/all   this session / every session
// - GET  /reconnect             legacy alert links: 302 to /login ("reconnect" is now logging in)
// The pages these routes answer with (expired login, wrong account, ...) are in pages.tsx.

import { logActivity } from "../activity";
import { sendEmail } from "../alerts";
import { getState } from "../db/state";
import type { Env } from "../env";
import { welcomeEmail } from "../emails/account";
import { authRequired, redirect, redirect303 } from "../http";
import { runSync } from "../jobs/sync";
import { emailConfig, quietly, withJob } from "../runtime";
import { loadSettings } from "../settings";
import { constantTimeEqual } from "../utils/crypto";
import { canSendClaim, CLAIM_KEY, isValidClaimNonce, resendClaimEmail, sentTime } from "./claim";
import { canLogIn, clearOAuthCookie, completeOAuth, publicOrigin, readOAuthCookie, safeNext, startOAuth, type OAuthState, type SpotifyLogin } from "./oauth";
import { getOwner, OWNER_KEY, saveLoginStatements, type Owner } from "./owner";
import {
  alreadySetUpPage,
  checkEmailPage,
  claimLinkPage,
  loginCancelledPage,
  loginExpiredPage,
  loginMismatchPage,
  methodNotAllowedPage,
  resendFailedPage,
  spotifyFailedPage,
  unconfiguredPage,
  wrongAccountPage,
} from "./pages";
import { createSession, endAllSessions, endSession, getSession } from "./session";

export { ensureClaimEmail, type ClaimEmailResult } from "./claim";
export { getOwner, type Owner } from "./owner";
export { getSession, SESSION_COOKIE, SESSION_TTL_MS, type Session } from "./session";
export { safeNext } from "./oauth";

// ---------------------------------------------------------------------------- routes

/**
 * GET /login, GET /claim, POST /claim/resend, GET /auth/callback, POST /logout, POST /logout/all
 * and the legacy GET /reconnect; null for any other path. The router has already checked Origin
 * on non-GET requests.
 */
export async function handleAuthRoutes(request: Request, env: Env, ctx: ExecutionContext, now = Date.now()): Promise<Response | null> {
  const url = new URL(request.url);
  const method = request.method === "HEAD" ? "GET" : request.method;
  const route = (allowed: "GET" | "POST", handler: () => Promise<Response> | Response) => (method === allowed ? handler() : methodNotAllowedPage(allowed === "GET" ? "GET, HEAD" : "POST"));
  switch (url.pathname) {
    case "/reconnect":
      return route("GET", () => redirect("/login", 302));
    case "/login":
      return route("GET", () => login(env, url, now));
    case "/claim":
      return route("GET", () => claim(env, url, now));
    case "/claim/resend":
      return route("POST", () => resend(env, now));
    case "/auth/callback":
      return route("GET", () => callback(request, env, ctx, url, now));
    case "/logout":
      return route("POST", () => logout(request, env));
    case "/logout/all":
      return route("POST", () => logoutAll(request, env, now));
    default:
      return null;
  }
}

/** Owner only: a fresh OAuth round trip (also how an expired Spotify login is reconnected). */
async function login(env: Env, url: URL, now: number): Promise<Response> {
  if (!(await getOwner(env.DB, env))) return redirect303("/");
  const origin = publicOrigin(env);
  if (!origin || !canLogIn(env)) return unconfiguredPage();
  const next = safeNext(url.searchParams.get("next"));
  const { location, cookie } = startOAuth(env, origin, { p: "login", n: next }, url.searchParams.get("switch") === "1", now);
  return redirect(location, 302, { "Set-Cookie": cookie });
}

/** The emailed setup link. Nothing is consumed here, so a link scanner following it changes nothing. */
async function claim(env: Env, url: URL, now: number): Promise<Response> {
  if (await getOwner(env.DB, env)) return claimLinkPage(404, false);
  const origin = publicOrigin(env);
  if (!origin || !canLogIn(env)) return unconfiguredPage();
  const nonce = url.searchParams.get("k");
  if (!(await isValidClaimNonce(env.DB, nonce, now))) return claimLinkPage(404, canSendClaim(env));
  const { location, cookie } = startOAuth(env, origin, { p: "claim", k: nonce! }, true, now);
  return redirect(location, 302, { "Set-Cookie": cookie });
}

/** The landing page's "Resend": the same page whatever happened, short of a send failure. */
async function resend(env: Env, now: number): Promise<Response> {
  const result = await resendClaimEmail(env, env.DB, now);
  switch (result.status) {
    case "owned":
      return redirect303("/");
    case "unconfigured":
      return unconfiguredPage();
    case "failed":
      return resendFailedPage();
    default:
      return checkEmailPage(sentTime(env, result.sentAt));
  }
}

/** The one OAuth redirect URI. Always clears the OAuth cookie; Spotify is called only for a matching state. */
async function callback(request: Request, env: Env, ctx: ExecutionContext, url: URL, now: number): Promise<Response> {
  const clear = { "Set-Cookie": clearOAuthCookie(env) };
  const state = readOAuthCookie(request, env, now);
  if (!state) return loginExpiredPage(clear);
  if (!(await constantTimeEqualSafe(url.searchParams.get("state"), state.s))) return loginMismatchPage(clear);
  const claiming = state.p === "claim";
  if (url.searchParams.has("error")) return loginCancelledPage("error", claiming, clear);
  const code = url.searchParams.get("code");
  const origin = publicOrigin(env);
  if (!code) return loginCancelledPage("no-code", claiming, clear);
  if (!origin || !canLogIn(env)) return unconfiguredPage(clear);

  let me: SpotifyLogin;
  try {
    me = await completeOAuth(env, origin, code);
  } catch (err) {
    console.error(JSON.stringify({ auth: "spotify login failed", purpose: state.p, error: err instanceof Error ? err.message : String(err) }));
    return spotifyFailedPage(claiming, clear);
  }
  const ctxInfo: LoginContext = { request, env, ctx, me, state, now, clear };
  return state.p === "claim" ? completeClaim(ctxInfo) : completeLogin(ctxInfo, await getOwner(env.DB, env));
}

interface LoginContext {
  request: Request;
  env: Env;
  ctx: ExecutionContext;
  me: SpotifyLogin;
  state: OAuthState;
  now: number;
  clear: Record<string, string>;
}

const accountName = (me: SpotifyLogin) => (me.displayName ? `${me.displayName} (${me.id})` : me.id);

/** First use: the emailed nonce makes this account the owner (first wins), then logs it in. */
async function completeClaim(c: LoginContext): Promise<Response> {
  const { env, me, now, clear } = c;
  const db = env.DB;
  const owner = await getOwner(db, env);
  if (owner) {
    // Already claimed (another tab, or SPOTIFY_USER_ID added since): the owner just logs in.
    if (owner.id === me.id) return completeLogin(c, owner);
    if (owner.source === "config") return wrongAccount(c);
    return alreadySetUpPage(clear);
  }
  if (!(await isValidClaimNonce(db, c.state.k, now))) return claimLinkPage(400, canSendClaim(env), clear);

  await db.prepare("INSERT INTO state (key, value, updated_at) VALUES (?1, ?2, datetime('now')) ON CONFLICT(key) DO NOTHING").bind(OWNER_KEY, me.id).run();
  if ((await getState(db, OWNER_KEY)) !== me.id) {
    return alreadySetUpPage(clear);
  }
  const claimed: Owner = { id: me.id, source: "claimed" };
  await db.batch([...saveLoginStatements(db, claimed, me, me.refreshToken), db.prepare("DELETE FROM state WHERE key = ?1").bind(CLAIM_KEY)]);
  const cookie = await createSession(db, env, me.id, c.request.headers.get("User-Agent"), now);
  console.log(JSON.stringify({ auth: "claimed", account: me.id }));
  await quietly("activity", () => logActivity(db, "account", `Set up spotify-sync for ${accountName(me)}`, true, undefined, now));
  c.ctx.waitUntil(sendWelcome(env, me, now));
  // No immediate sync: the first cron sync runs within 10 minutes, after the owner reviewed the defaults.
  return redirect303("/settings?welcome=1", sessionHeaders(cookie, clear));
}

/** The owner (and only the owner) logs in; the new refresh token is always saved. */
async function completeLogin(c: LoginContext, owner: Owner | null): Promise<Response> {
  const { env, me, now, clear } = c;
  const db = env.DB;
  if (!owner) return redirect303("/", clear); // unclaimed again since the login started
  if (me.id !== owner.id) return wrongAccount(c);

  await db.batch(saveLoginStatements(db, owner, me, me.refreshToken));
  const cookie = await createSession(db, env, me.id, c.request.headers.get("User-Agent"), now);
  const syncFailing = (await getState(db, "alert_failing:sync")) !== null;
  console.log(JSON.stringify({ auth: "logged in", account: me.id, reconnect: syncFailing }));
  const summary = syncFailing ? `Logged in as ${accountName(me)} and reconnected Spotify` : `Logged in as ${accountName(me)}`;
  await quietly("activity", () => logActivity(db, "account", summary, true, undefined, now));
  // Reconnecting after a failing sync: sync right away with the new token; a success clears the
  // failing state and sends the "recovered" email.
  if (syncFailing) c.ctx.waitUntil(withJob(env, "sync", runSync).then(() => undefined, () => undefined));
  return redirect303(c.state.n ?? "/", sessionHeaders(cookie, clear));
}

function wrongAccount(c: LoginContext): Response {
  console.warn(JSON.stringify({ auth: "wrong account", account: c.me.id }));
  const next = c.state.n && c.state.n !== "/" ? `&next=${encodeURIComponent(c.state.n)}` : "";
  return wrongAccountPage(accountName(c.me), `/login?switch=1${next}`, c.clear);
}

function sessionHeaders(sessionCookie: string, clear: Record<string, string>): Headers {
  const headers = new Headers();
  headers.append("Set-Cookie", clear["Set-Cookie"]!);
  headers.append("Set-Cookie", sessionCookie);
  return headers;
}

async function sendWelcome(env: Env, me: SpotifyLogin, now: number): Promise<void> {
  try {
    const settings = await loadSettings(env.DB, env).then(
      (s) => s.values,
      () => null,
    );
    const email = welcomeEmail({ publicUrl: publicOrigin(env)!, account: { id: me.id, displayName: me.displayName }, settings });
    const sent = await sendEmail(emailConfig(env), email);
    await logActivity(env.DB, "email", sent ? "Sent the welcome email" : "Couldn't send the welcome email", sent, undefined, now);
  } catch (err) {
    console.error(JSON.stringify({ auth: "welcome email failed", error: err instanceof Error ? err.message : String(err) }));
  }
}

/** Back to the landing page with the "You're logged out." notice (src/dashboard FLASH). */
const LOGGED_OUT = "/?ok=logged-out";

async function logout(request: Request, env: Env): Promise<Response> {
  return redirect303(LOGGED_OUT, { "Set-Cookie": await endSession(request, env) });
}

async function logoutAll(request: Request, env: Env, now: number): Promise<Response> {
  const session = await getSession(request, env, now);
  if (!session) return authRequired(request);
  await endAllSessions(env.DB);
  await quietly("activity", () => logActivity(env.DB, "account", "Logged out everywhere", true, undefined, now));
  return redirect303(LOGGED_OUT, { "Set-Cookie": await endSession(request, env) });
}

/** constantTimeEqual for an optional query value (missing never matches). */
const constantTimeEqualSafe = async (value: string | null, expected: string): Promise<boolean> =>
  value !== null && (await constantTimeEqual(value, expected));
