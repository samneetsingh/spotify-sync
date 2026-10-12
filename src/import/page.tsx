// The Import page and the Manage page's Import card.
// Server-rendered TSX; progress pages refresh themselves, so only the upload needs JavaScript
// (public/import.js, which finds the form by its data-import-* hooks: keep them as they are).
// JSX escapes everything from the export, the Workflow (progress, errors) or the owner.

import type { Child } from "hono/jsx";
import type { Session } from "../auth";
import { Card, Facts, LinkButton, Pill, PostButton } from "../dashboard/components/primitives";
import { renderPage, type Notice } from "../dashboard/layout";
import { render } from "../dashboard/render";
import { fmt } from "../email/layout";
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
/** An import that hasn't moved for this long offers Retry and Cancel (the routes act only once its Workflow stopped). */
export const STUCK_MS = 30 * 60_000;

const FLASH_OK: Record<string, string> = {
  started: "Upload complete. We're reading your export now and will email you when it's ready to review.",
  approved: "Importing. You can close this page: we'll email you when it's done.",
  cancelled: "Import cancelled. The upload and everything read from it are deleted.",
  retrying: "Retrying. It picks up where it stopped.",
};
const FLASH_ERROR: Record<string, string> = {
  moved: "That import has moved on; here's where it is now.",
  retry: "Couldn't restart the import. Try again in a minute.",
  running: "The import is still running, so it can't be changed now. Try again in a minute.",
};

function flash(url: URL | undefined): Notice | undefined {
  const ok = url?.searchParams.get("ok");
  if (ok && Object.hasOwn(FLASH_OK, ok)) return { kind: "ok", text: FLASH_OK[ok] };
  const err = url?.searchParams.get("err");
  if (err && Object.hasOwn(FLASH_ERROR, err)) return { kind: "error", text: FLASH_ERROR[err] };
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

/**
 * The uploader's form. public/import.js needs: form[data-import-upload] with the data-max-* limits,
 * its input[type="file"], [data-import-submit], [data-import-progress] (a <progress>, shown while
 * uploading) and [data-import-status] (the aria-live progress text). The file input is the drop
 * target itself (browsers accept dropped files on it), styled as a dashed panel.
 */
function UploadCard({ row }: { row: ImportRow | null }) {
  const interrupted = row?.status === "uploading";
  return (
    <Card title="Upload your history" id="upload">
      <p class="lead">
        Fill in everything you played before spotify-sync started: request <strong>Extended streaming history</strong> at spotify.com/account/privacy (it can take up to 30 days), then upload
        the zip Spotify emails you, or the Streaming_History_Audio_… JSON files inside it.
      </p>
      {interrupted ? <p class="note">An earlier upload didn't finish. Choose the files again to start over.</p> : null}
      <form
        data-import-upload=""
        data-part-size={PART_SIZE}
        data-max-zip={LIMITS.zipBytes}
        data-max-json={LIMITS.jsonBytes}
        data-max-files={LIMITS.files}
        data-max-total={LIMITS.totalBytes}
      >
        <div class="dropzone">
          <label for="import-files">Your export</label>
          <p class="help" id="import-files-help">
            A zip up to {LIMITS.zipBytes / 1024 / 1024} MB, or up to {LIMITS.files} JSON files. Keep this tab open while it uploads (a few minutes); after that you can close it.
          </p>
          <input id="import-files" type="file" multiple required accept=".zip,.json,application/zip,application/json" aria-describedby="import-files-help" />
        </div>
        <div class="actions">
          <button type="submit" class="btn btn-primary" data-import-submit="">
            Upload
          </button>
        </div>
        <progress data-import-progress="" max="100" value="0" aria-label="Upload progress" hidden>
          0%
        </progress>
        <p class="note upload-status" data-import-status="" role="status" aria-live="polite"></p>
      </form>
      <noscript>
        <p class="note">Uploading needs JavaScript; everything else on this page works without it.</p>
      </noscript>
    </Card>
  );
}

// ---------------------------------------------------------------------------- review

/** "+1,204" / "−3" for a non-zero change, "0" otherwise. */
const signed = (n: number, sign: "+" | "−") => (n ? `${sign}${fmt(n)}` : "0");

/** The per-year changes as a table (with a total row when it spans several years). */
function YearTable({ p }: { p: Preview }) {
  const rows = previewYears(p);
  if (!rows.length) return <p>No changes: your plays already match the export.</p>;
  const [ins, upd, del] = p.totals;
  return (
    <div class="table-wrap">
      <table class="years">
        <caption class="vh">Plays changed by year</caption>
        <thead>
          <tr>
            <th scope="col">Year</th>
            <th scope="col" class="num">Added</th>
            <th scope="col" class="num">Completed</th>
            <th scope="col" class="num">Removed</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([year, i, u, d]) => (
            <tr>
              <th scope="row">{year}</th>
              <td class="num">{signed(i, "+")}</td>
              <td class="num">{fmt(u)}</td>
              <td class="num">{signed(d, "−")}</td>
            </tr>
          ))}
        </tbody>
        {rows.length > 1 ? (
          <tfoot>
            <tr>
              <th scope="row">Total</th>
              <td class="num">{signed(ins, "+")}</td>
              <td class="num">{fmt(upd)}</td>
              <td class="num">{signed(del, "−")}</td>
            </tr>
          </tfoot>
        ) : null}
      </table>
    </div>
  );
}

