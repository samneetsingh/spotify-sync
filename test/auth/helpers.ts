// Shared fixtures for the auth tests: an env with fake email, a Spotify login mock (token exchange
// + /me, injected through globalThis.fetch), a ctx that collects waitUntil work, and cookie helpers.

import { env } from "cloudflare:workers";
import type { Env } from "../../src/env";

export const ORIGIN = "https://sync.test";
export const NOW = Date.UTC(2026, 9, 11, 12);

export type Sent = { from: unknown; to: unknown; subject: string; text?: string; html?: string };

/** A send_email binding that records messages (or fails every send). */
export function fakeEmail(opts: { fail?: boolean } = {}) {
  const sent: Sent[] = [];
  const binding = {
    async send(msg: Sent) {
      if (opts.fail) throw Object.assign(new Error("boom"), { code: "E_DELIVERY_FAILED" });
      sent.push(msg);
      return { messageId: `m${sent.length}` };
    },
  } as unknown as SendEmail;
  return { sent, binding };
}

/** An unclaimed, fully configured instance unless overridden. */
export function testEnv(overrides: Partial<Env> = {}): Env {
  return {
    ...(env as unknown as Env),
    PUBLIC_URL: ORIGIN,
    SPOTIFY_USER_ID: "",
    SPOTIFY_CLIENT_ID: "cid",
    SPOTIFY_CLIENT_SECRET: "csecret",
    WRITE_MODE: "dry_run",
    ALERT_EMAIL: fakeEmail().binding,
    ALERT_FROM: "spotify-sync@example.com",
    ALERT_EMAIL_TO: "owner@example.com",
    TIME_ZONE: "America/Los_Angeles",
    ...overrides,
  } as Env;
}

export interface SpotifyMockOptions {
  /** The account /me returns, by authorization code (default: every code is `account`). */
  accounts?: Record<string, string>;
  account?: string;
  displayName?: string | null;
  tokenStatus?: number;
  meStatus?: number;
  refreshToken?: string | null;
}

/**
 * Spotify's token endpoint, /me and (for a sync triggered by a reconnect) empty answers for every
 * other API GET. Records each call's URL and body.
 */
export function mockSpotify(opts: SpotifyMockOptions = {}) {
  const calls: Array<{ url: string; body?: string }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const body = init?.body ? String(init.body) : undefined;
    calls.push({ url, body });
    if (url === "https://accounts.spotify.com/api/token") {
      if (opts.tokenStatus && opts.tokenStatus !== 200) return new Response('{"error":"invalid_grant"}', { status: opts.tokenStatus });
      const params = new URLSearchParams(body);
      if (params.get("grant_type") === "refresh_token") return Response.json({ access_token: "sync-access", token_type: "Bearer", expires_in: 3600, scope: "" });
      const refresh = opts.refreshToken === undefined ? "new-refresh-token" : opts.refreshToken;
      return Response.json({ access_token: `access-${params.get("code")}`, token_type: "Bearer", expires_in: 3600, scope: "", ...(refresh ? { refresh_token: refresh } : {}) });
    }
    if (url === "https://api.spotify.com/v1/me") {
      if (opts.meStatus && opts.meStatus !== 200) return new Response("{}", { status: opts.meStatus });
      const auth = new Headers(init?.headers).get("Authorization") ?? "";
      const code = auth.replace(/^Bearer access-/, "");
      const id = opts.accounts?.[code] ?? opts.account ?? "owner-id";
      return Response.json({ id, display_name: opts.displayName === undefined ? "Owner Name" : opts.displayName });
    }
    if (url.startsWith("https://api.spotify.com/v1/")) return Response.json({ items: [], next: null, total: 0 });
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;
  return calls;
}

/** An ExecutionContext whose waitUntil work can be awaited. */
export function testCtx() {
  const waits: Array<Promise<unknown>> = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => void waits.push(p), passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
  return { ctx, waits, settle: () => Promise.all(waits) };
}

/** name -> value of every Set-Cookie on a response (a cleared cookie maps to ""). */
export function setCookies(res: Response): Map<string, { value: string; raw: string }> {
  const jar = new Map<string, { value: string; raw: string }>();
  for (const raw of res.headers.getSetCookie()) {
    const [pair] = raw.split(";");
    const at = pair!.indexOf("=");
    jar.set(pair!.slice(0, at), { value: pair!.slice(at + 1), raw });
  }
  return jar;
}

export const get = (path: string, cookie?: string, headers: Record<string, string> = {}) =>
  new Request(`${ORIGIN}${path}`, { headers: { ...(cookie ? { Cookie: cookie } : {}), ...headers } });

export const post = (path: string, opts: { cookie?: string; headers?: Record<string, string>; body?: BodyInit } = {}) =>
  new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { Origin: ORIGIN, ...(opts.cookie ? { Cookie: opts.cookie } : {}), ...opts.headers },
    body: opts.body,
  });

/** The OAuth cookie's JSON contents (it's base64url, unsigned). */
export function decodeOAuthCookie(value: string): Record<string, unknown> {
  const json = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(json, (c) => c.charCodeAt(0))));
}

/** Follows a 302 to Spotify: the `state` it carries and the Cookie header for the callback. */
export function toSpotify(res: Response): { state: string; authorize: URL; cookie: string } {
  const authorize = new URL(res.headers.get("Location")!);
  const oauth = setCookies(res).get("__Host-oauth")!;
  return { state: authorize.searchParams.get("state")!, authorize, cookie: `__Host-oauth=${oauth.value}` };
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const setStateRow = (key: string, value: string) =>
  env.DB.prepare("INSERT INTO state (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(key, value).run();
