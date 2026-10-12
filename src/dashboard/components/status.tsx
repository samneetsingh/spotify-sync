// Home's status: the Spotify sync chip (links to Settings), the slim red banner for problems, and
// the empty state. The connection's tone and wording come from syncState (shared with Settings).

import type { Child } from "hono/jsx";
import { jobLabel } from "../../runtime";
import type { HomeStatus } from "../home-data";
import { ago } from "../layout";
import { syncState } from "../sync-state";
import { Icon } from "./icons";
import { Chip } from "./primitives";

/** The chip's text: the state, plus how long ago the last sync finished when that helps. */
export function statusText(status: HomeStatus, now: number): string {
  const s = syncState(status, now);
  const last = status.lastSuccess;
  if (!last || (s.tone !== "ok" && s.tone !== "warn")) return s.label;
  const at = last.finishedAt ?? last.startedAt;
  return s.tone === "ok" ? `${s.label}, synced ${ago(at, now)}` : `${s.label}, last synced ${ago(at, now)}`;
}

/** The Spotify sync status as a chip linking to the Spotify card in Settings (its text carries the meaning). */
export function StatusChip({ status, now }: { status: HomeStatus; now: number }) {
  return <Chip tone={syncState(status, now).tone} text={statusText(status, now)} href="/settings#spotify" />;
}

/**
 * A slim red banner when Spotify needs (re)connecting or a job is failing; nothing otherwise. The
 * sentence says what's wrong, the link says what to do.
 */
export function Banner({ status, now }: { status: HomeStatus; now: number }) {
  const s = syncState(status, now);
  const others = status.failing.filter((f) => f.job !== "sync");
  let text: string;
  let action: { href: string; label: string };
  if (!status.connected) {
    text = s.lead;
    action = { href: "/login", label: "Connect Spotify" };
  } else if (s.loginError) {
    text = "Spotify's login expired or was revoked, so new plays aren't being saved.";
    action = { href: "/login", label: "Reconnect Spotify" };
  } else if (status.failing.some((f) => f.job === "sync")) {
    text = `${s.lead.replace(" The details are under Problems.", "")}${others.length ? ` ${failingSentence(others.map((f) => f.job))}` : ""}`;
    action = { href: "/settings#problems", label: "See problems" };
  } else if (others.length) {
    text = failingSentence(others.map((f) => f.job));
    action = { href: "/settings#problems", label: "See problems" };
  } else {
    return null;
  }
  return (
    <div class="banner" role="alert">
      <span class="banner-icon" aria-hidden="true">
        !
      </span>
      <p class="banner-text">{text}</p>
      <a class="banner-action" href={action.href}>
        {action.label}
      </a>
    </div>
  );
}

/** "Artist playlists is failing." / "Weekly digest and Monthly recap are failing." */
function failingSentence(jobs: string[]): string {
  const names = jobs.map(jobLabel);
  const list = names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return `${list} ${names.length === 1 ? "is" : "are"} failing.`;
}

export interface EmptyStateProps {
  title: string;
  /** One sentence of direction. */
  children?: Child;
  /** A link or button. */
  action?: Child;
}

/** An empty widget: a music-note icon square, what's missing and what happens next. */
export function EmptyState({ title, children, action }: EmptyStateProps) {
  return (
    <div class="empty">
      <span class="empty-icon" aria-hidden="true">
        <Icon name="music" />
      </span>
      <p class="empty-title">{title}</p>
      {children ? <p class="empty-text">{children}</p> : null}
      {action ? <div class="empty-action">{action}</div> : null}
    </div>
  );
}
