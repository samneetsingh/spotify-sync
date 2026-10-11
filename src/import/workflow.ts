// The import Workflow. Every step is idempotent, so a replay or
// a retry instance (`<id>-r<attempt>`) resumes where the last one stopped: staged entries are
// skipped, applied months are guarded by `applied_to`, enrichment only selects rows still missing.

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep, type WorkflowStepConfig } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { logActivity } from "../activity";
import { loadConfig } from "../config";
import { parseWriteMode, type Env, type ImportParams } from "../env";
import { runSyncFull } from "../jobs/sync";
import { quietly } from "../runtime";
import { loadSettings } from "../settings";
import { SpotifyClient } from "../spotify/client";
import { doneEmail, failedEmail, reviewEmail, sendImportEmail, spanText, type DoneSummary } from "./emails";
import { enrichArtists, enrichTracks } from "./enrich";
import { applySlice, buildPreview, monthSlices, previewSlice, spanOf, yearSlices, type Span, type YearPreview } from "./reconcile";
import { deleteUpload, indexImport, stageEntry } from "./stage";
import { getImport, setProgress, type ImportOptions, type Preview, type StageEntry } from "./store";
import { ImportError, NOT_EXTENDED_HISTORY } from "./zip";

/** The event the Import page sends when the owner approves (payload: ImportOptions). */
export const APPROVE_EVENT = "approve";
export const APPROVAL_TIMEOUT = "7 days";
/** Tracks per library backfill step (runSyncFull's limit). */
export const LIBRARY_STEP_LIMIT = 1000;
const MAX_LIBRARY_STEPS = 500;

const D1_STEP: WorkflowStepConfig = { retries: { limit: 5, delay: "10 seconds", backoff: "exponential" } };
const READ_STEP: WorkflowStepConfig = { ...D1_STEP, timeout: "10 minutes" };
// RateLimitError from SpotifyClient lands here; the backoff gives Spotify time to recover.
const SPOTIFY_STEP: WorkflowStepConfig = { retries: { limit: 8, delay: "30 seconds", backoff: "exponential" }, timeout: "15 minutes" };
/** Emails: at most once, even if something after the send fails. */
const ONCE: WorkflowStepConfig = { retries: { limit: 0, delay: 0 } };

/** Owner-facing ImportErrors (a bad zip, a cancelled import) fail at once instead of retrying. */
const guarded =
  <T>(fn: () => Promise<T>) =>
  async (): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof ImportError) throw new NonRetryableError(err.message);
      throw err;
    }
  };

export type ImportOutcome = { status: "done" | "expired" };

interface StagedState {
  span: Span;
  stats: { records: number; skipped: number; short: number; plays: number };
  options: ApprovedOptions | null;
}

/** The approved options plus the library size when approved (for "new tracks" in the summary). */
export interface ApprovedOptions extends ImportOptions {
  tracksBefore: number;
  artistsBefore: number;
}

/** Only booleans pass; anything else is off. Liked stays off unless explicitly true. */
export const normalizeOptions = (raw: unknown): ImportOptions => {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return { liked: o.liked === true, frequent: o.frequent === true };
};

async function stagedState(db: D1Database, importId: string): Promise<StagedState> {
  const row = await getImport(db, importId);
  if (!row || row.status === "cancelled") throw new ImportError("This import was cancelled.");
  if (row.span_from === null || row.span_to === null) throw new ImportError(NOT_EXTENDED_HISTORY);
  const entries = Object.values(row.entries);
  const sum = (k: "records" | "skipped" | "short" | "plays") => entries.reduce((s, e) => s + (e[k] ?? 0), 0);
  const plays = (await db.prepare("SELECT COUNT(*) AS n FROM import_plays").first<{ n: number }>())?.n ?? 0;
  return {
    span: spanOf(row.span_from, row.span_to),
    stats: { records: sum("records"), skipped: sum("skipped"), short: sum("short"), plays },
    options: (row.options as ApprovedOptions | null) ?? null,
  };
}

async function openReview(db: D1Database, importId: string, preview: Preview, now = Date.now()): Promise<Preview> {
  await db
    .prepare("UPDATE imports SET preview = ?2, status = 'review', progress = 'Waiting for your review', updated_at = ?3 WHERE id = ?1 AND status = 'reading'")
    .bind(importId, JSON.stringify(preview), now)
    .run();
  const [ins, upd, del] = preview.totals;
  await quietly("activity", () => logActivity(db, "import", `History ready to review: +${ins} / ~${upd} / -${del}`));
  return preview;
}

async function libraryCounts(db: D1Database): Promise<{ tracks: number; artists: number }> {
  const row = await db.prepare("SELECT (SELECT COUNT(*) FROM tracks) AS tracks, (SELECT COUNT(*) FROM artists) AS artists").first<{ tracks: number; artists: number }>();
  return { tracks: row?.tracks ?? 0, artists: row?.artists ?? 0 };
}

