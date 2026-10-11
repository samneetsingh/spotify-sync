// The logged-in home page: Spotify connection, problems, emails, playlists, import and recent
// activity. Pure rendering from a HomeView (src/dashboard/index.ts gathers it), so it is easy to test
// and to screenshot.

import type { Session } from "../auth";
import { MAX_CALLS_PER_MONTH } from "../editor";
import { esc, fmt, plays, playlistUrl } from "../email/layout";
import type { WriteMode } from "../env";
import { inHolidaySeason } from "../jobs/holiday-playlist";
import { PLACEHOLDER_PREFIX } from "../jobs/owned-playlists";
import type { SettingValues } from "../settings";
import { zonedDate } from "../utils/time";
import { ago, localTime, ui } from "./layout";
import { nextDigestRun, periodLabel, runDay } from "./next-digest";
import { OWNED_PLAYLISTS, type DashboardStatus, type FailingJob, type OwnedPlaylistKey } from "./status";

/** Syncs normally run every 10 minutes; after this long without a finished one, say so. */
const STALE_SYNC_MS = 45 * 60_000;
const LIKED_URL = "https://open.spotify.com/collection/tracks";

export interface HomeView {
  session: Session;
  status: DashboardStatus;
  values: SettingValues;
  writeMode: WriteMode;
  /** Email binding and both addresses are set; `to` is where everything goes. */
  email: { configured: boolean; to: string | null };
  /** OPENAI_API_KEY is set (the AI editor setting is visible). */
  aiAvailable: boolean;
  /** Playlist ids from legacy deploy vars, which win over `state`. */
  envPlaylistIds: Partial<Record<OwnedPlaylistKey, string>>;
  /** The import card's HTML; empty when import isn't set up. */
  importHtml: string;
}

export const isLoginError = (message: string | null): boolean => !!message && /invalid_grant|refresh token|No refresh token/i.test(message);

/** A list row: text on the left, a status pill on the right, actions (buttons) under the text. */
const row = (mainHtml: string, sideHtml = "", actionsHtml = "") =>
  `<li><div class="main">${mainHtml}${actionsHtml ? `<div class="row-actions">${actionsHtml}</div>` : ""}</div>${sideHtml ? `<div class="side">${sideHtml}</div>` : ""}</li>`;

/** Job names as the owner reads them (the alert state uses the cron job ids). */
const JOB_LABEL: Record<string, string> = {
  sync: "Sync",
  "artist-playlists": "Artist playlists",
  "hindi-favorites": "Hindi Favorites",
  "history-playlists": "On This Day and Forgotten Favorites",
  "holiday-playlist": "Holiday Favorites",
  "weekly-digest": "Weekly digest",
  "monthly-recap": "Monthly recap",
};

// ---------------------------------------------------------------------------- Spotify

function spotifyCard(v: HomeView): string {
  const s = v.status;
  const tz = v.values.timeZone;
  const sync = s.failing.find((f) => f.job === "sync");
  const running = s.lastRun && s.lastRun.finishedAt === null && s.now - s.lastRun.startedAt < 2 * 60_000;
  let pill: string;
  let lead: string;
  let primary = "";
  if (!s.connected) {
    pill = ui.pill("bad", "Not connected");
    lead = "Spotify isn't connected, so nothing is syncing.";
    primary = ui.linkButton("/login", "Connect Spotify", "primary");
  } else if (sync && isLoginError(sync.lastError)) {
    pill = ui.pill("bad", "Disconnected");
    lead = "Spotify's login expired or was revoked, so new plays aren't being saved. Log in again to resume; only your account is accepted.";
    primary = ui.linkButton("/login", "Reconnect Spotify", "primary");
  } else if (sync) {
    pill = ui.pill("bad", "Sync failing");
    lead = `The last ${sync.failures === 1 ? "sync" : `${sync.failures} syncs`} failed. The details are under Problems.`;
  } else if (!s.lastRun) {
    pill = ui.pill("neutral", "Waiting for first sync");
    lead = "The first sync runs within 10 minutes.";
  } else if (running) {
    pill = ui.pill("neutral", "Syncing");
    lead = "A sync is running right now.";
  } else if (!s.lastSuccess || s.now - s.lastSuccess.startedAt > STALE_SYNC_MS) {
    pill = ui.pill("warn", "Sync delayed");
    lead = "No sync has finished recently. Syncs normally run every 10 minutes.";
  } else {
    pill = ui.pill("ok", "Connected");
    lead = "New plays are saved every 10 minutes.";
  }

  const last = s.lastSuccess;
  const facts: Array<[string, string]> = [
    ["Account", `${esc(v.session.displayName ?? v.session.spotifyId)}${v.session.displayName ? `<span class="sub">${esc(v.session.spotifyId)}</span>` : ""}`],
    ["Last sync", last ? `${esc(ago(last.finishedAt ?? last.startedAt, s.now))}<span class="sub">${esc(localTime(last.finishedAt ?? last.startedAt, tz))} · ${esc(plays(last.playsFetched ?? 0))} fetched</span>` : "Not yet"],
    ["Plays saved", esc(fmt(s.totalPlays))],
    ["Last 7 days", esc(plays(s.playsLast7Days))],
  ];
  if (v.writeMode !== "live") facts.push(["Mode", `${v.writeMode === "dry_run" ? "Dry run" : "Shadow"}<span class="sub">Nothing is written to your Spotify library.</span>`]);
  const actions = `${primary}${s.connected ? ui.postButton("/actions/sync", "Sync now", { variant: primary ? "secondary" : "primary" }) : ""}`;
  return ui.card("Spotify", `<p class="lead">${esc(lead)}</p>${ui.factsHtml(facts)}`, { id: "spotify", headHtml: pill, actionsHtml: actions });
}

