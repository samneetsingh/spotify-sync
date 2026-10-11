// The activity page: recent events (jobs, emails, account, settings, imports), recent syncs and the
// latest changes made in Spotify. One db.batch. Every Spotify- or error-supplied string is escaped.

import type { ActivityEvent, ActivityKind } from "../activity";
import { esc, plays } from "../email/layout";
import { playlistStateKey } from "../jobs/owned-playlists";
import { ago, localTime, ui } from "./layout";
import { OWNED_PLAYLISTS, SYNC_RUN_COLUMNS, sqlTime, syncRun, type SyncRun } from "./status";

export interface SpotifyChange {
  at: number;
  job: string;
  action: string;
  target: string | null;
  /** The playlist's name when we know it (artist playlists, owned playlists). */
  targetName: string | null;
  count: number;
  executed: boolean;
}

export interface ActivityData {
  now: number;
  events: ActivityEvent[];
  syncs: SyncRun[];
  changes: SpotifyChange[];
}

export async function loadActivity(db: D1Database, now = Date.now()): Promise<ActivityData> {
  const owned = OWNED_PLAYLISTS.map((p) => playlistStateKey(p.key));
  const [events, syncs, changes] = await db.batch([
    db.prepare("SELECT id, at, kind, ok, summary, detail FROM activity ORDER BY at DESC, id DESC LIMIT 50"),
    db.prepare(`SELECT ${SYNC_RUN_COLUMNS} FROM sync_runs ORDER BY id DESC LIMIT 20`),
    db
      .prepare(
        `SELECT w.created_at, w.job, w.action, w.target, w.item_count, w.executed,
           COALESCE(p.name, (SELECT key FROM state WHERE value = w.target AND key IN (${owned.map((_, i) => `?${i + 1}`).join(", ")}) LIMIT 1)) AS target_name
         FROM worker_actions w LEFT JOIN playlists p ON p.playlist_id = w.target
         ORDER BY w.id DESC LIMIT 20`,
      )
      .bind(...owned),
  ]);
  const ownedName = new Map(OWNED_PLAYLISTS.map((p) => [playlistStateKey(p.key), p.name]));
  type ChangeRow = { created_at: string; job: string; action: string; target: string | null; item_count: number; executed: number; target_name: string | null };
  return {
    now,
    events: (events!.results as Array<Omit<ActivityEvent, "ok"> & { ok: number; kind: ActivityKind }>).map((e) => ({ ...e, ok: e.ok === 1 })),
    syncs: (syncs!.results as Parameters<typeof syncRun>[0][]).map(syncRun),
    changes: (changes!.results as ChangeRow[]).map((c) => ({
      at: sqlTime(c.created_at) ?? 0,
      job: c.job,
      action: c.action,
      target: c.target,
      targetName: c.target_name ? (ownedName.get(c.target_name) ?? c.target_name) : null,
      count: c.item_count,
      executed: c.executed === 1,
    })),
  };
}

const KIND_LABEL: Record<string, string> = { job: "Job", email: "Email", account: "Account", settings: "Settings", import: "Import" };

const ACTION_LABEL: Record<string, string> = {
  addToPlaylist: "Added to",
  replacePlaylistItems: "Refreshed",
  addToLikedSongs: "Added to Liked Songs",
  createPlaylist: "Created a playlist",
  unfollowPlaylist: "Removed",
};

const when = (ms: number, now: number, tz: string) => `${esc(ago(ms, now))} · ${esc(localTime(ms, tz))}`;

function eventsCard(d: ActivityData, tz: string): string {
  if (!d.events.length) return ui.card("Events", `<p class="lead">Nothing yet. Jobs, emails, logins and setting changes show up here.</p>`, { id: "events" });
  const rows = d.events.map((e) => {
    const detail = !e.detail ? "" : e.ok ? `<span class="sub">${esc(e.detail)}</span>` : `<code class="error-text">${esc(e.detail)}</code>`;
    return `<li><div class="main">${esc(e.summary)}<span class="sub">${esc(KIND_LABEL[e.kind] ?? e.kind)} · ${when(e.at, d.now, tz)}</span>${detail}</div>${e.ok ? "" : `<div class="side">${ui.pill("bad", "Failed")}</div>`}</li>`;
  });
  return ui.card("Events", `<ul class="rows">${rows.join("")}</ul>`, { id: "events" });
}

function syncsCard(d: ActivityData, tz: string): string {
  if (!d.syncs.length) return ui.card("Syncs", `<p class="lead">No syncs yet. They run every 10 minutes.</p>`, { id: "syncs" });
  const rows = d.syncs.map((s) => {
    const pill = s.status === "success" ? ui.pill("ok", "Done") : s.status === "fail" ? ui.pill("bad", "Failed") : ui.pill("neutral", s.finishedAt ? (s.status ?? "Unknown") : "Running");
    const counts = s.playsFetched === null ? "" : ` · ${plays(s.playsFetched)} fetched${s.tracksAdded ? `, ${s.tracksAdded} added to your library` : ""}`;
    const error = s.error ? `<code class="error-text">${esc(s.error.slice(0, 500))}</code>` : "";
    return `<li><div class="main">${esc(ago(s.startedAt, d.now))}<span class="sub">${esc(localTime(s.startedAt, tz) + counts)}</span>${error}</div><div class="side">${pill}</div></li>`;
  });
  return ui.card("Syncs", `<ul class="rows">${rows.join("")}</ul>`, { id: "syncs" });
}

function changesCard(d: ActivityData, tz: string): string {
  if (!d.changes.length) return ui.card("Spotify changes", `<p class="lead">Nothing has been changed in your Spotify library yet.</p>`, { id: "changes" });
  const rows = d.changes.map((c) => {
    const what = ACTION_LABEL[c.action] ?? c.action;
    const target = c.action === "addToLikedSongs" || c.action === "createPlaylist" ? "" : ` ${c.targetName ?? c.target ?? ""}`;
    const items = `${c.count} ${c.action === "createPlaylist" ? "" : c.count === 1 ? "song" : "songs"}`.trim();
    const sub = `${c.action === "createPlaylist" ? "" : `${items} · `}${c.job} · ${ago(c.at, d.now)} · ${localTime(c.at, tz)}`;
    return `<li><div class="main">${esc(`${what}${target}`.trim())}<span class="sub">${esc(sub)}</span></div><div class="side">${c.executed ? ui.pill("ok", "Done") : ui.pill("neutral", "Dry run")}</div></li>`;
  });
  return ui.card("Spotify changes", `<p class="lead">The latest writes to your library. "Dry run" means it was only logged.</p><ul class="rows">${rows.join("")}</ul>`, { id: "changes" });
}

export function activityBody(d: ActivityData, timeZone: string): string {
  return [eventsCard(d, timeZone), syncsCard(d, timeZone), changesCard(d, timeZone)].join("\n");
}
