// Owner actions (POST, Origin-checked by the router): sync now, digest previews, recreate a
// playlist that was deleted in Spotify. Each logs to `activity` and redirects back with a fixed
// flash code (no user content in URLs): post/redirect/get.

import { logActivity } from "../activity";
import { loadConfig } from "../config";
import { getState, setState } from "../db/state";
import type { Env } from "../env";
import { redirect303, statusPage } from "../http";
import { previewDigest, type DigestKind } from "../jobs/digest";
import { playlistStateKey } from "../jobs/owned-playlists";
import { runSync } from "../jobs/sync";
import { editorConfig, emailConfig, quietly, withJob } from "../runtime";
import type { EffectiveSettings } from "../settings";
import { SpotifyClient } from "../spotify/client";
import { OWNED_PLAYLISTS, isOwnedPlaylistKey } from "./status";

/** A sync started this recently and not finished counts as running (Sync now waits for it). */
export const SYNC_BUSY_MS = 2 * 60_000;
/** One preview per kind per 10 minutes: protects the email quota and the AI editor's monthly cap. */
export const PREVIEW_COOLDOWN_MS = 10 * 60_000;
export const previewKey = (kind: DigestKind) => `preview:${kind}`;

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
const back = (code: string, ok = true) => redirect303(`/?${ok ? "ok" : "error"}=${code}`);

/** POST /actions/sync: runs the sync job inline (with its alerting), unless one is already running. */
export async function syncNow(env: Env, now = Date.now()): Promise<Response> {
  const db = env.DB;
  const busy = await db
    .prepare("SELECT 1 FROM sync_runs WHERE finished_at IS NULL AND started_at > datetime(?1, 'unixepoch') LIMIT 1")
    .bind(Math.floor((now - SYNC_BUSY_MS) / 1000))
    .first();
  if (busy) return back("sync-busy", false);
  try {
    const r = await withJob(env, "sync", (cfg, jobDb, sp) => runSync(cfg, jobDb, sp));
    const extras = [r.likedAdded ? `${r.likedAdded} liked` : "", r.frequentAdded ? `${r.frequentAdded} added to Frequent Plays` : ""].filter(Boolean);
    const summary = `Sync now: ${r.playsFetched} new play${r.playsFetched === 1 ? "" : "s"}${extras.length ? `, ${extras.join(", ")}` : ""}`;
    await quietly("activity", () => logActivity(db, "job", summary));
    return back("synced");
  } catch (err) {
    // withJob has already recorded the failure (and alerted).
    await quietly("activity", () => logActivity(db, "job", "Sync now failed", false, message(err)));
    return back("sync-failed", false);
  }
}

/**
 * POST /actions/preview (kind=week|month): emails "[Preview] ..." of the last complete period
 * through the ungated email config. Counts toward the AI editor's cap; leaves recap:* alone.
 */
export async function sendPreview(form: FormData, env: Env, settings: EffectiveSettings, now = Date.now()): Promise<Response> {
  const kind = form.get("kind");
  if (kind !== "week" && kind !== "month") return statusPage(400, "Unknown preview", "Pick the weekly digest or the monthly recap.");
  const db = env.DB;
  const name = kind === "week" ? "weekly digest" : "monthly recap";
  const cfg = loadConfig(env, settings.values);
  const email = emailConfig(env, settings.values);
  const live = cfg.writeMode === "live";
  if (live && !(email.binding && email.from && email.to)) return back("email-off", false);

  const last = Number(await getState(db, previewKey(kind))) || 0;
  if (now - last < PREVIEW_COOLDOWN_MS) return back(`preview-cooldown`, false);
  await setState(db, previewKey(kind), String(now));

  try {
    const sp = new SpotifyClient(env.SPOTIFY_CLIENT_ID, env.SPOTIFY_CLIENT_SECRET, db, cfg.writeMode);
    const result = await previewDigest(kind, cfg, db, sp, email, now, editorConfig(env, settings.values));
    if (!result) {
      await quietly("activity", () => logActivity(db, "email", `Preview of the ${name}: no plays to show`));
      return back(`preview-empty-${kind}`, false);
    }
    if (result.sent) {
      await quietly("activity", () => logActivity(db, "email", `Preview of the ${name} sent (${result.period})`));
      return back("preview-sent");
    }
    if (!live) {
      await quietly("activity", () => logActivity(db, "email", `Preview of the ${name} logged (${result.period}, ${cfg.writeMode})`));
      return back("preview-logged");
    }
    await quietly("activity", () => logActivity(db, "email", `Preview of the ${name} couldn't be sent`, false));
    return back("preview-failed", false);
  } catch (err) {
    await quietly("activity", () => logActivity(db, "email", `Preview of the ${name} failed`, false, message(err)));
    return back("preview-failed", false);
  }
}

/**
 * POST /actions/playlist/recreate (key=<owned playlist>): forgets a playlist that was deleted in
 * Spotify (state "off"), so its job creates a new one on its next run. Only whitelisted keys.
 */
export async function recreatePlaylist(form: FormData, env: Env): Promise<Response> {
  const key = String(form.get("key") ?? "");
  if (!isOwnedPlaylistKey(key)) return statusPage(400, "Unknown playlist", "That playlist can't be recreated from here.");
  const res = await env.DB.prepare("DELETE FROM state WHERE key = ?1 AND value = 'off'").bind(playlistStateKey(key)).run();
  if (res.meta.changes) {
    const name = OWNED_PLAYLISTS.find((p) => p.key === key)!.name;
    await quietly("activity", () => logActivity(env.DB, "settings", `${name} will be recreated at its next run`));
  }
  return back("recreate");
}
