import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../src/db/schema";
import { getState, setState } from "../src/db/state";
import type { Env } from "../src/env";
import worker, { ImportWorkflow } from "../src/index";
import { housekeeping } from "../src/schedule";
import { mockSpotify, resetDb } from "./parity/spotify-fixture";

const testEnv = (overrides: Partial<Env> = {}): Env => ({
  ...(env as unknown as Env),
  PUBLIC_URL: "https://sync.test",
  WRITE_MODE: "dry_run",
  ...overrides,
});
const ctx = {} as ExecutionContext;
const request = (path: string, init: RequestInit = {}) => new Request(`https://sync.test${path}`, init);

describe("fetch router", () => {
  it("404s paths no handler owns, with the HTML security headers", async () => {
    const res = await worker.fetch(request("/nope"), testEnv(), ctx);
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Security-Policy")).toMatch(/style-src 'nonce-[A-Za-z0-9+/=]+'/);
    expect(res.headers.get("Referrer-Policy")).toBe("same-origin");
  });

  it("no longer serves POST /sync-full", async () => {
    const res = await worker.fetch(
      request("/sync-full", { method: "POST", headers: { Origin: "https://sync.test", Authorization: "Bearer anything" } }),
      testEnv(),
      ctx,
    );
    expect(res.status).toBe(404);
  });

  it.each([
    ["no Origin", {}],
    ["another site", { Origin: "https://evil.test" }],
    ["a sibling subdomain", { Origin: "https://evil.sync.test" }],
    ["an opaque origin", { Origin: "null" }],
    ["a cross-site fetch without Origin", { "Sec-Fetch-Site": "cross-site" }],
  ])("blocks a POST from %s before any handler runs", async (_label, headers) => {
    const res = await worker.fetch(request("/nope", { method: "POST", headers }), testEnv(), ctx);
    expect(res.status).toBe(403);
  });

  it("blocks every POST when PUBLIC_URL is unset", async () => {
    const res = await worker.fetch(request("/nope", { method: "POST", headers: { Origin: "https://sync.test" } }), testEnv({ PUBLIC_URL: undefined }), ctx);
    expect(res.status).toBe(403);
  });

  it("lets same-origin POSTs through to the handlers", async () => {
    const allowed: Array<Record<string, string>> = [{ Origin: "https://sync.test" }, { "Sec-Fetch-Site": "same-origin" }];
    for (const headers of allowed) {
      const res = await worker.fetch(request("/nope", { method: "POST", headers }), testEnv(), ctx);
      expect(res.status).toBe(404);
    }
  });
});

it("exports the import Workflow class for its binding", () => {
  expect(typeof ImportWorkflow).toBe("function");
});