async function recordApproval(db: D1Database, importId: string, options: ImportOptions, now = Date.now()): Promise<ApprovedOptions> {
  const counts = await libraryCounts(db);
  const approved: ApprovedOptions = { ...options, tracksBefore: counts.tracks, artistsBefore: counts.artists };
  // Only the first approval counts: a replayed step reads back what was stored.
  const res = await db
    .prepare("UPDATE imports SET options = ?2, status = 'applying', progress = 'Importing', updated_at = ?3 WHERE id = ?1 AND options IS NULL AND status IN ('review', 'applying')")
    .bind(importId, JSON.stringify(approved), now)
    .run();
  if (res.meta.changes) {
    const what = [options.liked && "Liked Songs", options.frequent && "Frequent Plays"].filter(Boolean).join(" and ");
    await quietly("activity", () => logActivity(db, "import", `History import approved${what ? `, with ${what} backfill` : ""}`));
    return approved;
  }
  const stored = (await getImport(db, importId))?.options as ApprovedOptions | null | undefined;
  if (!stored) throw new ImportError("This import was cancelled.");
  return stored;
}

async function expireImport(db: D1Database, bucket: R2Bucket, importId: string): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM import_plays"),
    db.prepare("UPDATE imports SET status = 'expired', progress = 'The review expired after 7 days', updated_at = ?2 WHERE id = ?1 AND status = 'review'").bind(importId, Date.now()),
  ]);
  await deleteUpload(bucket, importId);
  await quietly("activity", () => logActivity(db, "import", "History import expired: not approved within 7 days", false));
}

export interface LibraryStep {
  skipped: string | null;
  likedAdded: number;
  frequentAdded: number;
  remaining: number;
}

/**
 * One bounded library backfill step (runSyncFull with a limit). Each part runs only if the owner
 * chose it on the Import page and its setting is on (Liked Songs needs both: it can add thousands
 * of songs). Spotify writes need live mode, so other modes skip.
 */
export async function backfillLibrary(env: Env, db: D1Database, sp: SpotifyClient, options: ImportOptions): Promise<LibraryStep> {
  const cfg = loadConfig(env, (await loadSettings(db, env)).values);
  const liked = options.liked && cfg.features.liked;
  const frequent = options.frequent && cfg.features.frequent;
  const off = [options.liked && !liked && "Liked Songs", options.frequent && !frequent && "Frequent Plays"].filter(Boolean).join(" and ");
  const none = { likedAdded: 0, frequentAdded: 0, remaining: 0 };
  if (!liked && !frequent) return { skipped: `${off} ${off.includes(" and ") ? "are" : "is"} off in Settings`, ...none };
  if (cfg.writeMode !== "live") return { skipped: `this instance runs in ${cfg.writeMode} mode`, ...none };
  const r = await runSyncFull(cfg, db, sp, { limit: LIBRARY_STEP_LIMIT, liked, frequent });
  return { skipped: off ? `${off} is off in Settings` : null, likedAdded: r.likedAdded, frequentAdded: r.frequentAdded, remaining: r.remaining };
}

async function finishImport(
  db: D1Database,
  bucket: R2Bucket,
  importId: string,
  options: ApprovedOptions,
  library: { liked: number; frequent: number; skipped: string | null } | null,
  now = Date.now(),
): Promise<DoneSummary> {
  const row = await getImport(db, importId);
  const p = row?.preview;
  if (!row || !p) throw new Error("import row or preview missing at finish");
  const after = await libraryCounts(db);
  const summary: DoneSummary = {
    from: p.from,
    to: p.to,
    added: p.totals[0],
    updated: p.totals[1],
    removed: p.totals[2],
    newTracks: Math.max(0, after.tracks - options.tracksBefore),
    newArtists: Math.max(0, after.artists - options.artistsBefore),
    liked: library && options.liked ? library.liked : null,
    frequent: library && options.frequent ? library.frequent : null,
    librarySkipped: library?.skipped ?? null,
  };
  const line = `History imported (${spanText(p.from, p.to)}): +${summary.added} / ~${summary.updated} / -${summary.removed}`;
  // Only one import is open at a time, so any staging rows left are this one's.
  await db.batch([
    db.prepare("DELETE FROM import_plays"),
    db.prepare("UPDATE imports SET status = 'done', progress = ?2, error = NULL, updated_at = ?3 WHERE id = ?1").bind(importId, line, now),
  ]);
  await deleteUpload(bucket, importId);
  await quietly("activity", () => logActivity(db, "import", line));
  return summary;
}

async function failImport(db: D1Database, importId: string, message: string, now = Date.now()): Promise<void> {
  await db
    .prepare("UPDATE imports SET status = 'failed', error = ?2, progress = NULL, updated_at = ?3 WHERE id = ?1 AND status IN ('reading', 'review', 'applying')")
    .bind(importId, message, now)
    .run();
  await quietly("activity", () => logActivity(db, "import", "History import failed", false, message));
}

