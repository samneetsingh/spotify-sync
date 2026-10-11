// The Import page and the home page's Import card.
// Server-rendered; progress pages refresh themselves, so only the upload needs JavaScript
// (public/import.js). Everything from the export or the owner is escaped.

import type { Session } from "../auth";
import { renderPage, ui, type Notice } from "../dashboard";
import { esc, fmt } from "../email/layout";
import type { Env } from "../env";
import { LIKED_SONGS_WARNING, loadSettings } from "../settings";
import { spanText } from "./emails";
import { LIMITS, PART_SIZE } from "./limits";
import { previewYears } from "./reconcile";
import { latestImport, type ImportRow, type Preview } from "./store";

/** The approve form as submitted (re-rendered with errors). */
export interface ApproveForm {
  frequent: boolean;
  liked: boolean;
  likedConfirm: boolean;
  understand: boolean;
}

/** Defaults: Frequent Plays on, Liked Songs off (it needs an explicit confirmation). */
export const DEFAULT_APPROVE_FORM: ApproveForm = { frequent: true, liked: false, likedConfirm: false, understand: false };

const REFRESH_SECONDS = 5;

const FLASH_OK: Record<string, string> = {
  started: "Upload complete. We're reading your export now and will email you when it's ready to review.",
  approved: "Importing. You can close this page: we'll email you when it's done.",
  cancelled: "Import cancelled. The upload and everything read from it are deleted.",
  retrying: "Retrying. It picks up where it stopped.",
};
const FLASH_ERROR: Record<string, string> = {
  moved: "That import has moved on; here's where it is now.",
  retry: "Couldn't restart the import. Try again in a minute.",
};

function flash(url: URL | undefined): Notice | undefined {
  const ok = url?.searchParams.get("ok");
  if (ok && FLASH_OK[ok]) return { kind: "ok", text: FLASH_OK[ok] };
  const err = url?.searchParams.get("err");
  if (err && FLASH_ERROR[err]) return { kind: "error", text: FLASH_ERROR[err] };
  return undefined;
}

const plays = (n: number) => `${fmt(n)} play${n === 1 ? "" : "s"}`;
/** "Oct 11, 2026, 3:20 PM PDT" in the owner's time zone (the timeZone setting), like the rest of the dashboard. */
function when(ms: number, timeZone: string): string {
  const format = (tz: string) =>
    new Intl.DateTimeFormat("en-US", { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: tz, timeZoneName: "short" }).format(ms);
  try {
    return format(timeZone);
  } catch {
    return format("UTC");
  }
}

// ---------------------------------------------------------------------------- upload