describe("scheduled", () => {
  type Sent = { to: unknown; subject: string; text?: string };
  let sent: Sent[] = [];
  const binding = { async send(m: Sent) { sent.push(m); return { messageId: "m" }; } } as unknown as SendEmail;
  const cronEnv = (overrides: Partial<Env> = {}) =>
    testEnv({
      SPOTIFY_CLIENT_ID: "id",
      SPOTIFY_CLIENT_SECRET: "secret",
      WRITE_MODE: "live",
      SETTINGS: "{}",
      ALERT_EMAIL: binding,
      ALERT_FROM: "spotify-sync@example.com",
      ALERT_EMAIL_TO: "owner@example.com",
      ...overrides,
    });
  const scheduled = (cron: string, e: Env = cronEnv()) => worker.scheduled({ cron } as ScheduledEvent, e, ctx);
  const originalFetch = globalThis.fetch;
  /** Records every fetch and fails it: nothing may reach Spotify. */
  function noNetwork(): string[] {
    const urls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      urls.push(String(input instanceof Request ? input.url : input));
      throw new Error("network disabled in this test");
    }) as typeof fetch;
    return urls;
  }
  const count = async (table: string) => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n;

  beforeAll(() => migrate(env.DB));
  beforeEach(async () => {
    sent = [];
    await resetDb(env.DB); // seeds a Spotify refresh token
  });
  afterEach(() => void (globalThis.fetch = originalFetch));

  it("before the setup link is used: no jobs, no failure alerts, only the setup email", async () => {
    await env.DB.prepare("DELETE FROM state").run(); // fresh: no owner, no Spotify login
    const urls = noNetwork();
    for (const cron of ["*/10 * * * *", "0 3 * * *", "0 4 * * *", "5 8 * * *"]) await scheduled(cron);
    await scheduled("*/10 * * * *"); // the link is still pending: not sent again
    expect(urls).toEqual([]);
    expect(sent.map((m) => [m.to, m.subject])).toEqual([["owner@example.com", "[spotify-sync] Connect your Spotify to finish setup"]]);
    expect(await count("sync_runs")).toBe(0);
    expect(await env.DB.prepare("SELECT key FROM state WHERE key LIKE 'alert_failing:%'").all()).toMatchObject({ results: [] });
  });

  it("an instance connected without an owner (npm run token) keeps syncing and gets the setup email", async () => {
    const mock = mockSpotify({ tracks: {}, recently_played: { default: [] }, artists: {}, playlist_items: {}, playlist_total: {} });
    try {
      await scheduled("*/10 * * * *");
    } finally {
      mock.restore();
    }
    expect(mock.calls.map((c) => c.op)).toEqual(["recently_played"]);
    expect(await count("sync_runs")).toBe(1);
    expect(sent.map((m) => m.subject)).toEqual(["[spotify-sync] Connect your Spotify to finish setup"]);
  });

  it("with an owner (claimed or SPOTIFY_USER_ID), never sends the setup email", async () => {
    const mock = mockSpotify({ tracks: {}, recently_played: { default: [] }, artists: {}, playlist_items: {}, playlist_total: {} });
    try {
      await scheduled("*/10 * * * *", cronEnv({ SPOTIFY_USER_ID: "owner-1" }));
      await setState(env.DB, "owner:spotify_id", "owner-1");
      await scheduled("*/10 * * * *");
    } finally {
      mock.restore();
    }
    expect(sent).toEqual([]);
  });

  it("emails when a job fails, and still fails the invocation", async () => {
    await setState(env.DB, "owner:spotify_id", "owner-1");
    globalThis.fetch = (async () => new Response('{"error":"invalid_grant","error_description":"Refresh token revoked"}', { status: 400 })) as typeof fetch;
    await expect(scheduled("*/10 * * * *")).rejects.toThrow(/invalid_grant/);
    expect(sent.map((s) => s.subject)).toEqual(["[spotify-sync] sync failed"]);
    expect(sent[0]!.text).toContain("Spotify login expired or was revoked");
  });

  it("runs every daily job even when one fails, then fails the invocation", async () => {
    await setState(env.DB, "owner:spotify_id", "owner-1");
    const urls = noNetwork();
    // Every job's settings read fails (D1 trouble), after the gate query worked.
    const db = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "prepare") {
          return (sql: string) => {
            if (/^SELECT key, value FROM settings/.test(sql)) throw new Error("D1 is unavailable");
            return target.prepare(sql);
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await expect(scheduled("5 8 * * *", cronEnv({ DB: db }))).rejects.toThrow("D1 is unavailable");
    expect(urls).toEqual([]);
    expect(sent.map((s) => s.subject)).toEqual([
      "[spotify-sync] history-playlists failed",
      "[spotify-sync] holiday-playlist failed",
      "[spotify-sync] weekly-digest failed",
      "[spotify-sync] monthly-recap failed",
    ]);
  });

  it("ignores an unknown cron", async () => {
    const urls = noNetwork();
    await scheduled("1 2 3 4 5");
    expect(urls).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("daily housekeeping prunes old activity, expired sessions and a setup link once there's an owner", async () => {
    const now = Date.UTC(2026, 9, 11, 8, 5);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO activity (at, kind, summary) VALUES (?1, 'job', 'old'), (?2, 'job', 'recent')").bind(now - 91 * 86_400_000, now - 89 * 86_400_000),
      env.DB.prepare("INSERT INTO sessions (token_hash, spotify_id, created_at, expires_at) VALUES ('a', 'o', 0, ?1), ('b', 'o', 0, ?2)").bind(now - 1, now + 1),
      env.DB.prepare("INSERT INTO state (key, value) VALUES ('claim', '{}')"),
    ]);
    await housekeeping(env.DB, now);
    expect((await env.DB.prepare("SELECT summary FROM activity").all()).results).toEqual([{ summary: "recent" }]);
    expect((await env.DB.prepare("SELECT token_hash FROM sessions").all()).results).toEqual([{ token_hash: "b" }]);
    expect(await getState(env.DB, "claim")).toBe("{}"); // unclaimed: the setup link stays
    await setState(env.DB, "owner:spotify_id", "owner-1");
    await housekeeping(env.DB, now);
    expect(await getState(env.DB, "claim")).toBeNull();
  });
});
