// syncState: the Spotify connection's tone, label and sentence, shared by Manage and Home's chip.

import { describe, expect, it } from "vitest";
import type { FailingJob, SyncRun } from "../../src/dashboard/status";
import { STALE_SYNC_MS, SYNC_BUSY_MS, syncState, type SyncStateInput } from "../../src/dashboard/sync-state";

const NOW = Date.UTC(2026, 9, 11, 19);
const MIN = 60_000;

const run = (startedAgo: number, finishedAgo: number | null, status = "success"): SyncRun => ({
  id: 1,
  startedAt: NOW - startedAgo,
  finishedAt: finishedAgo === null ? null : NOW - finishedAgo,
  status,
  playsFetched: 3,
  tracksAdded: 0,
  error: null,
});
const failing = (lastError: string | null, failures = 1, job = "sync"): FailingJob => ({ job, since: NOW - 60 * MIN, failures, lastError });
const healthy: SyncStateInput = { connected: true, lastRun: run(5 * MIN, 5 * MIN - 2000), lastSuccess: run(5 * MIN, 5 * MIN - 2000), failing: [] };
const at = (over: Partial<SyncStateInput>) => syncState({ ...healthy, ...over }, NOW);

describe("syncState", () => {
  it("is connected after a recent successful sync", () => {
    expect(at({})).toEqual({ tone: "ok", label: "Connected", lead: "New plays are saved every 10 minutes.", loginError: false, running: false });
  });

  it("says Spotify isn't connected before anything else", () => {
    expect(at({ connected: false, failing: [failing("invalid_grant")] })).toMatchObject({ tone: "bad", label: "Not connected", loginError: false });
  });

  it("asks to log in again when the sync fails on Spotify's login", () => {
    const s = at({ failing: [failing("Token refresh failed: 400 invalid_grant", 2)] });
    expect(s).toMatchObject({ tone: "bad", label: "Disconnected", loginError: true });
    expect(s.lead).toContain("Log in again to resume");
  });

  it("counts failed syncs, and ignores other failing jobs", () => {
    expect(at({ failing: [failing("boom")] }).lead).toBe("The last sync failed. The details are under Problems.");
    expect(at({ failing: [failing(null, 3)] })).toMatchObject({ tone: "bad", label: "Sync failing", lead: "The last 3 syncs failed. The details are under Problems." });
    expect(at({ failing: [failing("invalid_grant", 1, "weekly-digest")] }).label).toBe("Connected");
  });

  it("waits for the first sync, then shows one that is running", () => {
    expect(at({ lastRun: null, lastSuccess: null })).toMatchObject({ tone: "neutral", label: "Waiting for first sync" });
    expect(at({ lastRun: run(30_000, null, "running") })).toMatchObject({ tone: "neutral", label: "Syncing", running: true });
  });

  it("reports running even when another state wins", () => {
    expect(at({ lastRun: run(30_000, null, "running"), failing: [failing("boom")] })).toMatchObject({ label: "Sync failing", running: true });
  });

  it("treats an unfinished run older than SYNC_BUSY_MS as stuck, and an old success as delayed", () => {
    expect(at({ lastRun: run(SYNC_BUSY_MS + 1, null, "running") })).toMatchObject({ label: "Connected", running: false });
    const old = run(STALE_SYNC_MS + MIN, STALE_SYNC_MS);
    expect(at({ lastRun: old, lastSuccess: old })).toMatchObject({ tone: "warn", label: "Sync delayed" });
    expect(at({ lastRun: run(MIN, MIN - 1000, "fail"), lastSuccess: null }).label).toBe("Sync delayed");
  });
});
