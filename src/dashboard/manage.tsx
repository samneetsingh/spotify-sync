// The Manage page (/manage): the Spotify connection with Sync now, problems, emails with previews,
// playlists with Recreate, the history import card and recent activity. Pure rendering from a
// ManageView (src/dashboard/index.ts gathers it), so it is easy to test and to screenshot. JSX
// escapes every Spotify- and user-supplied value; only the import card's HTML goes in through raw()
// (importCard builds it from escaped HTML).

import type { Child } from "hono/jsx";
import type { Session } from "../auth";
import { MAX_CALLS_PER_MONTH } from "../editor";
import { fmt, playlistUrl, plays } from "../email/layout";
import type { WriteMode } from "../env";
import { inHolidaySeason } from "../jobs/holiday-playlist";
import { PLACEHOLDER_PREFIX } from "../jobs/owned-playlists";
import { jobLabel } from "../runtime";
import type { SettingValues } from "../settings";
import { zonedDate } from "../utils/time";
import { Card, Facts, LinkButton, Pill, PostButton, Row, Rows } from "./components/primitives";
import { ago, localTime, type Tone } from "./layout";
import { nextDigestRun, periodLabel, runDay } from "./next-digest";
import { raw, render } from "./render";
import { OWNED_PLAYLISTS, type DashboardStatus, type FailingJob, type OwnedPlaylistKey } from "./status";
import { syncState } from "./sync-state";

const LIKED_URL = "https://open.spotify.com/collection/tracks";

export interface ManageView {
  session: Session;
  status: DashboardStatus;
  values: SettingValues;
  writeMode: WriteMode;
  /** Email binding and both addresses are set; `to` is where everything goes. */
  email: { configured: boolean; to: string | null };
  /** OPENAI_API_KEY is set (the AI editor setting is visible). */
  aiAvailable: boolean;
  /** The import card's HTML (already escaped); empty when import isn't set up. */
  importHtml: string;
}

/** An <h3> with a muted line under it: a row's main text. */
const Title = ({ name, meta }: { name: Child; meta?: string }) => (
  <>
    <h3>{name}</h3>
    {meta ? <span class="meta">{meta}</span> : null}
  </>
);

// ---------------------------------------------------------------------------- Spotify