/** The error for the owner: a step's NonRetryableError arrives as "NonRetryableError: <message>". */
const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err)).replace(/^(?:ImportError|NonRetryableError): /, "").slice(0, 500);

/** Index, stage, preview, wait for approval, apply month by month, enrich, backfill, finish. */
export class ImportWorkflow extends WorkflowEntrypoint<Env, ImportParams> {
  async run(event: Readonly<WorkflowEvent<ImportParams>>, step: WorkflowStep): Promise<ImportOutcome> {
    const { importId } = event.payload;
    const env = this.env;
    const db = env.DB;
    if (!env.IMPORTS) throw new NonRetryableError("The IMPORTS bucket isn't bound");
    const bucket = env.IMPORTS;
    let client: SpotifyClient | undefined;
    const spotify = () => (client ??= new SpotifyClient(env.SPOTIFY_CLIENT_ID, env.SPOTIFY_CLIENT_SECRET, db, parseWriteMode(env.WRITE_MODE)));

    try {
      // Read: stage each export file, deleting each upload as soon as it's read.
      const entries: StageEntry[] = await step.do("index", READ_STEP, guarded(() => indexImport(db, bucket, importId)));
      for (const e of entries) {
        await step.do(`stage ${e.i + 1} of ${entries.length}`, READ_STEP, guarded(() => stageEntry(db, bucket, importId, e, entries.length)));
      }
      await step.do("delete upload", D1_STEP, () => deleteUpload(bucket, importId));
      const staged = await step.do("staged", D1_STEP, guarded(() => stagedState(db, importId)));

      // Review: preview in SQL, then wait for the owner (skipped by a retry after approval).
      let options = staged.options;
      if (!options) {
        const years: YearPreview[] = [];
        for (const y of yearSlices(staged.span)) years.push(await step.do(`preview ${y.year}`, D1_STEP, () => previewSlice(db, y)));
        const preview = await step.do("review", D1_STEP, () => openReview(db, importId, buildPreview(staged.span, staged.stats, years)));
        await step.do("email review", ONCE, () => sendImportEmail(env, db, reviewEmail(preview, env.PUBLIC_URL)));
        let approval: ImportOptions;
        try {
          approval = normalizeOptions((await step.waitForEvent<ImportOptions>("owner approval", { type: APPROVE_EVENT, timeout: APPROVAL_TIMEOUT })).payload);
        } catch {
          // waitForEvent only rejects when the timeout passes.
          await step.do("expire", D1_STEP, () => expireImport(db, bucket, importId));
          return { status: "expired" };
        }
        options = await step.do("approved", D1_STEP, guarded(() => recordApproval(db, importId, approval)));
      }

      const approved: ApprovedOptions = options;

      // Apply: one UTC month per step, each an atomic batch guarded by applied_to.
      const months = monthSlices(staged.span);
      for (const [k, m] of months.entries()) {
        await step.do(`apply ${m.label}`, D1_STEP, () => applySlice(db, importId, m, `Imported ${m.label} (month ${k + 1} of ${months.length})`));
      }

      // Enrich: credits for new tracks, then metadata for new artists.
      for (const [kind, enrich] of [["tracks", enrichTracks], ["artists", enrichArtists]] as const) {
        let cursor = "";
        for (let i = 1; ; i++) {
          const r = await step.do(`enrich ${kind} ${i}`, SPOTIFY_STEP, async () => {
            await setProgress(db, importId, `Looking up ${kind} on Spotify (batch ${i})`).run();
            return enrich(db, spotify(), cursor);
          });
          if (r.done) break;
          cursor = r.cursor;
        }
      }

      // Library: the backfill the owner chose, in bounded steps.
      let library: { liked: number; frequent: number; skipped: string | null } | null = null;
      if (approved.liked || approved.frequent) {
        library = { liked: 0, frequent: 0, skipped: null };
        let previous = Infinity;
        for (let i = 1; i <= MAX_LIBRARY_STEPS; i++) {
          const r = await step.do(`library ${i}`, SPOTIFY_STEP, async () => {
            await setProgress(db, importId, `Adding tracks to your library (batch ${i})`).run();
            return backfillLibrary(env, db, spotify(), approved);
          });
          library.liked += r.likedAdded;
          library.frequent += r.frequentAdded;
          library.skipped = r.skipped;
          // Done (or skipped: remaining is 0 then), or no progress (e.g. the frequent playlist is full).
          if (r.remaining === 0 || r.remaining >= previous) break;
          previous = r.remaining;
        }
      }

      const summary = await step.do("finish", D1_STEP, () => finishImport(db, bucket, importId, approved, library));
      await step.do("email done", ONCE, () => sendImportEmail(env, db, doneEmail(summary, env.PUBLIC_URL)));
      return { status: "done" };
    } catch (err) {
      const message = errorMessage(err);
      await step.do("record failure", D1_STEP, () => failImport(db, importId, message));
      await step.do("email failure", ONCE, () => sendImportEmail(env, db, failedEmail(message, env.PUBLIC_URL)));
      throw err;
    }
  }
}
