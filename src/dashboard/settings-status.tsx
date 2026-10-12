// The Settings page's live state, next to the settings it belongs to: the Spotify card (connection,
// last sync, Sync now), failing jobs, and a status line under some settings (a playlist's link or
// Recreate, a digest's next send and "Send me a preview", the AI editor's usage). JSX escapes every
// Spotify- and user-supplied value.
//
// The settings controls sit inside the settings <form>, and HTML forms don't nest, so the status
// lines' buttons post small forms rendered after it (ActionForms) and name them with `form=`, like
// the Reset buttons.

import type { Child } from "hono/jsx";
import type { Session } from "../auth";
import { MAX_CALLS_PER_MONTH } from "../editor";
import { fmt, playlistUrl, plays } from "../email/layout";
import type { WriteMode } from "../env";
import { inHolidaySeason } from "../jobs/holiday-playlist";
import { PLACEHOLDER_PREFIX } from "../jobs/owned-playlists";
import { jobLabel } from "../runtime";
import type { SettingKey, SettingValues } from "../settings";
import { zonedDate } from "../utils/time";
import { Card, Facts, LinkButton, Pill, PostButton, Row, Rows } from "./components/primitives";
import { ago, localTime } from "./layout";
import { nextDigestRun, periodLabel, runDay } from "./next-digest";
import type { DashboardStatus, OwnedPlaylistKey } from "./status";
import { syncState } from "./sync-state";

const LIKED_URL = "https://open.spotify.com/collection/tracks";

export interface StatusView {
  session: Session;
  status: DashboardStatus;
  values: SettingValues;
  writeMode: WriteMode;
  /** Email binding and both addresses are set; `to` is where everything goes. */
  email: { configured: boolean; to: string | null };
}

// ---------------------------------------------------------------------------- Spotify

export function SpotifyCard({ v }: { v: StatusView }) {
  const s = v.status;
  const tz = v.values.timeZone;
  const state = syncState(s, s.now);
  const primary = !s.connected ? (
    <LinkButton href="/login" label="Connect Spotify" variant="primary" />
  ) : state.loginError ? (
    <LinkButton href="/login" label="Reconnect Spotify" variant="primary" />
  ) : null;

  const last = s.lastSuccess;
  const lastAt = last ? (last.finishedAt ?? last.startedAt) : 0;
  const facts: Array<[string, Child]> = [
    [
      "Account",
      v.session.displayName ? (
        <>
          {v.session.displayName}
          <span class="sub">{v.session.spotifyId}</span>
        </>
      ) : (
        v.session.spotifyId
      ),
    ],
    [
      "Last sync",
      last ? (
        <>
          {ago(lastAt, s.now)}
          <span class="sub">{`${localTime(lastAt, tz)} · ${plays(last.playsFetched ?? 0)} fetched`}</span>
        </>
      ) : (
        "Not yet"
      ),
    ],
    ["Plays saved", fmt(s.totalPlays)],
    ["Last 7 days", plays(s.playsLast7Days)],
  ];
  if (v.writeMode !== "live") {
    facts.push([
      "Mode",
      <>
        {v.writeMode === "dry_run" ? "Dry run" : "Shadow"}
        <span class="sub">Nothing is written to your Spotify library.</span>
      </>,
    ]);
  }
  const actions = (
    <>
      {primary}
      {s.connected ? <PostButton action="/actions/sync" label="Sync now" variant={primary ? "secondary" : "primary"} /> : null}
    </>
  );
  return (
    <Card title="Spotify" id="spotify" head={<Pill tone={state.tone} text={state.label} />} actions={actions}>
      <p class="lead">{state.lead}</p>
      <Facts rows={facts} />
    </Card>
  );
}

// ---------------------------------------------------------------------------- problems

export function ProblemsCard({ v }: { v: StatusView }) {
  const { failing, now } = v.status;
  if (!failing.length) return null;
  const tz = v.values.timeZone;
  return (
    <Card
      title="Problems"
      id="problems"
      head={<Pill tone="bad" text={`${failing.length} failing`} />}
      actions={v.values.advanced ? <LinkButton href="/activity" label="See activity" /> : undefined}
    >
      <p class="lead">{v.values.alerts ? "You get an email when a job fails and a note when it recovers." : "Problem alerts are off, so failures only show up here."}</p>
      <Rows>
        {failing.map((f) => {
          const since = f.since ? `Failing since ${localTime(f.since, tz)} (${ago(f.since, now)})` : "Failing";
          const runs = `${f.failures} failed run${f.failures === 1 ? "" : "s"}`;
          return (
            <Row>
              <h3>{jobLabel(f.job)}</h3>
              <span class="meta">{`${since} · ${runs}`}</span>
              {f.lastError ? <code class="error-text">{f.lastError.slice(0, 500)}</code> : null}
            </Row>
          );
        })}
      </Rows>
    </Card>
  );
}

// ---------------------------------------------------------------------------- status lines

/** Which owned playlist each setting switches. */
const PLAYLIST_OF: Partial<Record<SettingKey, OwnedPlaylistKey>> = {
  frequent: "frequent",
  hindiFavorites: "hindi",
  onThisDay: "on_this_day",
  forgottenFavorites: "forgotten_favorites",
  holiday: "holiday",
};

/** When a playlist that's on but not created yet will appear. */
const CREATED_WHEN: Record<OwnedPlaylistKey, string> = {
  frequent: "at the next sync",
  hindi: "tonight",
  on_this_day: "tonight",
  forgotten_favorites: "tonight",
  holiday: "tonight",
};