function SpotifyCard({ v }: { v: ManageView }) {
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

function ProblemsCard({ failing, now, tz, alerts }: { failing: FailingJob[]; now: number; tz: string; alerts: boolean }) {
  if (!failing.length) return null;
  return (
    <Card title="Problems" id="problems" head={<Pill tone="bad" text={`${failing.length} failing`} />} actions={<LinkButton href="/activity" label="See activity" />}>
      <p class="lead">{alerts ? "You get an email when a job fails and a note when it recovers." : "Problem alerts are off, so failures only show up here."}</p>
      <Rows>
        {failing.map((f) => {
          const since = f.since ? `Failing since ${localTime(f.since, tz)} (${ago(f.since, now)})` : "Failing";
          const runs = `${f.failures} failed run${f.failures === 1 ? "" : "s"}`;
          return (
            <Row>
              <Title name={jobLabel(f.job)} meta={`${since} · ${runs}`} />
              {f.lastError ? <code class="error-text">{f.lastError.slice(0, 500)}</code> : null}
            </Row>
          );
        })}
      </Rows>
    </Card>
  );
}

// ---------------------------------------------------------------------------- emails

const onOff = (on: boolean) => <Pill tone={on ? "ok" : "neutral"} text={on ? "On" : "Off"} />;

function DigestRow({ v, kind }: { v: ManageView; kind: "week" | "month" }) {
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
  const preview = canPreview ? (
    <PostButton action="/actions/preview" label="Send me a preview" fields={{ kind }} small ariaLabel={`Send me a preview of the ${name.toLowerCase()}`} />
  ) : null;
  return (
    <Row side={onOff(on)} actions={preview}>
      <Title name={name} meta={meta} />
    </Row>
  );
}

function EmailsCard({ v }: { v: ManageView }) {
  const ai: [Tone, string] = !v.values.aiEditor ? ["neutral", "Off"] : v.status.aiPaused ? ["warn", "Paused"] : ["ok", "On"];
  const notes = [
    v.email.configured ? `Everything goes to ${v.email.to}.` : "Email isn't set up for this dashboard, so nothing is sent.",
    v.writeMode !== "live" ? "Dry run: digests and previews are written to the Worker log instead of being sent." : "",
    v.aiAvailable && v.values.aiEditor ? "A preview uses one AI edit, like a real digest." : "",
  ].filter(Boolean);
  return (
    <Card title="Emails" id="emails">
      <Rows>
        <DigestRow v={v} kind="week" />
        <DigestRow v={v} kind="month" />
        <Row side={onOff(v.values.alerts)}>
          <Title name="Problem alerts" meta={v.values.alerts ? "When a job fails, and when it recovers." : "Off. Failures only show up here."} />
        </Row>
        {v.aiAvailable ? (
          <Row side={<Pill tone={ai[0]} text={ai[1]} />}>
            <Title name="AI editor" meta={`${Math.min(v.status.aiCalls, MAX_CALLS_PER_MONTH)} of ${MAX_CALLS_PER_MONTH} AI edits used this month.`} />
          </Row>
        ) : null}
      </Rows>
      <p class="note">{notes.join(" ")}</p>
    </Card>
  );
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

function PlaylistRow({ v, playlist, name }: { v: ManageView; playlist: OwnedPlaylistKey; name: string }) {
  const on = v.values[PLAYLIST_SETTING[playlist]] as boolean;
  const id = v.status.playlistState[playlist];
  const created = !!id && id !== "off" && !id.startsWith(PLACEHOLDER_PREFIX);
  const linked = created ? <a href={playlistUrl(id)}>{name}</a> : name;
  if (!on) {
    return (
      <Row side={onOff(false)}>
        <Title name={name} meta="Off. Turn it on in Settings." />
      </Row>
    );
  }
  if (id === "off") {
    return (
      <Row
        side={<Pill tone="warn" text="Deleted" />}
        actions={<PostButton action="/actions/playlist/recreate" label="Recreate" fields={{ key: playlist }} small ariaLabel={`Recreate ${name}`} />}
      >
        <Title name={name} meta="You deleted it in Spotify, so it's no longer updated." />
      </Row>
    );
  }
  if (playlist === "holiday" && !inHolidaySeason(zonedDate(v.status.now, v.values.timeZone))) {
    return (
      <Row side={<Pill tone="neutral" text="Out of season" />}>
        <Title name={linked} meta="Updated from October to January 6." />
      </Row>
    );
  }
  if (created) {
    return (
      <Row side={onOff(true)}>
        <Title name={linked} />
      </Row>
    );
  }
  return (
    <Row side={<Pill tone="neutral" text="Not created yet" />}>
      <Title name={name} meta={`${CREATED_WHEN[playlist]}.`} />
    </Row>
  );
}

function ArtistPlaylists({ v }: { v: ManageView }) {
  const artists = v.status.artistPlaylists;
  if (!v.values.artistPlaylists) {
    return (
      <Rows>
        <Row side={onOff(false)}>
          <Title name="Artist playlists" meta="Off. Turn them on in Settings." />
        </Row>
      </Rows>
    );
  }
  if (!artists.length) return <p class="note">No artist playlists yet. An artist gets one, updated every night, once you've played them a lot.</p>;
  return (
    <details>
      <summary>{`Artist playlists (${fmt(artists.length)})`}</summary>
      <ul class="tags">
        {artists.map((a) => (
          <li>
            <a href={playlistUrl(a.id)}>{a.name}</a>
          </li>
        ))}
      </ul>
    </details>
  );
}

function PlaylistsCard({ v }: { v: ManageView }) {
  return (
    <Card title="Playlists" id="playlists" actions={<LinkButton href="/settings" label="Change playlists" />}>
      <Rows>
        {v.values.liked ? (
          <Row side={onOff(true)}>
            <Title name={<a href={LIKED_URL}>Liked Songs</a>} meta="Every song you play is added." />
          </Row>
        ) : (
          <Row side={onOff(false)}>
            <Title name="Liked Songs" meta="Off. Played songs aren't added." />
          </Row>
        )}
        {OWNED_PLAYLISTS.map((p) => (
          <PlaylistRow v={v} playlist={p.key} name={p.name} />
        ))}
      </Rows>
      <ArtistPlaylists v={v} />
    </Card>
  );
}

// ---------------------------------------------------------------------------- activity

function ActivityCard({ v }: { v: ManageView }) {
  const events = v.status.recent;
  return (
    <Card title="Recent activity" id="recent" actions={<LinkButton href="/activity" label="All activity" />}>
      {events.length ? (
        <Rows>
          {events.map((e) => (
            <Row side={e.ok ? null : <Pill tone="bad" text="Failed" />}>
              {e.summary}
              <span class="sub">{ago(e.at, v.status.now)}</span>
            </Row>
          ))}
        </Rows>
      ) : (
        <p class="lead">Nothing yet. Jobs, emails and changes show up here.</p>
      )}
    </Card>
  );
}

/** The Manage page's cards, in order. */
export function Manage({ v }: { v: ManageView }) {
  return (
    <>
      <SpotifyCard v={v} />
      <ProblemsCard failing={v.status.failing} now={v.status.now} tz={v.values.timeZone} alerts={v.values.alerts} />
      <EmailsCard v={v} />
      <PlaylistsCard v={v} />
      {v.importHtml ? raw(v.importHtml) : null}
      <ActivityCard v={v} />
    </>
  );
}

/** The Manage page's body as HTML, for renderPage. */
export const manageBody = (v: ManageView): string => render(<Manage v={v} />);