function Warnings({ p }: { p: Preview }) {
  const m = p.warnings.accountMismatch;
  const h = p.warnings.historyLoss;
  return (
    <>
      {m ? (
        <div class="notice notice-warn" role="status">
          <strong>Is this your export?</strong> Only {fmt(m.matched)} of the {plays(m.synced)} spotify-sync recorded in these years appear in it. An export from another Spotify account would
          replace your plays with theirs.
        </div>
      ) : null}
      {h ? (
        <div class="notice notice-warn" role="status">
          <strong>This removes earlier imported plays.</strong> {fmt(h.deletes)} of the {plays(h.imported)} from an earlier import aren't in this export. Usually that means this export covers
          less, or is a different account's.
        </div>
      ) : null}
    </>
  );
}

interface CheckboxProps {
  name: string;
  label: string;
  desc: string;
  checked: boolean;
  /** Its children (a confirmation) show only while it's ticked. */
  gated?: boolean;
  children?: Child;
}

function Checkbox({ name, label, desc, checked, gated, children }: CheckboxProps) {
  const id = `f-${name}`;
  return (
    <div class={gated ? "setting gated" : "setting"}>
      <div class="control">
        <input class="toggle" type="checkbox" id={id} name={name} checked={checked} aria-describedby={`${id}-desc`} />
      </div>
      <label for={id}>{label}</label>
      <p class="desc" id={`${id}-desc`}>
        {desc}
      </p>
      {children}
    </div>
  );
}

/** Which backfills the settings allow (each also needs its setting on). */
interface Features {
  liked: boolean;
  frequent: boolean;
}

function SettingOff({ label, what }: { label: string; what: string }) {
  return (
    <div class="setting">
      <div class="control"></div>
      <p>
        <strong>{label}</strong>
      </p>
      <p class="desc">
        {what} <a href="/settings">Settings</a>
      </p>
    </div>
  );
}

interface ReviewProps {
  row: ImportRow;
  p: Preview;
  form: ApproveForm;
  errors: string[];
  features: Features;
}

