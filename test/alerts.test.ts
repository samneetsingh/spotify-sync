import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { LAST_ERROR_CHARS, REMIND_AFTER_MS, checkSyncGap, isLoginError, localTime, recordFailure, recordSuccess, remedy, type AlertConfig, type FailingState } from "../src/alerts";
import { getState } from "../src/db/state";
import { migrate } from "../src/db/schema";
import worker from "../src/index";
import type { Env } from "../src/env";
import { resetDb } from "./parity/spotify-fixture";

type Sent = { from: unknown; to: unknown; subject: string; text?: string; html?: string };

function fakeEmail(opts: { fail?: boolean } = {}) {
  const sent: Sent[] = [];
  const binding = {
    async send(msg: Sent) {
      if (opts.fail) throw Object.assign(new Error("boom"), { code: "E_DELIVERY_FAILED" });
      sent.push(msg);
      return { messageId: `m${sent.length}` };
    },
  } as unknown as SendEmail;
  return { sent, cfg: { binding, from: "spotify-sync@example.com", to: "me@example.com" } as AlertConfig };
}

beforeAll(() => migrate(env.DB));
beforeEach(() => resetDb(env.DB));

describe("failure alerts", () => {
  it("alerts once, reminds after the interval, and reports recovery", async () => {
    const { sent, cfg } = fakeEmail();
    const t0 = Date.UTC(2026, 9, 9, 12);
    await recordFailure(env.DB, cfg, "sync", new Error("Token refresh failed: 400 invalid_grant"), t0);
    await recordFailure(env.DB, cfg, "sync", new Error("again"), t0 + 10 * 60_000);
    expect(sent.map((s) => s.subject)).toEqual(["[spotify-sync] sync failed"]);
    expect(sent[0]!.to).toBe("me@example.com");
    expect(sent[0]!.text).toContain("log in with Spotify on your dashboard");
    expect(sent[0]!.text).not.toContain("npm run token");

    await recordFailure(env.DB, cfg, "sync", new Error("still"), t0 + REMIND_AFTER_MS + 1);
    expect(sent.at(-1)!.subject).toBe("[spotify-sync] sync still failing (3 failures)");

    await recordSuccess(env.DB, cfg, "sync", t0 + REMIND_AFTER_MS + 10 * 60_000);
    expect(sent.at(-1)!.subject).toBe("[spotify-sync] sync recovered");
    expect(sent).toHaveLength(3);

    await recordSuccess(env.DB, cfg, "sync");
    expect(sent).toHaveLength(3); // healthy job: no mail
  });

  it("tracks jobs independently", async () => {
    const { sent, cfg } = fakeEmail();
    await recordFailure(env.DB, cfg, "sync", new Error("x"));
    await recordFailure(env.DB, cfg, "artist-playlists", new Error("y"));
    expect(sent.map((s) => s.subject)).toEqual(["[spotify-sync] sync failed", "[spotify-sync] artist-playlists failed"]);
  });

  it("retries the alert on the next failure if sending failed, without throwing", async () => {
    const broken = fakeEmail({ fail: true });
    await expect(recordFailure(env.DB, broken.cfg, "sync", new Error("x"))).resolves.toBeUndefined();
    const ok = fakeEmail();
    await recordFailure(env.DB, ok.cfg, "sync", new Error("x"));
    expect(ok.sent.map((s) => s.subject)).toEqual(["[spotify-sync] sync still failing (2 failures)"]);
  });

  it("does nothing harmful when email isn't configured", async () => {
    await expect(recordFailure(env.DB, {}, "sync", new Error("x"))).resolves.toBeUndefined();
    await expect(recordSuccess(env.DB, {}, "sync")).resolves.toBeUndefined();
  });

  it("gives owner-facing fixes (no terminal commands)", () => {
    expect(remedy("Token refresh failed: 400 invalid_grant")).toBe(
      "The Spotify login has expired or been revoked. Fix: log in with Spotify on your dashboard; syncing resumes right after.",
    );
    expect(remedy("Spotify API GET → 429")).toContain("rate limiting");
    expect(remedy("something else")).toContain("clears on its own");
    for (const m of ["invalid_grant", "x", "429"]) expect(remedy(m)).not.toMatch(/npm|Workers & Pages/);
  });

  it("classifies login errors (the dashboard shows Reconnect Spotify for them)", () => {
    expect(isLoginError('Token refresh failed: 400 {"error":"invalid_grant"}')).toBe(true);
    expect(isLoginError("No refresh token in state")).toBe(true);
    expect(isLoginError("Spotify API GET → 500")).toBe(false);
  });

  it("keeps the latest error (first 500 characters) in the failing state for the dashboard", async () => {
    const { cfg } = fakeEmail();
    await recordFailure(env.DB, cfg, "sync", new Error("first"), 1);
    await recordFailure(env.DB, cfg, "sync", new Error("x".repeat(800)), 2);
    const state = JSON.parse((await getState(env.DB, "alert_failing:sync"))!) as FailingState;
    expect(state).toEqual({ since: 1, lastSent: 1, failures: 2, lastError: "x".repeat(LAST_ERROR_CHARS) });
  });
});

