// Failure alerts by email (Cloudflare Email Service binding).
//
// - A job that throws sends an alert, then at most one reminder per REMIND_AFTER_MS
//   while it keeps failing, and a "recovered" note on its next success.
// - A sync that starts long after the previous one reports the gap: crons that stop
//   firing can't alert by themselves, but the first run after an outage can.
// Alert bookkeeping lives in `state` and is written in every write mode. Sending never
// throws: a broken alert path must not break the job.

import { getState, setState } from "./db/state";

export const REMIND_AFTER_MS = 6 * 3_600_000;
export const SYNC_GAP_ALERT_MS = 45 * 60_000;

export interface AlertConfig {
  binding?: SendEmail;
  from?: string;
  to?: string;
}

interface FailingState {
  since: number;
  lastSent: number;
  failures: number;
}

const failingKey = (job: string) => `alert_failing:${job}`;

export async function sendAlert(cfg: AlertConfig, subject: string, text: string): Promise<boolean> {
  if (!cfg.binding || !cfg.from || !cfg.to) {
    console.warn(JSON.stringify({ alert: "skipped (email not configured)", subject }));
    return false;
  }
  try {
    await cfg.binding.send({ from: { email: cfg.from, name: "spotify-sync" }, to: cfg.to, subject: `[spotify-sync] ${subject}`, text });
    console.log(JSON.stringify({ alert: "sent", subject }));
    return true;
  } catch (err) {
    const e = err as { code?: string; message?: string };
    console.error(JSON.stringify({ alert: "send failed", subject, code: e.code, error: e.message }));
    return false;
  }
}

/** Hints for errors the user has to fix by hand. */
export function remedy(message: string): string {
  if (/invalid_grant|refresh token|No refresh token/i.test(message)) {
    return "The Spotify login has expired or been revoked. Fix: run `npm run token` in the repo, then wait for the next sync.";
  }
  if (/\b429\b|rate limit/i.test(message)) return "Spotify is rate limiting the app; this usually clears on its own.";
  return "Check the Worker logs: Workers & Pages > spotify-sync > Logs.";
}

export async function recordFailure(db: D1Database, cfg: AlertConfig, job: string, err: unknown, now = Date.now()): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  const raw = await getState(db, failingKey(job));
  const prev: FailingState | null = raw ? JSON.parse(raw) : null;
  const state: FailingState = prev
    ? { ...prev, failures: prev.failures + 1 }
    : { since: now, lastSent: 0, failures: 1 };

  if (!prev || now - prev.lastSent >= REMIND_AFTER_MS) {
    const subject = prev ? `${job} still failing (${state.failures} failures)` : `${job} failed`;
    const body = [
      `Job: ${job}`,
      `Failing since: ${new Date(state.since).toISOString()} (${state.failures} failed run${state.failures === 1 ? "" : "s"})`,
      `Error: ${message}`,
      "",
      remedy(message),
      "",
      `You'll get a reminder every ${REMIND_AFTER_MS / 3_600_000} hours while it keeps failing, and a note when it recovers.`,
    ].join("\n");
    if (await sendAlert(cfg, subject, body)) state.lastSent = now;
  }
  await setState(db, failingKey(job), JSON.stringify(state));
}

export async function recordSuccess(db: D1Database, cfg: AlertConfig, job: string, now = Date.now()): Promise<void> {
  const raw = await getState(db, failingKey(job));
  if (!raw) return;
  const prev: FailingState = JSON.parse(raw);
  const minutes = Math.round((now - prev.since) / 60_000);
  await sendAlert(cfg, `${job} recovered`, `${job} succeeded again after ${prev.failures} failed run(s) over ${minutes} minutes.`);
  await db.prepare("DELETE FROM state WHERE key = ?1").bind(failingKey(job)).run();
}

/** Call before a sync: reports if the previous sync started more than SYNC_GAP_ALERT_MS ago. */
export async function checkSyncGap(db: D1Database, cfg: AlertConfig, now = Date.now()): Promise<void> {
  const row = await db.prepare("SELECT MAX(started_at) AS last FROM sync_runs").first<{ last: string | null }>();
  if (!row?.last) return;
  const last = Date.parse(`${row.last.replace(" ", "T")}Z`);
  const gap = now - last;
  if (!Number.isFinite(last) || gap < SYNC_GAP_ALERT_MS) return;
  const hours = (gap / 3_600_000).toFixed(1);
  await sendAlert(
    cfg,
    `sync resumed after a ${hours}h gap`,
    [
      `The previous sync started at ${new Date(last).toISOString()}; syncs normally run every 10 minutes.`,
      "The cron triggers stopped firing (or the Worker was down) in between.",
      "Plays from the gap are only recovered if fewer than 50 happened (Spotify's recently-played limit);",
      "older ones need a privacy-export import (npm run import-history).",
    ].join("\n"),
  );
}