function Review({ row, p, form, errors, features }: ReviewProps) {
  const [ins, upd, del] = p.totals;
  const warned = !!(p.warnings.accountMismatch || p.warnings.historyLoss);
  const span = spanText(p.from, p.to);
  return (
    <>
      <Card title="Ready to review" id="review" head={<Pill tone={warned ? "warn" : "ok"} text="Waiting for you" />}>
        <p class="lead">
          We read {fmt(p.records)} records from {span}: {plays(p.plays)} of 30 seconds or more. {fmt(p.skipped)} podcast, video or other entries and {fmt(p.short)} shorter streams are left out.
          Nothing has changed yet.
        </p>
        <dl class="totals">
          <div>
            <dt>Plays to add</dt>
            <dd>
              <span class="num">{fmt(ins)}</span>
            </dd>
          </div>
          <div>
            <dt>Plays to complete</dt>
            <dd>
              <span class="num">{fmt(upd)}</span> <span class="sub">adds the export's details: device, country, shuffle, skips</span>
            </dd>
          </div>
          <div>
            <dt>Plays to remove</dt>
            <dd>
              <span class="num">{fmt(del)}</span> <span class="sub">shorter streams, and the live sync's copies of plays the export records more precisely</span>
            </dd>
          </div>
        </dl>
        <details>
          <summary>By year</summary>
          <YearTable p={p} />
        </details>
        <p class="note">The export becomes the record of what you played from {span}. Plays after that stay as they are.</p>
      </Card>
      <form method="post" action={`/import/${row.id}/approve`}>
        {errors.length ? (
          <div class="notice notice-error" role="alert">
            <strong>Not imported yet.</strong>
            <ul>
              {errors.map((e) => (
                <li>{e}</li>
              ))}
            </ul>
          </div>
        ) : null}
        <Warnings p={p} />
        <fieldset>
          <legend>Also add to your library</legend>
          {features.frequent ? (
            <Checkbox name="frequent" label="Frequent Plays" desc="Adds the songs that now have enough plays to your Frequent Plays playlist." checked={form.frequent} />
          ) : (
            <SettingOff label="Frequent Plays" what="Frequent Plays is off. To fill it from your history, switch it on first in" />
          )}
          {features.liked ? (
            <Checkbox name="liked" label="Liked Songs" desc="Adds every track in your history to your Liked Songs." checked={form.liked} gated>
              <div class={errors.length && form.liked && !form.likedConfirm ? "confirm invalid" : "confirm"}>
                <p>
                  <strong>Before you turn this on</strong>
                </p>
                <p>{LIKED_SONGS_WARNING} This adds every track in your history at once.</p>
                <label>
                  <input type="checkbox" name="liked_confirm" checked={form.likedConfirm} /> I understand. Add them.
                </label>
              </div>
            </Checkbox>
          ) : (
            <SettingOff label="Liked Songs" what="Adding songs to Liked Songs is off. To add your history to Liked Songs, switch it on first in" />
          )}
          {warned ? (
            <div class="setting">
              <div class="control">
                <input type="checkbox" id="f-understand" name="understand" checked={form.understand} />
              </div>
              <label for="f-understand">I understand the warning above. Import anyway.</label>
            </div>
          ) : null}
        </fieldset>
        <div class="savebar">
          <button type="submit" class="btn btn-primary">
            Import
          </button>
          <span class="note">Takes a few minutes; we'll email you when it's done.</span>
        </div>
      </form>
      <Card title="Changed your mind?" actions={<PostButton action={`/import/${row.id}/cancel`} label="Cancel import" variant="danger" />}>
        <p>Cancel deletes the upload and everything read from it. Nothing in your history changes.</p>
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------- other states

interface ProgressProps {
  title: string;
  row: ImportRow;
  cancellable: boolean;
  timeZone: string;
  now?: number;
}

function ProgressCard({ title, row, cancellable, timeZone, now = Date.now() }: ProgressProps) {
  const entries = Object.values(row.entries);
  const read = entries.filter((e) => e.done).length;
  const reading = row.status === "reading" && entries.length > 0;
  const facts: Array<[string, string]> = [["Status", row.progress ?? "Starting"]];
  if (reading) facts.push(["Files read", `${read} of ${entries.length}`]);
  facts.push(["Updated", when(row.updated_at, timeZone)]);
  // Applying can't be cancelled while it runs; if it stopped without finishing, retry or discard it.
  const stuck = row.status === "applying" && now - row.updated_at > STUCK_MS;
  const cancel = <PostButton action={`/import/${row.id}/cancel`} label="Cancel import" variant="danger" />;
  const actions = stuck ? (
    <>
      <PostButton action={`/import/${row.id}/retry`} label="Retry" variant="primary" />
      {cancel}
    </>
  ) : cancellable ? (
    cancel
  ) : undefined;
  return (
    <Card title={title} id="progress" head={<Pill tone={stuck ? "warn" : "neutral"} text={stuck ? "No progress" : "In progress"} />} actions={actions}>
      <Facts rows={facts} />
      {/* The "Files read" fact says the same in words. */}
      {reading ? <progress class="files-read" max={entries.length} value={read} aria-hidden="true"></progress> : null}
      {stuck ? (
        <p class="note">No progress for a while. If it stopped, Retry picks up where it stopped; Cancel keeps the months already imported and discards the rest.</p>
      ) : (
        <p class="note">This page refreshes itself. You can close it: we'll email you when {row.status === "applying" ? "it's done" : "it's ready to review"}.</p>
      )}
    </Card>
  );
}

function FailedCard({ row }: { row: ImportRow }) {
  return (
    <Card
      title="The import stopped"
      id="failed"
      head={<Pill tone="bad" text="Stopped" />}
      actions={
        <>
          <PostButton action={`/import/${row.id}/retry`} label="Retry" variant="primary" />
          <PostButton action={`/import/${row.id}/cancel`} label="Discard" variant="danger" />
        </>
      }
    >
      <p>Retry picks up where it stopped.</p>
      <span class="error-text">{row.error ?? "Unknown error"}</span>
      {row.applied_to !== null && row.preview ? <p class="note">Imported so far: {spanText(row.preview.from, row.applied_to)}. Those months stay imported.</p> : null}
    </Card>
  );
}

function LastImportCard({ row, timeZone }: { row: ImportRow; timeZone: string }) {
  const p = row.preview;
  if (row.status === "done" && p) {
    return (
      <Card title="Last import" id="last" head={<Pill tone="ok" text="Imported" />}>
        <Facts
          rows={[
            ["Covered", spanText(p.from, p.to)],
            ["Plays added", fmt(p.totals[0])],
            ["Plays completed", fmt(p.totals[1])],
            ["Plays removed", fmt(p.totals[2])],
            ["Finished", when(row.updated_at, timeZone)],
          ]}
        />
      </Card>
    );
  }
  if (row.status === "expired") {
    return (
      <Card title="Last import" id="last" head={<Pill tone="neutral" text="Expired" />}>
        <p>The review expired after 7 days, so nothing was imported. Upload the export again to start over.</p>
      </Card>
    );
  }
  return null;
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
  const page = (body: Child, extra: { refresh?: boolean; scripts?: boolean } = {}) =>
    renderPage({
      title: "Import history",
      session,
      nav: "settings",
      showActivity: values.advanced,
      body: render(<>{body}</>),
      notice,
      refreshSeconds: extra.refresh ? REFRESH_SECONDS : undefined,
      scripts: extra.scripts ? ["/import.js"] : undefined,
      status: opts.status,
    });

  switch (row?.status) {
    case "reading":
      return page(<ProgressCard title="Reading your export" row={row} cancellable timeZone={values.timeZone} />, { refresh: true });
    case "applying":
      // A stuck import offers buttons instead, so the page stops refreshing under them.
      return page(<ProgressCard title="Importing" row={row} cancellable={false} timeZone={values.timeZone} />, { refresh: Date.now() - row.updated_at <= STUCK_MS });
    case "review":
      if (row.preview) {
        return page(
          <Review row={row} p={row.preview} form={opts.form ?? DEFAULT_APPROVE_FORM} errors={opts.errors ?? []} features={{ liked: values.liked, frequent: values.frequent }} />,
        );
      }
      return page(<ProgressCard title="Preparing the review" row={row} cancellable timeZone={values.timeZone} />, { refresh: true });
    case "failed":
      return page(<FailedCard row={row} />);
    default:
      return page(
        <>
          <UploadCard row={row} />
          {row ? <LastImportCard row={row} timeZone={values.timeZone} /> : null}
        </>,
        { scripts: true },
      );
  }
}

/**
 * The History import section of the Settings page's Account card (HTML; the page embeds it with
 * raw()), times in `timeZone`. Shown only when IMPORTS and IMPORT_WORKFLOW are bound.
 */
export async function importSection(db: D1Database, timeZone = "UTC"): Promise<string> {
  const row = await latestImport(db);
  const card = (head: Child, text: Child, label: string, variant: "primary" | "secondary" = "secondary") =>
    render(
      <div class="card-part" id="import">
        <div class="part-head">
          <h3>History import</h3>
          {head}
        </div>
        <p>{text}</p>
        <div class="actions">
          <LinkButton href="/import" label={label} variant={variant} />
        </div>
      </div>,
    );
  switch (row?.status) {
    case "reading":
    case "applying":
      return card(<Pill tone="neutral" text="In progress" />, row.progress ?? "In progress", "Open the import");
    case "review":
      return card(<Pill tone="warn" text="Ready to review" />, "Your export is read. Review the changes and click Import.", "Review the import", "primary");
    case "failed":
      return card(<Pill tone="bad" text="Stopped" />, "The import stopped. Retry picks up where it stopped.", "Open the import");
    case "done":
      return card(
        <Pill tone="ok" text="Imported" />,
        `Imported ${row.preview ? spanText(row.preview.from, row.preview.to) : "your history"}, on ${when(row.updated_at, timeZone)}.`,
        "Import again",
      );
    default:
      return card(null, "Add everything you played before spotify-sync started, from Spotify's Extended streaming history.", "Import history", "primary");
  }
}