function uploadCard(row: ImportRow | null): string {
  const interrupted = row?.status === "uploading";
  const attrs = [
    `data-import-upload`,
    `data-part-size="${PART_SIZE}"`,
    `data-max-zip="${LIMITS.zipBytes}"`,
    `data-max-json="${LIMITS.jsonBytes}"`,
    `data-max-files="${LIMITS.files}"`,
    `data-max-total="${LIMITS.totalBytes}"`,
  ].join(" ");
  const body = `<p class="lead">Fill in everything you played before spotify-sync started: request <strong>Extended streaming history</strong> at spotify.com/account/privacy (it can take up to 30 days), then upload the zip Spotify emails you, or the Streaming_History_Audio_… JSON files inside it.</p>
${interrupted ? `<p class="note">An earlier upload didn't finish. Choose the files again to start over.</p>` : ""}
<form ${attrs}>
<label for="import-files"><strong>Your export</strong></label>
<p class="note" id="import-files-help">A zip up to ${LIMITS.zipBytes / 1024 / 1024} MB, or up to ${LIMITS.files} JSON files. Keep this tab open while it uploads (a few minutes); after that you can close it.</p>
<p><input id="import-files" type="file" multiple required accept=".zip,.json,application/zip,application/json" aria-describedby="import-files-help"></p>
<div class="actions"><button type="submit" class="btn btn-primary" data-import-submit>Upload</button></div>
<p><progress data-import-progress max="100" value="0" aria-label="Upload progress" hidden>0%</progress></p>
<p class="note" data-import-status role="status" aria-live="polite"></p>
</form>
<noscript><p class="note">Uploading needs JavaScript; everything else on this page works without it.</p></noscript>`;
  return ui.card("Upload your history", body, { id: "upload" });
}

// ---------------------------------------------------------------------------- review

function yearRows(p: Preview): string {
  const rows = previewYears(p);
  if (!rows.length) return `<p>No changes: your plays already match the export.</p>`;
  return `<ul class="rows">${rows
    .map(
      ([y, ins, upd, del]) =>
        `<li><span class="main"><strong>${y}</strong></span><span class="meta">+${fmt(ins)} added · ${fmt(upd)} completed · −${fmt(del)} removed</span></li>`,
    )
    .join("")}</ul>`;
}

function warningsHtml(p: Preview): string {
  const out: string[] = [];
  const m = p.warnings.accountMismatch;
  if (m) {
    out.push(
      `<div class="notice notice-warn" role="status"><strong>Is this your export?</strong> Only ${fmt(m.matched)} of the ${plays(m.synced)} spotify-sync recorded in these years appear in it. An export from another Spotify account would replace your plays with theirs.</div>`,
    );
  }
  const h = p.warnings.historyLoss;
  if (h) {
    out.push(
      `<div class="notice notice-warn" role="status"><strong>This removes earlier imported plays.</strong> ${fmt(h.deletes)} of the ${plays(h.imported)} from an earlier import aren't in this export. Usually that means this export covers less, or is a different account's.</div>`,
    );
  }
  return out.join("");
}

function checkbox(name: string, label: string, desc: string, checked: boolean, extraHtml = "", gated = false): string {
  const id = `f-${name}`;
  return `<div class="setting${gated ? " gated" : ""}"><div class="control"><input class="toggle" type="checkbox" id="${id}" name="${name}"${checked ? " checked" : ""} aria-describedby="${id}-desc"></div><label for="${id}">${esc(label)}</label><p class="desc" id="${id}-desc">${esc(desc)}</p>${extraHtml}</div>`;
}

/** Which backfills the settings allow (each also needs its setting on). */
interface Features {
  liked: boolean;
  frequent: boolean;
}

function settingOff(label: string, what: string): string {
  return `<div class="setting"><div class="control"></div><p><strong>${esc(label)}</strong></p><p class="desc">${esc(what)} <a href="/settings">Settings</a></p></div>`;
}

function reviewBody(row: ImportRow, p: Preview, form: ApproveForm, errors: string[], features: Features): string {
  const [ins, upd, del] = p.totals;
  const summary = ui.card(
    "Ready to review",
    `<p class="lead">We read ${fmt(p.records)} records from ${esc(spanText(p.from, p.to))}: ${plays(p.plays)} of 30 seconds or more. ${fmt(p.skipped)} podcast, video or other entries and ${fmt(p.short)} shorter streams are left out. Nothing has changed yet.</p>
${ui.facts([
  ["Plays to add", fmt(ins)],
  ["Plays to complete", `${fmt(upd)} (adds the export's details: device, country, shuffle, skips)`],
  ["Plays to remove", `${fmt(del)} (shorter streams, and the live sync's copies of plays the export records more precisely)`],
])}
<details><summary>By year</summary>${yearRows(p)}</details>
<p class="note">The export becomes the record of what you played from ${esc(spanText(p.from, p.to))}. Plays after that stay as they are.</p>`,
    { id: "review", headHtml: ui.pill(p.warnings.accountMismatch || p.warnings.historyLoss ? "warn" : "ok", "Waiting for you") },
  );

  const likedConfirm = `<div class="confirm${errors.length && form.liked && !form.likedConfirm ? " invalid" : ""}"><p><strong>Before you turn this on</strong></p><p>${esc(LIKED_SONGS_WARNING)} This adds every track in your history at once.</p><label><input type="checkbox" name="liked_confirm"${form.likedConfirm ? " checked" : ""}> I understand. Add them.</label></div>`;
  const warned = p.warnings.accountMismatch || p.warnings.historyLoss;
  const understand = warned
    ? `<div class="setting"><div class="control"><input type="checkbox" id="f-understand" name="understand"${form.understand ? " checked" : ""}></div><label for="f-understand">I understand the warning above. Import anyway.</label></div>`
    : "";
  const errorsHtml = errors.length
    ? `<div class="notice notice-error" role="alert"><strong>Not imported yet.</strong><ul>${errors.map((e) => `<li>${esc(e)}</li>`).join("")}</ul></div>`
    : "";
  const approveForm = `<form method="post" action="/import/${esc(row.id)}/approve">
${errorsHtml}${warningsHtml(p)}
<fieldset><legend>Also add to your library</legend>
${features.frequent ? checkbox("frequent", "Frequent Plays", "Adds the songs that now have enough plays to your Frequent Plays playlist.", form.frequent) : settingOff("Frequent Plays", "Frequent Plays is off. To fill it from your history, switch it on first in")}
${features.liked ? checkbox("liked", "Liked Songs", "Adds every track in your history to your Liked Songs.", form.liked, likedConfirm, true) : settingOff("Liked Songs", "Adding songs to Liked Songs is off. To add your history to Liked Songs, switch it on first in")}
${understand}
</fieldset>
<div class="savebar"><button type="submit" class="btn btn-primary">Import</button><span class="note">Takes a few minutes; we'll email you when it's done.</span></div>
</form>`;
  const cancel = ui.card("Changed your mind?", `<p>Cancel deletes the upload and everything read from it. Nothing in your history changes.</p>`, {
    actionsHtml: ui.postButton(`/import/${row.id}/cancel`, "Cancel import", { variant: "danger" }),
  });
  return summary + approveForm + cancel;
}

// ---------------------------------------------------------------------------- other states

function progressCard(title: string, row: ImportRow, cancellable: boolean, timeZone: string): string {
  const entries = Object.values(row.entries);
  const read = entries.filter((e) => e.done).length;
  const facts: Array<[string, string]> = [["Status", row.progress ?? "Starting"]];
  if (row.status === "reading" && entries.length) facts.push(["Files read", `${read} of ${entries.length}`]);
  facts.push(["Updated", when(row.updated_at, timeZone)]);
  return ui.card(
    title,
    `${ui.facts(facts)}<p class="note">This page refreshes itself. You can close it: we'll email you when ${row.status === "applying" ? "it's done" : "it's ready to review"}.</p>`,
    {
      id: "progress",
      headHtml: ui.pill("neutral", "In progress"),
      actionsHtml: cancellable ? ui.postButton(`/import/${row.id}/cancel`, "Cancel import", { variant: "danger" }) : undefined,
    },
  );
}

