// Failure alerts by email (Cloudflare Email Service binding).
//
// - A job that throws sends an alert, then at most one reminder per REMIND_AFTER_MS
//   while it keeps failing, and a "recovered" note on its next success.
// - An expired Spotify login gets a "Reconnect Spotify" button when the Worker has a public URL:
//   it opens the dashboard's /login, which only accepts the owner's account and saves the new
//   refresh token (src/auth).
// - A sync that starts long after the previous one reports the gap: crons that stop
//   firing can't alert by themselves, but the first run after an outage can.
// Alert bookkeeping lives in `state` and is written in every write mode. Sending never
// throws: a broken alert path must not break the job.

import { getState, setState } from "./db/state";
import { actionButton, alertHeader, cardEnd, codeBlock, facts, smallPrint, type Status } from "./email/components";
import { shell } from "./email/layout";

export const REMIND_AFTER_MS = 6 * 3_600_000;
export const SYNC_GAP_ALERT_MS = 45 * 60_000;

export interface AlertConfig {
  binding?: SendEmail;
  from?: string;
  to?: string;
  /** For the times shown in alerts; UTC when unset. */
  timeZone?: string;
  /** The Worker's public origin (dashboard links, email images); no link when unset. */
  publicUrl?: string;
}

/** `state` alert_failing:<job> while a job keeps failing (the dashboard shows it). */
export interface FailingState {
  since: number;
  lastSent: number;
  failures: number;
  /** The latest error message (first LAST_ERROR_CHARS characters); absent in rows from older versions. */
  lastError?: string;
}

export const FAILING_PREFIX = "alert_failing:";
export const LAST_ERROR_CHARS = 500;
const failingKey = (job: string) => `${FAILING_PREFIX}${job}`;

export interface Email {
  subject: string;
  text: string;
  html?: string;
}

/** Sends to the configured recipient. Never throws; returns whether it was sent. */
export async function sendEmail(cfg: AlertConfig, email: Email): Promise<boolean> {
  const { subject, text, html } = email;
  if (!cfg.binding || !cfg.from || !cfg.to) {
    console.warn(JSON.stringify({ email: "skipped (not configured)", subject }));
    return false;
  }
  try {
    await cfg.binding.send({ from: { email: cfg.from, name: "spotify-sync" }, to: cfg.to, subject, text, ...(html ? { html } : {}) });
    console.log(JSON.stringify({ email: "sent", subject }));
    return true;
  } catch (err) {
    const e = err as { code?: string; message?: string };
    console.error(JSON.stringify({ email: "send failed", subject, code: e.code, error: e.message }));
    return false;
  }
}

export interface Alert {
  subject: string;
  status: Status;
  title: string;
  lead: string;
  facts?: Array<[string, string]>;
  error?: string;
  action?: { label: string; url: string; note: string };
  /** Closing small print (what to do, what happens next). */
  note?: string;
}

/** An alert as an email: "[spotify-sync] subject", HTML in the email design, and plain text. */
export function renderAlert(a: Alert): Email {
  const body = [
    alertHeader(a.status, a.title, a.lead),
    a.action ? actionButton(a.action.label, a.action.url, a.action.note) : "",
    a.facts?.length ? facts(a.facts) : "",
    a.error ? codeBlock("Error", a.error) : "",
    a.note ? smallPrint(a.note) : "",
    cardEnd,
  ].join("\n");
  const text = [
    a.title,
    a.lead,
    ...(a.action ? ["", `${a.action.label}: ${a.action.url}`, a.action.note] : []),
    ...(a.facts?.length ? ["", ...a.facts.map(([k, v]) => `${k}: ${v}`)] : []),
    ...(a.error ? ["", `Error: ${a.error}`] : []),
    ...(a.note ? ["", a.note] : []),
  ].join("\n");
  const subject = `[spotify-sync] ${a.subject}`;
  return { subject, text, html: shell({ title: subject, preheader: a.lead, body }) };
}

export async function sendAlert(cfg: AlertConfig, alert: Alert): Promise<boolean> {
  return sendEmail(cfg, renderAlert(alert));
}

/** "Sat, Oct 11, 3:20 AM PDT" in the alert time zone; UTC if that zone is invalid (alerts must still go out). */
export function localTime(ms: number, timeZone = "UTC"): string {
  const format = (tz: string) =>
    new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: tz, timeZoneName: "short" }).format(ms);
  try {
    return format(timeZone);
  } catch {
    return format("UTC");
  }
}

