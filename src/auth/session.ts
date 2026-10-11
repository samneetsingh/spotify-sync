// Login sessions. The cookie holds an opaque random token;
// D1 stores only its SHA-256, so a database export leaks no live sessions. Sessions last 30 days
// (absolute), each login issues a fresh token (no fixation), "log out" deletes the row and "log out
// everywhere" deletes them all. A session is valid only for the effective owner, so changing the
// owner invalidates every older session.

import type { Env } from "../env";
import { readCookie, setCookie, clearCookie } from "../http";
import { configuredOwnerId, OWNER_KEY, OWNER_NAME_KEY } from "./owner";

/** A logged-in owner. Only the effective owner's sessions are valid. */
export interface Session {
  spotifyId: string;
  displayName: string | null;
  /** Epoch ms; sessions last 30 days (absolute). */
  expiresAt: number;
}

/** Cookie base name: `__Host-session` (or `session` on an http:// dev origin, see src/http.ts). */
export const SESSION_COOKIE = "session";
export const SESSION_TTL_MS = 30 * 86_400_000;
/** Older sessions beyond this many are deleted at each login. */
export const MAX_SESSIONS = 10;

/** base64url of 32 random bytes: 43 characters. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The session token from the request's cookie, if it has the right shape. */
export function sessionToken(request: Request, env: Env): string | null {
  const token = readCookie(request, SESSION_COOKIE, env.PUBLIC_URL);
  return token && TOKEN_SHAPE.test(token) ? token : null;
}

/** The request's valid session (one D1 query), or null. */
export async function getSession(request: Request, env: Env, now = Date.now()): Promise<Session | null> {
  const token = sessionToken(request, env);
  if (!token) return null;
  const row = await env.DB.prepare(
    `SELECT s.spotify_id, s.expires_at,
       (SELECT value FROM state WHERE key = ?2) AS owner,
       (SELECT value FROM state WHERE key = ?3) AS name
     FROM sessions s WHERE s.token_hash = ?1`,
  )
    .bind(await sha256Hex(token), OWNER_KEY, OWNER_NAME_KEY)
    .first<{ spotify_id: string; expires_at: number; owner: string | null; name: string | null }>();
  if (!row || row.expires_at <= now) return null;
  const ownerId = configuredOwnerId(env) ?? row.owner;
  if (!ownerId || row.spotify_id !== ownerId) return null;
  return { spotifyId: row.spotify_id, displayName: row.name, expiresAt: row.expires_at };
}

/**
 * Starts a session for `spotifyId`: inserts it, deletes expired ones and keeps the newest
 * MAX_SESSIONS. Returns the Set-Cookie value (the token never leaves this function otherwise).
 */
export async function createSession(db: D1Database, env: Env, spotifyId: string, userAgent: string | null, now = Date.now()): Promise<string> {
  const token = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const expiresAt = now + SESSION_TTL_MS;
  await db.batch([
    db
      .prepare("INSERT INTO sessions (token_hash, spotify_id, created_at, expires_at, user_agent) VALUES (?1, ?2, ?3, ?4, ?5)")
      .bind(await sha256Hex(token), spotifyId, now, expiresAt, userAgent ? userAgent.slice(0, 200) : null),
    db.prepare("DELETE FROM sessions WHERE expires_at <= ?1").bind(now),
    db
      .prepare("DELETE FROM sessions WHERE token_hash NOT IN (SELECT token_hash FROM sessions ORDER BY created_at DESC, rowid DESC LIMIT ?1)")
      .bind(MAX_SESSIONS),
  ]);
  return setCookie(SESSION_COOKIE, token, env.PUBLIC_URL, { maxAge: SESSION_TTL_MS / 1000 });
}

/** Ends the request's session (if any). Returns the Set-Cookie value that removes the cookie. */
export async function endSession(request: Request, env: Env): Promise<string> {
  const token = sessionToken(request, env);
  if (token) await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?1").bind(await sha256Hex(token)).run();
  return clearCookie(SESSION_COOKIE, env.PUBLIC_URL);
}

/** "Log out everywhere": deletes every session. */
export async function endAllSessions(db: D1Database): Promise<void> {
  await db.prepare("DELETE FROM sessions").run();
}