function failedCard(row: ImportRow): string {
  const applied = row.applied_to !== null && row.preview ? `<p class="note">Imported so far: ${esc(spanText(row.preview.from, row.applied_to))}. Those months stay imported.</p>` : "";
  return ui.card("The import stopped", `<p>Retry picks up where it stopped.</p><span class="error-text">${esc(row.error ?? "Unknown error")}</span>${applied}`, {
    id: "failed",
    headHtml: ui.pill("bad", "Stopped"),
    actionsHtml: ui.postButton(`/import/${row.id}/retry`, "Retry", { variant: "primary" }) + ui.postButton(`/import/${row.id}/cancel`, "Discard", { variant: "danger" }),
  });
}

function lastImportCard(row: ImportRow, timeZone: string): string {
  const p = row.preview;
  if (row.status === "done" && p) {
    return ui.card(
      "Last import",
      ui.facts([
        ["Covered", spanText(p.from, p.to)],
        ["Plays added", fmt(p.totals[0])],
        ["Plays completed", fmt(p.totals[1])],
        ["Plays removed", fmt(p.totals[2])],
        ["Finished", when(row.updated_at, timeZone)],
      ]),
      { id: "last", headHtml: ui.pill("ok", "Imported") },
    );
  }
  if (row.status === "expired") return ui.card("Last import", `<p>The review expired after 7 days, so nothing was imported. Upload the export again to start over.</p>`, { id: "last", headHtml: ui.pill("neutral", "Expired") });
  return "";
}

