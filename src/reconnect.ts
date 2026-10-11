// One-click Spotify reconnect. An expired-login alert carries a link with a single-use nonce
// (state `reconnect` = {nonce, expires}). The link sends you through Spotify's login and back to
// /reconnect/callback, which saves the new refresh token only when the account that logged in is
// SPOTIFY_USER_ID. Without a valid, unexpired nonce both routes answer 404, so a leaked or old link
// can't connect anything, and a link scanner opening the first URL changes nothing.

import { getState, setState } from "./db/state";
import type { Env } from "./env";
import { C, FONT, TY, esc } from "./email/layout";
import { SPOTIFY_SCOPE, exchangeCode } from "./spotify/auth";
import type { UserProfile } from "./spotify/types";
import { constantTimeEqual, randomHex } from "./utils/crypto";

const STATE_KEY = "reconnect";
export const RECONNECT_TTL_MS = 7 * 86_400_000;
/** A link that expires within this long is replaced rather than sent again in a reminder. */
const MIN_REMAINING_MS = 86_400_000;

interface Pending {
  nonce: string;
  expires: number;
}

const base = (publicUrl: string) => publicUrl.replace(/\/$/, "");
const redirectUri = (publicUrl: string) => `${base(publicUrl)}/reconnect/callback`;

/** The reconnect link for an alert, reusing the pending one while it has at least a day left. */
export async function reconnectLink(db: D1Database, publicUrl: string, now = Date.now()): Promise<string> {
  const pending = await readPending(db);
  let nonce = pending && pending.expires - now >= MIN_REMAINING_MS ? pending.nonce : null;
  if (!nonce) {
    nonce = randomHex(32);
    await setState(db, STATE_KEY, JSON.stringify({ nonce, expires: now + RECONNECT_TTL_MS } satisfies Pending));
  }
  return `${base(publicUrl)}/reconnect?k=${nonce}`;
}

/** Forgets the pending link (after a reconnect, or once the job recovered some other way). */
export async function clearReconnect(db: D1Database): Promise<void> {
  await db.prepare("DELETE FROM state WHERE key = ?1").bind(STATE_KEY).run();
}

/**
 * Handles /reconnect and /reconnect/callback; null for any other path. `onConnected` runs after the
 * new token is saved (the caller starts a sync with it).
 */
export async function handleReconnect(request: Request, env: Env, onConnected: () => void, now = Date.now()): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/reconnect" && url.pathname !== "/reconnect/callback") return null;
  if (request.method !== "GET" || !env.PUBLIC_URL || !env.SPOTIFY_USER_ID) return notFound();

  if (url.pathname === "/reconnect") {
    const nonce = url.searchParams.get("k") ?? "";
    if (!(await isPending(env.DB, nonce, now))) return notFound();
    const login = new URL("https://accounts.spotify.com/authorize");
    login.search = new URLSearchParams({
      response_type: "code",
      client_id: env.SPOTIFY_CLIENT_ID,
      scope: SPOTIFY_SCOPE,
      redirect_uri: redirectUri(env.PUBLIC_URL),
      state: nonce,
      show_dialog: "true",
    }).toString();
    return Response.redirect(login.toString(), 302);
  }

  const nonce = url.searchParams.get("state") ?? "";
  if (!(await isPending(env.DB, nonce, now))) return notFound();
  const error = url.searchParams.get("error");
  const code = url.searchParams.get("code");
  if (error || !code) {
    return page(400, "Spotify login cancelled", `Spotify didn't finish the login (${error ?? "no code"}). Your link still works: open it again from the email.`);
  }

  let token;
  let me: UserProfile;
  try {
    token = await exchangeCode(env.SPOTIFY_CLIENT_ID, env.SPOTIFY_CLIENT_SECRET, code, redirectUri(env.PUBLIC_URL));
    const resp = await fetch("https://api.spotify.com/v1/me", { headers: { Authorization: `Bearer ${token.access_token}` } });
    if (!resp.ok) throw new Error(`Spotify /me returned ${resp.status}`);
    me = (await resp.json()) as UserProfile;
  } catch (err) {
    console.error(JSON.stringify({ reconnect: "failed", error: err instanceof Error ? err.message : String(err) }));
    return page(502, "Couldn't reach Spotify", "Spotify didn't accept the login. Your link still works: open it again from the email in a minute.");
  }
  if (me.id !== env.SPOTIFY_USER_ID) {
    console.warn(JSON.stringify({ reconnect: "wrong account", account: me.id }));
    return page(403, "That's a different Spotify account", `You logged in as ${me.display_name || me.id}. Log out of Spotify in this browser, then open the link again and sign in with the account spotify-sync syncs.`);
  }
  if (!token.refresh_token) return page(502, "Couldn't reach Spotify", "Spotify didn't send a refresh token. Open the link again from the email.");

  await setState(env.DB, "spotify_refresh_token", token.refresh_token);
  await clearReconnect(env.DB);
  console.log(JSON.stringify({ reconnect: "saved new refresh token", account: me.id }));
  onConnected();
  return page(200, "You're reconnected", `Signed in as ${me.display_name || me.id}. A sync is running now; you'll get a "recovered" email once it finishes.`, true);
}

async function readPending(db: D1Database): Promise<Pending | null> {
  const raw = await getState(db, STATE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Pending;
  } catch {
    return null;
  }
}

async function isPending(db: D1Database, nonce: string, now: number): Promise<boolean> {
  const pending = await readPending(db);
  return !!nonce && !!pending && pending.expires > now && (await constantTimeEqual(nonce, pending.nonce));
}

const notFound = () => page(404, "This link doesn't work anymore", "Reconnect links work once and expire after 7 days. If Spotify is still disconnected, the next alert email will have a fresh link, or run npm run token in the repo.");

/** A small standalone page in the email design. */
function page(status: number, title: string, message: string, ok = false): Response {
  const mark = ok
    ? `<div style="width:72px;height:72px;margin:0 auto 24px;border-radius:50%;background:${C.green};color:#000;font:900 38px/72px ${FONT}">&#10003;</div>`
    : "";
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title></head>
<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:${C.page};font-family:${FONT};color:${C.text}">
<main style="max-width:420px;padding:40px 24px;text-align:center">${mark}
<h1 style="${TY.number};margin:0 0 12px">${esc(title)}</h1>
<p style="${TY.body};color:${C.soft};margin:0">${esc(message)}</p></main></body></html>`;
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
}
