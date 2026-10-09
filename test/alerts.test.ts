import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { REMIND_AFTER_MS, checkSyncGap, recordFailure, recordSuccess, remedy, type AlertConfig } from "../src/alerts";
import { migrate } from "../src/db/schema";
import worker from "../src/index";
import type { Env } from "../src/env";
import { resetDb } from "./parity/spotify-fixture";

type Sent = { from: unknown; to: unknown; subject: string; text?: string };

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
    expect(sent[0]!.text).toContain("npm run token");

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

  it("gives a fix for an expired login", () => {
    expect(remedy("Token refresh failed: 400 invalid_grant")).toContain("npm run token");
    expect(remedy("something else")).toContain("Logs");
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
    expect(sent[0]!.text).toContain("npm run token");
  });
});
