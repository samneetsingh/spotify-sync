// Shared by the dashboard tests: an Env with a fake email binding, a stub owner Session, a Spotify
// fetch mock for previews, and the checks every HTML page must pass (CSP nonce, no style= attributes).

import { env } from "cloudflare:workers";
import { expect } from "vitest";
import type { Session } from "../../src/auth";
import type { Env } from "../../src/env";
import { resolveSettings, type EffectiveSettings, type SettingValues } from "../../src/settings";

export const ORIGIN = "https://sync.test";
export const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

export type Sent = { from: unknown; to: unknown; subject: string; text: string; html?: string };

/** A send_email binding that records what it was asked to send. */
export function fakeBinding() {
  const sent: Sent[] = [];
  const binding = {
    async send(msg: Sent) {
      sent.push(msg);
      return { messageId: `m${sent.length}` };
    },
  } as unknown as SendEmail;
  return { sent, binding };
}

export function testEnv(overrides: Partial<Env> = {}): Env {
  return {
    ...(env as unknown as Env),
    PUBLIC_URL: ORIGIN,
    WRITE_MODE: "dry_run",
    SPOTIFY_CLIENT_ID: "id",
    SPOTIFY_CLIENT_SECRET: "secret",
    TIME_ZONE: "America/Los_Angeles",
    SPOTIFY_FREQUENT_PLAYLIST_ID: "",
    SPOTIFY_HINDI_FAVORITES_PLAYLIST_ID: "",
    OPENAI_API_KEY: "",
    ...overrides,
  };
}

export const session: Session = { spotifyId: "owner-1", displayName: "Sam", expiresAt: Date.now() + 86_400_000 };

export const get = (path: string, headers: Record<string, string> = {}) => new Request(`${ORIGIN}${path}`, { headers });
export const post = (path: string, fields: Array<[string, string]> | Record<string, string> = {}) =>
  new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { Origin: ORIGIN, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields as Record<string, string>).toString(),
  });

/**
 * WP-B implements resolveSettings/loadSettings/saveSettings; until that lands they throw "not
 * implemented". Tests that go through them are integration tests and are skipped until then.
 */
export const settingsReady = (() => {
  try {
    resolveSettings([], testEnv());
    return true;
  } catch {
    return false;
  }
})();

/** Hand-built effective settings for the pure renderers (independent of WP-B's resolver). */
export function stubSettings(values: Partial<SettingValues> = {}, source: Partial<EffectiveSettings["source"]> = {}, problems: string[] = []): EffectiveSettings {
  const all: SettingValues = {
    liked: false,
    frequent: true,
    frequentMinPlays: 5,
    artistPlaylists: true,
    hindiFavorites: false,
    onThisDay: true,
    forgottenFavorites: true,
    holiday: true,
    alerts: true,
    digestWeekly: true,
    digestMonthly: true,
    aiEditor: false,
    timeZone: "America/Los_Angeles",
    ...values,
  };
  const src = Object.fromEntries(Object.keys(all).map((k) => [k, "default"])) as EffectiveSettings["source"];
  return { values: all, source: { ...src, ...source }, problems };
}

/** Every page: a CSP with a nonce, that nonce on each <style>, no style= attributes, and the h1. */
export async function expectSafePage(res: Response): Promise<string> {
  const csp = res.headers.get("Content-Security-Policy") ?? "";
  const nonce = csp.match(/style-src 'nonce-([^']+)'/)?.[1];
  expect(nonce).toBeTruthy();
  expect(res.headers.get("Referrer-Policy")).toBe("same-origin");
  expect(res.headers.get("Cache-Control")).toBe("no-store");
  const body = await res.text();
  const styles = body.match(/<style\b[^>]*>/g) ?? [];
  expect(styles.length).toBeGreaterThan(0);
  for (const tag of styles) expect(tag).toBe(`<style nonce="${nonce}">`);
  expect(body).not.toMatch(/\sstyle\s*=/i);
  expect(body).not.toMatch(/<script(?![^>]*\bsrc=)/i); // no inline scripts
  expect(body.match(/<h1>/g)).toHaveLength(1);
  return body;
}

/** Fetch mock for the digest preview: Spotify's token and art endpoints, nothing else. */
export function mockSpotifyArt() {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    calls.push(`${url.hostname}${url.pathname}`);
    const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
    if (url.hostname === "accounts.spotify.com") return json({ access_token: "t", token_type: "Bearer", expires_in: 3600 });
    if (url.pathname === "/v1/tracks") return json({ tracks: [] });
    if (url.pathname === "/v1/artists") return json({ artists: [] });
    throw new Error(`Unexpected fetch in a dashboard test: ${url.href}`);
  }) as typeof fetch;
  return { calls, restore: () => void (globalThis.fetch = original) };
}
