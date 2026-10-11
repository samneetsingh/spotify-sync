// The Spotify OAuth round trip shared by claim, login and reconnect (tasks/dashboard-plan.md 2.4).
// One redirect URI, <PUBLIC_URL>/auth/callback. Starting a login writes nothing to D1: the state
// lives in a short-lived `__Host-oauth` cookie that needs no signature, because the callback
// requires the `state` query param to equal the cookie's (a double-submit check; other sites can't
// set or read a __Host- cookie), re-checks a claim nonce against D1 and re-sanitizes `next`.

import type { Env } from "../env";
import { clearCookie, readCookie, setCookie } from "../http";
import { SPOTIFY_SCOPE, exchangeCode } from "../spotify/auth";
import type { UserProfile } from "../spotify/types";
import { randomHex } from "../utils/crypto";

export const OAUTH_COOKIE = "oauth";
export const OAUTH_TTL_MS = 600_000;
const AUTHORIZE_URL = "https://accounts.spotify.com/authorize";
const ME_URL = "https://api.spotify.com/v1/me";
const MAX_NEXT = 512;
const HEX64 = /^[0-9a-f]{64}$/;

/** What the OAuth cookie carries between the redirect to Spotify and the callback. */
export interface OAuthState {
  /** The `state` value sent to Spotify (32 random bytes, hex). */
  s: string;
  /** Purpose: claim the unowned instance, or log in as the owner. */
  p: "login" | "claim";
  /** Claim only: the setup link's nonce, re-checked against D1 in the callback. */
  k?: string;
  /** Where to go after logging in (sanitized again in the callback). */
  n?: string;
  /** Expiry, epoch ms (the cookie's Max-Age is the same). */
  e: number;
}

/** The origin from PUBLIC_URL, or null when it's unset or not a URL. */
export function publicOrigin(env: Env): string | null {
  try {
    return env.PUBLIC_URL ? new URL(env.PUBLIC_URL).origin : null;
  } catch {
    return null;
  }
}

export const redirectUri = (origin: string) => `${origin}/auth/callback`;

/** Logging in needs a public URL to come back to and the Spotify app's credentials. */
export const canLogIn = (env: Env): boolean => !!publicOrigin(env) && !!env.SPOTIFY_CLIENT_ID && !!env.SPOTIFY_CLIENT_SECRET;

/** Paths `next` may never point at (they'd loop or act). */
const NO_RETURN = /^\/(login|claim|auth|logout|reconnect)(\/|\?|#|$)/;

/**
 * A same-origin relative path to return to after logging in, else "/": it must start with one `/`
 * (not `//` or `/\`, which browsers treat as another host), contain no control characters or
 * backslashes, and resolve to this origin.
 */
export function safeNext(next: string | null | undefined): string {
  if (!next || next.length > MAX_NEXT || !next.startsWith("/") || /[\u0000-\u001f\u007f\\]/.test(next) || next.startsWith("//")) return "/";
  const base = "https://next.invalid";
  let url: URL;
  try {
    url = new URL(next, base);
  } catch {
    return "/";
  }
  if (url.origin !== base) return "/";
  const path = url.pathname + url.search + url.hash;
  return NO_RETURN.test(path) ? "/" : path;
}

const toBase64url = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromBase64url = (b64: string) => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)));

/** Parses and validates the OAuth cookie; null when missing, malformed or expired. */
export function readOAuthCookie(request: Request, env: Env, now = Date.now()): OAuthState | null {
  const raw = readCookie(request, OAUTH_COOKIE, env.PUBLIC_URL);
  if (!raw || raw.length > 2048) return null;
  let v: Partial<OAuthState>;
  try {
    v = JSON.parse(fromBase64url(raw)) as Partial<OAuthState>;
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null || typeof v.s !== "string" || !HEX64.test(v.s)) return null;
  if (typeof v.e !== "number" || v.e <= now) return null;
  if (v.p === "claim") {
    if (typeof v.k !== "string" || !HEX64.test(v.k)) return null;
    return { s: v.s, p: "claim", k: v.k, e: v.e };
  }
  if (v.p !== "login") return null;
  return { s: v.s, p: "login", n: safeNext(typeof v.n === "string" ? v.n : null), e: v.e };
}

/**
 * Starts the round trip: a 302 to Spotify's authorize page and the cookie for the callback.
 * `showDialog` makes Spotify ask which account to use (claims, and "use a different account").
 */
export function startOAuth(env: Env, origin: string, purpose: { p: "login"; n: string } | { p: "claim"; k: string }, showDialog: boolean, now = Date.now()): { location: string; cookie: string } {
  const state: OAuthState = { s: randomHex(32), ...purpose, e: now + OAUTH_TTL_MS };
  const url = new URL(AUTHORIZE_URL);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: env.SPOTIFY_CLIENT_ID,
    scope: SPOTIFY_SCOPE,
    redirect_uri: redirectUri(origin),
    state: state.s,
    show_dialog: showDialog ? "true" : "false",
  }).toString();
  return { location: url.toString(), cookie: setCookie(OAUTH_COOKIE, toBase64url(JSON.stringify(state)), env.PUBLIC_URL, { maxAge: OAUTH_TTL_MS / 1000 }) };
}

export const clearOAuthCookie = (env: Env): string => clearCookie(OAUTH_COOKIE, env.PUBLIC_URL);

export interface SpotifyLogin {
  id: string;
  displayName: string | null;
  refreshToken: string;
}

/**
 * Trades the callback's code for tokens and asks Spotify who logged in (2 subrequests). Throws on
 * any Spotify failure, including a missing refresh token. Errors carry Spotify's status and message,
 * never the code or tokens.
 */
export async function completeOAuth(env: Env, origin: string, code: string): Promise<SpotifyLogin> {
  const token = await exchangeCode(env.SPOTIFY_CLIENT_ID, env.SPOTIFY_CLIENT_SECRET, code, redirectUri(origin));
  if (!token.refresh_token) throw new Error("Spotify sent no refresh token");
  const resp = await fetch(ME_URL, { headers: { Authorization: `Bearer ${token.access_token}` } });
  if (!resp.ok) throw new Error(`Spotify /me returned ${resp.status}`);
  const me = (await resp.json()) as UserProfile;
  if (typeof me.id !== "string" || !me.id) throw new Error("Spotify /me returned no account id");
  return { id: me.id, displayName: me.display_name || null, refreshToken: token.refresh_token };
}