export interface ImportPageOptions {
  url?: URL;
  form?: ApproveForm;
  errors?: string[];
  status?: number;
}

/** GET /import (and the approve form re-rendered with errors). */
export async function importPage(env: Env, db: D1Database, session: Session, opts: ImportPageOptions = {}): Promise<Response> {
  const [row, { values }] = await Promise.all([latestImport(db), loadSettings(db, env)]);
  const notice = flash(opts.url);
  const page = (body: string, extra: { refresh?: boolean; scripts?: boolean } = {}) =>
    renderPage({
      title: "Import history",
      session,
      nav: "import",
      body,
      notice,
      refreshSeconds: extra.refresh ? REFRESH_SECONDS : undefined,
      scripts: extra.scripts ? ["/import.js"] : undefined,
      status: opts.status,
    });

  switch (row?.status) {
    case "reading":
      return page(progressCard("Reading your export", row, true, values.timeZone), { refresh: true });
    case "applying":
      return page(progressCard("Importing", row, false, values.timeZone), { refresh: true });
    case "review":
      if (row.preview) {
        return page(reviewBody(row, row.preview, opts.form ?? DEFAULT_APPROVE_FORM, opts.errors ?? [], { liked: values.liked, frequent: values.frequent }));
      }
      return page(progressCard("Preparing the review", row, true, values.timeZone), { refresh: true });
    case "failed":
      return page(failedCard(row));
    default:
      return page(uploadCard(row) + (row ? lastImportCard(row, values.timeZone) : ""), { scripts: true });
  }
}

/** The home page's Import card, times in `timeZone`. Shown only when IMPORTS and IMPORT_WORKFLOW are bound. */
export async function importCard(db: D1Database, timeZone = "UTC"): Promise<string> {
  const row = await latestImport(db);
  const open = (label: string, variant: "primary" | "secondary" = "secondary") => ui.linkButton("/import", label, variant);
  switch (row?.status) {
    case "reading":
    case "applying":
      return ui.card("History import", `<p>${esc(row.progress ?? "In progress")}</p>`, { id: "import", headHtml: ui.pill("neutral", "In progress"), actionsHtml: open("Open the import") });
    case "review":
      return ui.card("History import", `<p>Your export is read. Review the changes and click Import.</p>`, {
        id: "import",
        headHtml: ui.pill("warn", "Ready to review"),
        actionsHtml: open("Review the import", "primary"),
      });
    case "failed":
      return ui.card("History import", `<p>The import stopped. Retry picks up where it stopped.</p>`, { id: "import", headHtml: ui.pill("bad", "Stopped"), actionsHtml: open("Open the import") });
    case "done":
      return ui.card("History import", `<p>Imported ${esc(row.preview ? spanText(row.preview.from, row.preview.to) : "your history")}, on ${esc(when(row.updated_at, timeZone))}.</p>`, {
        id: "import",
        headHtml: ui.pill("ok", "Imported"),
        actionsHtml: open("Import again"),
      });
    default:
      return ui.card("History import", `<p>Add everything you played before spotify-sync started, from Spotify's Extended streaming history.</p>`, {
        id: "import",
        actionsHtml: open("Import history", "primary"),
      });
  }
}
