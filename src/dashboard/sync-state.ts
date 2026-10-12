// The Spotify connection's state in one place: the Manage page's Spotify card and Home's status chip
// show the same tone, label and sentence. Pure, so it is easy to test.

import { isLoginError } from "../alerts";
import type { Tone } from "./layout";
import type { FailingJob, SyncRun } from "./status";

/** A sync started this recently and not finished counts as running (Sync now waits for it). */
export const SYNC_BUSY_MS = 2 * 60_000;
/** Syncs normally run every 10 minutes; after this long without a finished one, say so. */
export const STALE_SYNC_MS = 45 * 60_000;

export interface SyncStateInput {
  /** A Spotify refresh token is stored. */
  connected: boolean;
  lastRun: SyncRun | null;
  lastSuccess: SyncRun | null;
  failing: FailingJob[];
}

export interface SyncState {
  tone: Tone;
  /** A short label for a pill or chip, e.g. "Connected", "Sync failing". */
  label: string;
  /** One sentence saying what it means. */
  lead: string;
  /** The sync fails on Spotify's login (expired or revoked): the owner must log in again. */
  loginError: boolean;
  /** The latest sync started less than SYNC_BUSY_MS ago and hasn't finished. */
  running: boolean;
}

/** The first matching state wins: not connected, login expired, sync failing, no sync yet, running, delayed, connected. */
export function syncState(s: SyncStateInput, now: number): SyncState {
  const sync = s.failing.find((f) => f.job === "sync");
  const running = !!s.lastRun && s.lastRun.finishedAt === null && now - s.lastRun.startedAt < SYNC_BUSY_MS;
  const state = (tone: Tone, label: string, lead: string, loginError = false): SyncState => ({ tone, label, lead, loginError, running });
  if (!s.connected) return state("bad", "Not connected", "Spotify isn't connected, so nothing is syncing.");
  if (sync?.lastError && isLoginError(sync.lastError)) {
    return state(
      "bad",
      "Disconnected",
      "Spotify's login expired or was revoked, so new plays aren't being saved. Log in again to resume; only your account is accepted.",
      true,
    );
  }
  if (sync) return state("bad", "Sync failing", `The last ${sync.failures === 1 ? "sync" : `${sync.failures} syncs`} failed. The details are under Problems.`);
  if (!s.lastRun) return state("neutral", "Waiting for first sync", "The first sync runs within 10 minutes.");
  if (running) return state("neutral", "Syncing", "A sync is running right now.");
  if (!s.lastSuccess || now - s.lastSuccess.startedAt > STALE_SYNC_MS) {
    return state("warn", "Sync delayed", "No sync has finished recently. Syncs normally run every 10 minutes.");
  }
  return state("ok", "Connected", "New plays are saved every 10 minutes.");
}