// ---------------------------------------------------------------------------- problems

function problemsCard(failing: FailingJob[], now: number, tz: string, alerts: boolean): string {
  if (!failing.length) return "";
  const items = failing.map((f) => {
    const since = f.since ? `Failing since ${localTime(f.since, tz)} (${ago(f.since, now)})` : "Failing";
    const runs = `${f.failures} failed run${f.failures === 1 ? "" : "s"}`;
    const error = f.lastError ? `<code class="error-text">${esc(f.lastError.slice(0, 500))}</code>` : "";
    return row(`<h3>${esc(JOB_LABEL[f.job] ?? f.job)}</h3><span class="meta">${esc(since)} · ${esc(runs)}</span>${error}`);
  });
  const lead = alerts ? "You get an email when a job fails and a note when it recovers." : "Problem alerts are off, so failures only show up here.";
  return ui.card("Problems", `<p class="lead">${esc(lead)}</p><ul class="rows">${items.join("")}</ul>`, {
    id: "problems",
    headHtml: ui.pill("bad", `${failing.length} failing`),
    actionsHtml: ui.linkButton("/activity", "See activity"),
  });
}

// ---------------------------------------------------------------------------- emails

function digestRow(v: HomeView, kind: "week" | "month"): string {
  const on = kind === "week" ? v.values.digestWeekly : v.values.digestMonthly;
  const name = kind === "week" ? "Weekly digest" : "Monthly recap";
  const tz = v.values.timeZone;
  let meta: string;
  if (!on) meta = "Off. Turn it on in Settings.";
  else {
    const next = nextDigestRun(kind, v.status.now, tz, kind === "week" ? v.status.lastDigest.week : v.status.lastDigest.month);
    meta = next ? `Next: ${runDay(next.at, tz)}, covering ${periodLabel(next.period)}` : "Next: not scheduled";
  }
  const canPreview = v.email.configured || v.writeMode !== "live";
  const preview = canPreview
    ? ui.postButton("/actions/preview", "Send me a preview", { fields: { kind }, small: true, ariaLabel: `Send me a preview of the ${name.toLowerCase()}` })
    : "";
  return row(`<h3>${esc(name)}</h3><span class="meta">${esc(meta)}</span>`, ui.pill(on ? "ok" : "neutral", on ? "On" : "Off"), preview);
}

function emailsCard(v: HomeView): string {
  const rows = [digestRow(v, "week"), digestRow(v, "month")];
  rows.push(
    row(
      `<h3>Problem alerts</h3><span class="meta">${esc(v.values.alerts ? "When a job fails, and when it recovers." : "Off. Failures only show up here.")}</span>`,
      ui.pill(v.values.alerts ? "ok" : "neutral", v.values.alerts ? "On" : "Off"),
    ),
  );
  if (v.aiAvailable) {
    const used = `${Math.min(v.status.aiCalls, MAX_CALLS_PER_MONTH)} of ${MAX_CALLS_PER_MONTH} AI edits used this month.`;
    const state = !v.values.aiEditor ? ["neutral", "Off"] : v.status.aiPaused ? ["warn", "Paused"] : ["ok", "On"];
    rows.push(row(`<h3>AI editor</h3><span class="meta">${esc(used)}</span>`, ui.pill(state[0] as "ok", state[1]!)));
  }
  const notes = [
    v.email.configured ? `Everything goes to ${v.email.to}.` : "Email isn't set up for this dashboard, so nothing is sent.",
    v.writeMode !== "live" ? "Dry run: digests and previews are written to the Worker log instead of being sent." : "",
    v.aiAvailable && v.values.aiEditor ? "A preview uses one AI edit, like a real digest." : "",
  ].filter(Boolean);
  return ui.card("Emails", `<ul class="rows">${rows.join("")}</ul><p class="note">${esc(notes.join(" "))}</p>`, { id: "emails" });
}

