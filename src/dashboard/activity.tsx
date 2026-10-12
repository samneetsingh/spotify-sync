// The activity page: recent events (jobs, emails, account, settings, imports), recent syncs and the
// latest changes made in Spotify. One db.batch. JSX escapes every Spotify- or error-supplied string.

import type { ActivityEvent, ActivityKind } from "../activity";
import { plays } from "../email/layout";
import { playlistStateKey } from "../jobs/owned-playlists";
import { Card, Pill, Row, Rows } from "./components/primitives";
import { ago, localTime } from "./layout";
import { render } from "./render";
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

const when = (ms: number, now: number, tz: string) => `${ago(ms, now)} · ${localTime(ms, tz)}`;

/** An error message in a monospace block. */
const ErrorText = ({ text }: { text: string }) => <code class="error-text">{text}</code>;

function EventsCard({ d, tz }: { d: ActivityData; tz: string }) {
  return (
    <Card title="Events" id="events">
      {d.events.length ? (
        <Rows>
          {d.events.map((e) => (
            <Row side={e.ok ? null : <Pill tone="bad" text="Failed" />}>
              {e.summary}
              <span class="sub">{`${KIND_LABEL[e.kind] ?? e.kind} · ${when(e.at, d.now, tz)}`}</span>
              {!e.detail ? null : e.ok ? <span class="sub">{e.detail}</span> : <ErrorText text={e.detail} />}
            </Row>
          ))}
        </Rows>
      ) : (
        <p class="lead">Nothing yet. Jobs, emails, logins and setting changes show up here.</p>
      )}
    </Card>
  );
}

function SyncsCard({ d, tz }: { d: ActivityData; tz: string }) {
  return (
    <Card title="Syncs" id="syncs">
      {d.syncs.length ? (
        <Rows>
          {d.syncs.map((s) => {
            const pill =
              s.status === "success" ? (
                <Pill tone="ok" text="Done" />
              ) : s.status === "fail" ? (
                <Pill tone="bad" text="Failed" />
              ) : (
                <Pill tone="neutral" text={s.finishedAt ? (s.status ?? "Unknown") : "Running"} />
              );
            const counts = s.playsFetched === null ? "" : ` · ${plays(s.playsFetched)} fetched${s.tracksAdded ? `, ${s.tracksAdded} added to your library` : ""}`;
            return (
              <Row side={pill}>
                {ago(s.startedAt, d.now)}
                <span class="sub">{localTime(s.startedAt, tz) + counts}</span>
                {s.error ? <ErrorText text={s.error.slice(0, 500)} /> : null}
              </Row>
            );
          })}
        </Rows>
      ) : (
        <p class="lead">No syncs yet. They run every 10 minutes.</p>
      )}
    </Card>
  );
}

function ChangesCard({ d, tz }: { d: ActivityData; tz: string }) {
  if (!d.changes.length) {
    return (
      <Card title="Spotify changes" id="changes">
        <p class="lead">Nothing has been changed in your Spotify library yet.</p>
      </Card>
    );
  }
  return (
    <Card title="Spotify changes" id="changes">
      <p class="lead">The latest writes to your library. "Dry run" means it was only logged.</p>
      <Rows>
        {d.changes.map((c) => {
          const what = ACTION_LABEL[c.action] ?? c.action;
          const target = c.action === "addToLikedSongs" || c.action === "createPlaylist" ? "" : ` ${c.targetName ?? c.target ?? ""}`;
          const items = `${c.count} ${c.action === "createPlaylist" ? "" : c.count === 1 ? "song" : "songs"}`.trim();
          const sub = `${c.action === "createPlaylist" ? "" : `${items} · `}${c.job} · ${ago(c.at, d.now)} · ${localTime(c.at, tz)}`;
          return (
            <Row side={c.executed ? <Pill tone="ok" text="Done" /> : <Pill tone="neutral" text="Dry run" />}>
              {`${what}${target}`.trim()}
              <span class="sub">{sub}</span>
            </Row>
          );
        })}
      </Rows>
    </Card>
  );
}

export function Activity({ d, timeZone }: { d: ActivityData; timeZone: string }) {
  return (
    <>
      <EventsCard d={d} tz={timeZone} />
      <SyncsCard d={d} tz={timeZone} />
      <ChangesCard d={d} tz={timeZone} />
    </>
  );
}

/** The activity page's body as HTML, for renderPage. */
export const activityBody = (d: ActivityData, timeZone: string): string => render(<Activity d={d} timeZone={timeZone} />);
