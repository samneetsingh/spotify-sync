// The import's emails: "ready to review", "imported" and
// "failed", in the alert design. Sent through the ungated email config (the `alerts` setting can't
// silence them) and recorded in the activity log.

import { logActivity } from "../activity";
import { sendEmail, type Email } from "../alerts";
import { actionButton, cardEnd, codeBlock, facts, smallPrint } from "../email/components";
import { C, TY, esc, fmt, shell } from "../email/layout";
import type { Env } from "../env";
import { emailConfig, quietly } from "../runtime";
import type { Preview } from "./store";

const SUBJECT_PREFIX = "[spotify-sync] ";

const TONES = {
  ok: { color: C.green, bg: "#10301d" },
  warn: { color: C.amber, bg: "#3a2a0c" },
  bad: { color: C.red, bg: "#3a1418" },
} as const;

/** Like alertHeader, with the import's own pill labels. */
function header(tone: keyof typeof TONES, label: string, title: string, lead: string): string {
  const t = TONES[tone];
  return `<tr><td class="g" style="padding:32px 20px 0">
<span style="display:inline-block;background:${t.bg};color:${t.color};${TY.micro};font-weight:700;border-radius:999px;padding:4px 12px">&#9679; ${esc(label)}</span>
<div style="${TY.number};margin-top:16px">${esc(title)}</div>
<div style="${TY.body};color:${C.soft};margin-top:8px">${esc(lead)}</div>
</td></tr>`;
}

/** "Mar 2016" (UTC, like the export's timestamps). */
export const monthYear = (ms: number): string => new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric", timeZone: "UTC" }).format(ms);
export const spanText = (from: number, to: number): string => `${monthYear(from)} to ${monthYear(to - 1)}`;

const importUrl = (publicUrl: string | undefined) => (publicUrl ? `${new URL(publicUrl).origin}/import` : null);

interface Parts {
  tone: keyof typeof TONES;
  label: string;
  subject: string;
  title: string;
  lead: string;
  action?: { label: string; note: string };
  facts?: Array<[string, string]>;
  error?: string;
  note?: string;
}

function render(p: Parts, publicUrl: string | undefined): Email {
  const url = importUrl(publicUrl);
  const subject = SUBJECT_PREFIX + p.subject;
  const body = [
    header(p.tone, p.label, p.title, p.lead),
    p.action && url ? actionButton(p.action.label, url, p.action.note) : "",
    p.facts?.length ? facts(p.facts) : "",
    p.error ? codeBlock("Error", p.error) : "",
    p.note ? smallPrint(p.note) : "",
    cardEnd,
  ].join("\n");
  const text = [
    p.title,
    p.lead,
    ...(p.action && url ? ["", `${p.action.label}: ${url}`, p.action.note] : []),
    ...(p.facts?.length ? ["", ...p.facts.map(([k, v]) => `${k}: ${v}`)] : []),
    ...(p.error ? ["", `Error: ${p.error}`] : []),
    ...(p.note ? ["", p.note] : []),
  ].join("\n");
  return { subject, text, html: shell({ title: subject, preheader: p.lead, body }) };
}

/** Your history is read and waits for the owner's approval on the Import page. */
export function reviewEmail(p: Preview, publicUrl: string | undefined): Email {
  const [ins, upd, del] = p.totals;
  const warn = p.warnings.accountMismatch || p.warnings.historyLoss;
  return render(
    {
      tone: warn ? "warn" : "ok",
      label: "Ready to review",
      subject: "Your listening history is ready to review",
      title: "Ready to review",
      lead: `We read ${fmt(p.plays)} plays from ${spanText(p.from, p.to)}. Nothing has changed yet: review the changes and click Import.`,
      action: { label: "Review the import", note: "The review stays open for 7 days." },
      facts: [
        ["Plays to add", fmt(ins)],
        ["Plays to complete", fmt(upd)],
        ["Plays to remove", fmt(del)],
      ],
      note: warn
        ? "Heads up: something in this export looks off (details on the Import page). Check it before importing."
        : "Removed plays are ones the export doesn't have: streams under 30 seconds, and the live sync's copies of plays the export records more precisely.",
    },
    publicUrl,
  );
}

export interface DoneSummary {
  from: number;
  to: number;
  added: number;
  updated: number;
  removed: number;
  newTracks: number;
  newArtists: number;
  /** Library backfill: tracks added, or why it didn't run (null = not chosen). */
  liked: number | null;
  frequent: number | null;
  librarySkipped: string | null;
}

export function doneEmail(s: DoneSummary, publicUrl: string | undefined): Email {
  const rows: Array<[string, string]> = [
    ["Years", spanText(s.from, s.to)],
    ["Plays added", fmt(s.added)],
    ["Plays completed", fmt(s.updated)],
    ["Plays removed", fmt(s.removed)],
    ["New tracks", fmt(s.newTracks)],
    ["New artists", fmt(s.newArtists)],
  ];
  if (s.liked !== null) rows.push(["Liked Songs", `${fmt(s.liked)} added`]);
  if (s.frequent !== null) rows.push(["Frequent Plays", `${fmt(s.frequent)} added`]);
  return render(
    {
      tone: "ok",
      label: "Imported",
      subject: "Your listening history is imported",
      title: "History imported",
      lead: "Your digests, history playlists and artist playlists now use your full listening history.",
      action: { label: "Open the dashboard", note: "Artist playlists catch up at the next nightly run." },
      facts: rows,
      note: s.librarySkipped ? `Library backfill skipped: ${s.librarySkipped}.` : undefined,
    },
    publicUrl,
  );
}

export function failedEmail(error: string, publicUrl: string | undefined): Email {
  return render(
    {
      tone: "bad",
      label: "Import failed",
      subject: "Your history import stopped",
      title: "The import stopped",
      lead: "Retry on the Import page: it picks up where it stopped. Months already imported stay imported.",
      action: { label: "Open the import", note: "Or discard it and start over with a fresh upload." },
      error,
    },
    publicUrl,
  );
}

/** Sends one import email to the owner and records it in the activity log. Never throws. */
export async function sendImportEmail(env: Env, db: D1Database, email: Email): Promise<boolean> {
  const sent = await sendEmail(emailConfig(env), email);
  await quietly("activity", () => logActivity(db, "email", `${email.subject.replace(SUBJECT_PREFIX, "")}${sent ? "" : " (not sent)"}`, sent));
  return sent;
}