// ---------------------------------------------------------------------------- playlists

/** Which setting switches each owned playlist. */
const PLAYLIST_SETTING: Record<OwnedPlaylistKey, keyof SettingValues> = {
  frequent: "frequent",
  hindi: "hindiFavorites",
  on_this_day: "onThisDay",
  forgotten_favorites: "forgottenFavorites",
  holiday: "holiday",
};

/** When a playlist that's on but not created yet will appear. */
const CREATED_WHEN: Record<OwnedPlaylistKey, string> = {
  frequent: "Created at the next sync",
  hindi: "Created tonight",
  on_this_day: "Created tonight",
  forgotten_favorites: "Created tonight",
  holiday: "Created tonight",
};

function playlistRow(v: HomeView, key: OwnedPlaylistKey, name: string): string {
  const on = v.values[PLAYLIST_SETTING[key]] as boolean;
  const fromEnv = v.envPlaylistIds[key];
  const stored = v.status.playlistState[key];
  const id = fromEnv ?? stored;
  if (!on) return row(`<h3>${esc(name)}</h3><span class="meta">Off. Turn it on in Settings.</span>`, ui.pill("neutral", "Off"));
  if (!fromEnv && stored === "off") {
    return row(
      `<h3>${esc(name)}</h3><span class="meta">You deleted it in Spotify, so it's no longer updated.</span>`,
      ui.pill("warn", "Deleted"),
      ui.postButton("/actions/playlist/recreate", "Recreate", { fields: { key }, small: true, ariaLabel: `Recreate ${name}` }),
    );
  }
  if (key === "holiday" && !inHolidaySeason(zonedDate(v.status.now, v.values.timeZone))) {
    const title = id && !id.startsWith(PLACEHOLDER_PREFIX) ? ui.link(playlistUrl(id), name) : esc(name);
    return row(`<h3>${title}</h3><span class="meta">Updated from October to January 6.</span>`, ui.pill("neutral", "Out of season"));
  }
  if (id && !id.startsWith(PLACEHOLDER_PREFIX)) return row(`<h3>${ui.link(playlistUrl(id), name)}</h3>`, ui.pill("ok", "On"));
  return row(`<h3>${esc(name)}</h3><span class="meta">${esc(CREATED_WHEN[key])}.</span>`, ui.pill("neutral", "Not created yet"));
}

function playlistsCard(v: HomeView): string {
  const liked = v.values.liked
    ? row(`<h3>${ui.link(LIKED_URL, "Liked Songs")}</h3><span class="meta">Every song you play is added.</span>`, ui.pill("ok", "On"))
    : row(`<h3>Liked Songs</h3><span class="meta">Off. Played songs aren't added.</span>`, ui.pill("neutral", "Off"));
  const rows = [liked, ...OWNED_PLAYLISTS.map((p) => playlistRow(v, p.key, p.name))];
  const artists = v.status.artistPlaylists;
  let artistHtml: string;
  if (!v.values.artistPlaylists) {
    artistHtml = `<ul class="rows"><li><div class="main"><h3>Artist playlists</h3><span class="meta">Off. Turn them on in Settings.</span></div><div class="side">${ui.pill("neutral", "Off")}</div></li></ul>`;
  } else if (!artists.length) {
    artistHtml = `<p class="note">No artist playlists yet. An artist gets one, updated every night, once you've played them a lot.</p>`;
  } else {
    artistHtml = `<details><summary>Artist playlists (${fmt(artists.length)})</summary><ul class="tags">${artists
      .map((a) => `<li>${ui.link(playlistUrl(a.id), a.name)}</li>`)
      .join("")}</ul></details>`;
  }
  return ui.card("Playlists", `<ul class="rows">${rows.join("")}</ul>${artistHtml}`, { id: "playlists", actionsHtml: ui.linkButton("/settings", "Change playlists") });
}

// ---------------------------------------------------------------------------- activity

function activityCard(v: HomeView): string {
  const events = v.status.recent;
  const body = events.length
    ? `<ul class="rows">${events
        .map((e) => row(`${esc(e.summary)}<span class="sub">${esc(ago(e.at, v.status.now))}</span>`, e.ok ? "" : ui.pill("bad", "Failed")))
        .join("")}</ul>`
    : `<p class="lead">Nothing yet. Jobs, emails and changes show up here.</p>`;
  return ui.card("Recent activity", body, { id: "recent", actionsHtml: ui.linkButton("/activity", "All activity") });
}

export function homeBody(v: HomeView): string {
  return [spotifyCard(v), problemsCard(v.status.failing, v.status.now, v.values.timeZone, v.values.alerts), emailsCard(v), playlistsCard(v), v.importHtml, activityCard(v)]
    .filter(Boolean)
    .join("\n");
}