const capitalized = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** An expired or revoked Spotify login: the owner fixes it by logging in again (the dashboard's "Reconnect Spotify"). */
export const isLoginError = (message: string) => /invalid_grant|refresh token|No refresh token/i.test(message);

/** What the owner can do about an error, in their words. */
export function remedy(message: string): string {
  if (isLoginError(message)) {
    return "The Spotify login has expired or been revoked. Fix: log in with Spotify on your dashboard; syncing resumes right after.";
  }
  if (/\b429\b|rate limit/i.test(message)) return "Spotify is rate limiting the app; this usually clears on its own.";
  return "This often clears on its own. If it keeps failing, whoever set up spotify-sync can find the details in the Worker's logs on Cloudflare.";
}

export async function recordFailure(db: D1Database, cfg: AlertConfig, job: string, err: unknown, now = Date.now()): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  const raw = await getState(db, failingKey(job));
  const prev: FailingState | null = raw ? JSON.parse(raw) : null;
  const lastError = message.slice(0, LAST_ERROR_CHARS);
  const state: FailingState = prev
    ? { ...prev, failures: prev.failures + 1, lastError }
    : { since: now, lastSent: 0, failures: 1, lastError };

  if (!prev || now - prev.lastSent >= REMIND_AFTER_MS) {
    const subject = prev ? `${job} still failing (${state.failures} failures)` : `${job} failed`;
    const reminder = `You'll get a reminder every ${REMIND_AFTER_MS / 3_600_000} hours while it keeps failing, and a note when it recovers.`;
    const runs = `${state.failures}`;
    const alert: Alert = {
      subject,
      status: "failing",
      title: `${capitalized(job)} failed`,
      lead: remedy(message),
      facts: [["Job", job], ["Failing since", localTime(state.since, cfg.timeZone)], ["Failed runs", runs]],
      error: message.slice(0, 1_000),
      note: reminder,
    };
    if (isLoginError(message)) {
      alert.title = "Spotify disconnected";
      alert.lead = "The Spotify login expired or was revoked, so new plays aren't being saved and your playlists won't update.";
      if (cfg.publicUrl) {
        alert.action = {
          label: "Reconnect Spotify",
          url: `${cfg.publicUrl.replace(/\/+$/, "")}/login`,
          note: "Opens Spotify's login; only your account is accepted. Syncing resumes right after.",
        };
        alert.note = reminder;
      } else {
        alert.note = `${remedy(message)} ${reminder}`;
      }
    }
    if (await sendAlert(cfg, alert)) state.lastSent = now;
  }
  await setState(db, failingKey(job), JSON.stringify(state));
}

export async function recordSuccess(db: D1Database, cfg: AlertConfig, job: string, now = Date.now()): Promise<void> {
  const raw = await getState(db, failingKey(job));
  if (!raw) return;
  const prev: FailingState = JSON.parse(raw);
  const minutes = Math.round((now - prev.since) / 60_000);
  const over = minutes >= 120 ? `${Math.round(minutes / 60)} hours` : `${minutes} minutes`;
  await sendAlert(cfg, {
    subject: `${job} recovered`,
    status: "recovered",
    title: `${capitalized(job)} is working again`,
    lead: `${capitalized(job)} succeeded again after ${prev.failures} failed run${prev.failures === 1 ? "" : "s"} over ${over}.`,
    facts: [["Job", job], ["Failing since", localTime(prev.since, cfg.timeZone)], ["Recovered", localTime(now, cfg.timeZone)]],
  });
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
  await sendAlert(cfg, {
    subject: `sync resumed after a ${hours}h gap`,
    status: "notice",
    title: `Sync resumed after ${hours} hours`,
    lead: "Syncs normally run every 10 minutes. The cron triggers stopped firing (or the Worker was down) in between.",
    facts: [["Previous sync", localTime(last, cfg.timeZone)], ["Resumed", localTime(now, cfg.timeZone)]],
    note: "Plays from the gap are only recovered if fewer than 50 happened (Spotify's recently-played limit); older ones can be filled in with a streaming-history import on the dashboard (Import).",
  });
}