describe("reconnect button in login alerts", () => {
  const withUrl = (cfg: AlertConfig, publicUrl = "https://sync.test"): AlertConfig => ({ ...cfg, publicUrl, timeZone: "America/Los_Angeles" });
  const loginError = new Error('Token refresh failed: 400 {"error":"invalid_grant","error_description":"Refresh token revoked"}');

  it("links to the dashboard's login, which only accepts the owner's account", async () => {
    const { sent, cfg } = fakeEmail();
    await recordFailure(env.DB, withUrl(cfg), "sync", loginError, Date.UTC(2026, 9, 11, 10, 20));
    const { html, text, subject } = sent[0]!;
    expect(subject).toBe("[spotify-sync] sync failed");
    expect(html).toContain("Spotify disconnected");
    expect(html).toContain('href="https://sync.test/login"');
    expect(text).toContain("Reconnect Spotify: https://sync.test/login\nOpens Spotify's login; only your account is accepted. Syncing resumes right after.");
    expect(text).toContain("Failing since: Sun, Oct 11, 3:20 AM PDT");
    expect(html).toContain("&quot;invalid_grant&quot;"); // the error is escaped
    expect(`${html}${text}`).not.toMatch(/npm run token|\/reconnect/);
  });

  it("uses the same link in reminders and stores no nonce", async () => {
    const { sent, cfg } = fakeEmail();
    const t0 = Date.UTC(2026, 9, 11, 12);
    await recordFailure(env.DB, withUrl(cfg, "https://sync.test/"), "sync", loginError, t0);
    await recordFailure(env.DB, withUrl(cfg), "sync", loginError, t0 + REMIND_AFTER_MS);
    expect(sent.map((s) => s.text!.match(/Reconnect Spotify: (\S+)/)?.[1])).toEqual(["https://sync.test/login", "https://sync.test/login"]);
    expect(await getState(env.DB, "reconnect")).toBeNull();

    await recordSuccess(env.DB, withUrl(cfg), "sync", t0 + 7 * 86_400_000);
    expect(sent.at(-1)!.subject).toBe("[spotify-sync] sync recovered");
    expect(await getState(env.DB, "alert_failing:sync")).toBeNull();
  });

  it("has no button for other errors or without a public URL", async () => {
    const { sent, cfg } = fakeEmail();
    await recordFailure(env.DB, withUrl(cfg), "sync", new Error("Spotify API GET → 500"));
    await recordFailure(env.DB, cfg, "artist-playlists", loginError);
    expect(sent.map((s) => s.html!.includes("Reconnect Spotify"))).toEqual([false, false]);
    expect(sent[1]!.text).toContain("log in with Spotify on your dashboard");
    expect(sent[1]!.text).not.toContain("npm run token");
  });

  it("formats times in the alert time zone", () => {
    expect(localTime(Date.UTC(2026, 0, 5, 18, 5), "America/Los_Angeles")).toBe("Mon, Jan 5, 10:05 AM PST");
    expect(localTime(Date.UTC(2026, 0, 5, 18, 5))).toBe("Mon, Jan 5, 6:05 PM UTC");
  });
});

describe("sync gap alert", () => {
  const insertRun = (startedAt: string) =>
    env.DB.prepare("INSERT INTO sync_runs(started_at, status) VALUES(?1, 'success')").bind(startedAt).run();

  it("reports a gap longer than 45 minutes", async () => {
    const { sent, cfg } = fakeEmail();
    await insertRun("2026-10-09 10:00:00");
    await checkSyncGap(env.DB, cfg, Date.UTC(2026, 9, 9, 13, 0));
    expect(sent.map((s) => s.subject)).toEqual(["[spotify-sync] sync resumed after a 3.0h gap"]);
  });

  it("stays quiet for normal 10-minute spacing and for an empty table", async () => {
    const { sent, cfg } = fakeEmail();
    await checkSyncGap(env.DB, cfg, Date.UTC(2026, 9, 9, 13, 0));
    await insertRun("2026-10-09 12:50:00");
    await checkSyncGap(env.DB, cfg, Date.UTC(2026, 9, 9, 13, 0));
    expect(sent).toEqual([]);
  });
});

describe("scheduled handler", () => {
  const original = globalThis.fetch;
  afterEach(() => void (globalThis.fetch = original));

  it("emails when a job fails, and still fails the invocation", async () => {
    const { sent, cfg } = fakeEmail();
    globalThis.fetch = (async () => new Response('{"error":"invalid_grant","error_description":"Refresh token revoked"}', { status: 400 })) as typeof fetch;
    const testEnv = {
      ...(env as unknown as Env),
      SPOTIFY_ALL_PLAYLIST_ID: "all1",
      SPOTIFY_FREQUENT_PLAYLIST_ID: "",
      WRITE_MODE: "live",
      ALERT_EMAIL: cfg.binding,
      ALERT_FROM: cfg.from,
      ALERT_EMAIL_TO: cfg.to,
    } as Env;
    await expect(worker.scheduled({ cron: "*/10 * * * *" } as ScheduledEvent, testEnv, {} as ExecutionContext)).rejects.toThrow(/invalid_grant/);
    expect(sent.map((s) => s.subject)).toEqual(["[spotify-sync] sync failed"]);
    expect(sent[0]!.text).toContain("Spotify login expired or was revoked");
  });

  it("runs every daily job even when one fails, then fails the invocation", async () => {
    const { sent, cfg } = fakeEmail();
    const testEnv = {
      ...(env as unknown as Env),
      SPOTIFY_ALL_PLAYLIST_ID: "all1",
      WRITE_MODE: "live",
      TIME_ZONE: "Not/A_Zone", // makes each job's config load throw
      ALERT_EMAIL: cfg.binding,
      ALERT_FROM: cfg.from,
      ALERT_EMAIL_TO: cfg.to,
    } as Env;
    await expect(worker.scheduled({ cron: "5 8 * * *" } as ScheduledEvent, testEnv, {} as ExecutionContext)).rejects.toThrow(/TIME_ZONE/);
    expect(sent.map((s) => s.subject)).toEqual([
      "[spotify-sync] history-playlists failed",
      "[spotify-sync] holiday-playlist failed",
      "[spotify-sync] weekly-digest failed",
      "[spotify-sync] monthly-recap failed",
    ]);
  });
});