/** A submit button for one of ActionForms' forms. */
function FormButton({ form, label, ariaLabel }: { form: string; label: string; ariaLabel: string }) {
  return (
    <button type="submit" form={form} class="btn btn-secondary btn-small" aria-label={ariaLabel}>
      {label}
    </button>
  );
}

const canPreview = (v: StatusView) => v.email.configured || v.writeMode !== "live";

function playlistLine(v: StatusView, key: SettingKey, playlist: OwnedPlaylistKey, name: string): Child {
  const id = v.status.playlistState[playlist];
  if (id === "off") {
    return (
      <>
        <Pill tone="warn" text="Deleted in Spotify" /> <span>No longer updated.</span>
        <FormButton form={`recreate-${playlist}`} label="Recreate" ariaLabel={`Recreate ${name}`} />
      </>
    );
  }
  if (key === "holiday" && !inHolidaySeason(zonedDate(v.status.now, v.values.timeZone))) return "Out of season: updated from October to January 6.";
  if (id && !id.startsWith(PLACEHOLDER_PREFIX)) return <a href={playlistUrl(id)}>Open in Spotify</a>;
  return `Not created yet: it appears ${CREATED_WHEN[playlist]}.`;
}

function digestLine(v: StatusView, kind: "week" | "month"): Child {
  const tz = v.values.timeZone;
  const next = nextDigestRun(kind, v.status.now, tz, v.status.lastDigest[kind]);
  const name = kind === "week" ? "weekly digest" : "monthly recap";
  return (
    <>
      <span>{next ? `Next: ${runDay(next.at, tz)}, covering ${periodLabel(next.period)}.` : "Next: not scheduled."}</span>
      {canPreview(v) ? (
        <div class="status-action">
          <FormButton form={`preview-${kind}`} label="Send me a preview" ariaLabel={`Send me a preview of the ${name}`} />
        </div>
      ) : null}
    </>
  );
}

/**
 * The status line under each setting that has one, only while it's on (an off setting has nothing
 * to report). Playlist names come from the setting labels.
 */
export function settingLines(v: StatusView, labels: Record<SettingKey, string>): Partial<Record<SettingKey, Child>> {
  const on = (key: SettingKey) => v.values[key] === true;
  const lines: Partial<Record<SettingKey, Child>> = {};
  if (on("liked")) lines.liked = <a href={LIKED_URL}>Open Liked Songs</a>;
  for (const [key, playlist] of Object.entries(PLAYLIST_OF) as Array<[SettingKey, OwnedPlaylistKey]>) {
    if (on(key)) lines[key] = playlistLine(v, key, playlist, labels[key]);
  }
  if (on("artistPlaylists")) {
    const artists = v.status.artistPlaylists;
    // A popover modal (the HTML popover API: no script; Esc or a click outside closes it). The
    // buttons are type=button, since this sits inside the settings form.
    const count = `${fmt(artists.length)} artist playlist${artists.length === 1 ? "" : "s"}`;
    lines.artistPlaylists = artists.length ? (
      <>
        <button type="button" class="btn btn-secondary btn-small" popovertarget="artist-playlists">
          {`View ${count}`}
        </button>
        <div id="artist-playlists" class="modal" popover="auto" role="dialog" aria-labelledby="artist-playlists-title">
          <div class="modal-head">
            <h3 id="artist-playlists-title">{count}</h3>
            <button type="button" class="btn btn-secondary btn-small" popovertarget="artist-playlists" popovertargetaction="hide">
              Close
            </button>
          </div>
          <p class="note">One per artist you play a lot, updated every night.</p>
          <ul class="modal-list">
            {artists.map((a) => (
              <li>
                <a href={playlistUrl(a.id)}>{a.name}</a>
              </li>
            ))}
          </ul>
        </div>
      </>
    ) : (
      "None yet: an artist gets one once you've played them a lot."
    );
  }
  if (on("digestWeekly")) lines.digestWeekly = digestLine(v, "week");
  if (on("digestMonthly")) lines.digestMonthly = digestLine(v, "month");
  if (on("aiEditor")) {
    const used = `${Math.min(v.status.aiCalls, MAX_CALLS_PER_MONTH)} of ${MAX_CALLS_PER_MONTH} AI edits used this month.`;
    lines.aiEditor = v.status.aiPaused ? (
      <>
        <Pill tone="warn" text="Paused" /> <span>{used}</span>
      </>
    ) : (
      used
    );
  }
  return lines;
}

/** The Emails group's footnote: where email goes, dry runs, and what a preview costs. */
export function emailsNote(v: StatusView, aiAvailable: boolean): string {
  return [
    v.email.configured ? `Everything goes to ${v.email.to}.` : "Email isn't set up for this dashboard, so nothing is sent.",
    v.writeMode !== "live" ? "Dry run: digests and previews are written to the Worker log instead of being sent." : "",
    aiAvailable && v.values.aiEditor ? "A preview uses one AI edit, like a real digest." : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/** The forms the status lines' buttons submit (outside the settings form). */
export function ActionForms({ v }: { v: StatusView }) {
  const deleted = (Object.values(PLAYLIST_OF) as OwnedPlaylistKey[]).filter((p) => v.status.playlistState[p] === "off");
  return (
    <>
      {canPreview(v)
        ? (["week", "month"] as const).map((kind) => (
            <form id={`preview-${kind}`} method="post" action="/actions/preview" hidden>
              <input type="hidden" name="kind" value={kind} />
            </form>
          ))
        : null}
      {deleted.map((p) => (
        <form id={`recreate-${p}`} method="post" action="/actions/playlist/recreate" hidden>
          <input type="hidden" name="key" value={p} />
        </form>
      ))}
    </>
  );
}
