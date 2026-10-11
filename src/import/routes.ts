// /import routes. Owner only; the router has already checked
// Origin on every POST/PUT. The JSON endpoints serve public/import.js (multipart upload to R2 in
// fixed-size parts); approve, cancel and retry are plain forms that redirect back to /import.

import { logActivity } from "../activity";
import type { Session } from "../auth";
import type { Env, ImportParams } from "../env";
import { authRequired, notFoundPage, redirect303, statusPage } from "../http";
import { quietly } from "../runtime";
import { LIMITS, MiB, PART_SIZE, checkFile } from "./limits";
import { importPage, type ApproveForm } from "./page";
import { deleteUpload } from "./stage";
import { CANCELLABLE, OPEN_STATUSES, getImport, instanceId, setStatus, type ImportFile, type ImportRow } from "./store";
import { APPROVE_EVENT } from "./workflow";

const MAX_JSON_BODY = 64 * 1024;

const ID = "([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})";
const ROUTES = {
  action: new RegExp(`^/import/${ID}/(file|start|approve|cancel|retry)$`),
  part: new RegExp(`^/import/${ID}/file/(\\d{1,2})/part/(\\d{1,4})$`),
  complete: new RegExp(`^/import/${ID}/file/(\\d{1,2})/complete$`),
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
const fail = (status: number, error: string) => json({ error }, status);

const partsOf = (size: number) => Math.max(1, Math.ceil(size / PART_SIZE));
const partLength = (size: number, p: number) => (p < partsOf(size) ? PART_SIZE : size - (partsOf(size) - 1) * PART_SIZE);

interface Ctx {
  env: Env;
  db: D1Database;
  bucket: R2Bucket;
  workflow: Workflow<ImportParams>;
}

/**
 * GET /import and everything under /import/; null for any other path. Owner only: without a
 * session GETs go to the login and the rest get 401. 404 when imports aren't configured.
 */
export async function handleImportRoutes(request: Request, env: Env, ctx: ExecutionContext, session: Session | null): Promise<Response | null> {
  const url = new URL(request.url);
  const { pathname } = url;
  if (pathname !== "/import" && !pathname.startsWith("/import/")) return null;
  if (!session) return authRequired(request);
  if (!env.IMPORTS || !env.IMPORT_WORKFLOW) {
    return pathname === "/import" && request.method === "GET"
      ? statusPage(404, "Import isn't set up", "This instance has no storage for history imports. The README explains how to add it.")
      : notFoundPage();
  }
  const c: Ctx = { env, db: env.DB, bucket: env.IMPORTS, workflow: env.IMPORT_WORKFLOW };
  const method = request.method;

  if (pathname === "/import") return method === "GET" || method === "HEAD" ? importPage(c.env, c.db, session, { url }) : notFoundPage();
  if (pathname === "/import/new") return method === "POST" ? createImport(c) : notFoundPage();

  let m = pathname.match(ROUTES.part);
  if (m && method === "PUT") return putPart(c, request, m[1]!, Number(m[2]), Number(m[3]), url.searchParams.get("u") ?? "");
  m = pathname.match(ROUTES.complete);
  if (m && method === "POST") return completeFile(c, request, m[1]!, Number(m[2]));
  m = pathname.match(ROUTES.action);
  if (m && method === "POST") {
    const id = m[1]!;
    switch (m[2]) {
      case "file":
        return addFile(c, request, id);
      case "start":
        return start(c, id);
      case "approve":
        return approve(c, request, id, session);
      case "cancel":
        return cancel(c, id);
      case "retry":
        return retry(c, id);
    }
  }
  return notFoundPage();
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  if (Number(request.headers.get("Content-Length") ?? 0) > MAX_JSON_BODY) return null;
  try {
    const text = await request.text();
    if (text.length > MAX_JSON_BODY) return null;
    const body = JSON.parse(text);
    return body && typeof body === "object" && !Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}

async function openImports(db: D1Database): Promise<Array<{ id: string; status: string }>> {
  const { results } = await db
    .prepare("SELECT id, status FROM imports WHERE status IN (SELECT value FROM json_each(?1)) ORDER BY created_at DESC")
    .bind(JSON.stringify(OPEN_STATUSES))
    .all<{ id: string; status: string }>();
  return results;
}

/** Workflow statuses after which an instance never runs another step. */
const FINISHED: readonly string[] = ["complete", "errored", "terminated"];

/**
 * The status of an import attempt's Workflow instance: "none" if it was never created, "finished"
 * if it will never run another step, else "running" (queued, running, waiting, paused...).
 */
export async function instanceState(workflow: Workflow<ImportParams>, id: string): Promise<"none" | "finished" | "running"> {
  let instance: WorkflowInstance;
  try {
    instance = await workflow.get(id);
  } catch (err) {
    if (/not.?found/i.test(err instanceof Error ? err.message : String(err))) return "none";
    throw err;
  }
  return FINISHED.includes((await instance.status()).status) ? "finished" : "running";
}

/**
 * Stops an attempt's instance and confirms it stopped: true when nothing can run for it anymore.
 * False (the caller refuses to go on) while it's still running, so a leftover instance can never
 * keep working on an import the owner thinks is gone.
 */
export async function stopInstance(workflow: Workflow<ImportParams>, id: string): Promise<boolean> {
  if ((await instanceState(workflow, id)) !== "running") return true;
  try {
    await (await workflow.get(id)).terminate();
  } catch (err) {
    console.error(JSON.stringify({ import: "terminate failed", instance: id, error: err instanceof Error ? err.message : String(err) }));
  }
  return (await instanceState(workflow, id)) !== "running";
}

/**
 * Creates an attempt's instance (deterministic id: instanceId). A create can fail after the
 * instance exists (e.g. a timeout); if it's running then, it counts as started. Returns the error,
 * or null when it runs.
 */
async function createInstance(workflow: Workflow<ImportParams>, importId: string, attempt: number): Promise<string | null> {
  const id = instanceId(importId, attempt);
  try {
    await workflow.create({ id, params: { importId, attempt } });
    return null;
  } catch (err) {
    const state = await instanceState(workflow, id).catch(() => "none" as const);
    return state === "running" ? null : err instanceof Error ? err.message : String(err);
  }
}

/**
 * Throws away an import before it was applied (or after it failed or stopped): stops its Workflow,
 * aborts unfinished uploads, deletes its R2 objects and its staging rows. Months already applied
 * stay. Returns false, changing nothing, while its Workflow instance can't be confirmed stopped.
 */
export async function discardImport(c: Pick<Ctx, "db" | "bucket" | "workflow">, row: ImportRow, why: string): Promise<boolean> {
  if (row.status !== "uploading" && !(await stopInstance(c.workflow, instanceId(row.id, row.attempt)))) return false;
  await setStatus(c.db, row.id, "cancelled", why);
  for (const f of row.files.filter((f) => !f.done)) {
    await c.bucket.resumeMultipartUpload(f.key, f.uploadId).abort().catch(() => {});
  }
  await deleteUpload(c.bucket, row.id);
  await c.db.prepare("DELETE FROM import_plays WHERE import_id = ?1").bind(row.id).run();
  await quietly("activity", () => logActivity(c.db, "import", `History import cancelled: ${why}`));
  return true;
}

/** An `applying` import whose Workflow instance stopped (or never ran): cancel and retry may act on it. */
async function stuckApplying(c: Ctx, row: ImportRow): Promise<boolean> {
  return row.status === "applying" && (await instanceState(c.workflow, instanceId(row.id, row.attempt))) !== "running";
}

/** POST /import/new: a fresh import in `uploading`. An unfinished upload is replaced; anything further along blocks. */
async function createImport(c: Ctx): Promise<Response> {
  for (const open of await openImports(c.db)) {
    if (open.status !== "uploading") return fail(409, "Another import is in progress. Open the Import page to continue or cancel it.");
    const row = await getImport(c.db, open.id);
    if (row && !(await discardImport(c, row, "replaced by a new upload"))) return fail(409, "Another import is still stopping. Try again in a minute.");
  }
  const id = crypto.randomUUID();
  const now = Date.now();
  await c.db.prepare("INSERT INTO imports (id, created_at, updated_at, status) VALUES (?1, ?2, ?2, 'uploading')").bind(id, now).run();
  return json({ id, partSize: PART_SIZE, limits: LIMITS });
}

/** POST /import/:id/file {name, size}: starts that file's multipart upload. */
async function addFile(c: Ctx, request: Request, id: string): Promise<Response> {
  const body = await readJson(request);
  const rawName = typeof body?.name === "string" ? body.name : "";
  const name = rawName.split(/[\\/]/).pop()!.slice(0, 200);
  const size = typeof body?.size === "number" ? body.size : NaN;
  if (!name) return fail(400, "Missing file name.");
  const problem = checkFile(name, size);
  if (problem) return fail(400, problem);

  const row = await getImport(c.db, id);
  if (!row || row.status !== "uploading") return fail(409, "This upload has ended. Reload the page and start again.");
  if (row.files.length >= LIMITS.files) return fail(400, `At most ${LIMITS.files} files per import.`);
  if (row.files.reduce((s, f) => s + f.size, 0) + size > LIMITS.totalBytes) return fail(400, `At most ${LIMITS.totalBytes / MiB} MB per import.`);

  const n = row.files.length + 1;
  const ext = name.toLowerCase().endsWith(".zip") ? "zip" : "json";
  const key = `imports/${id}/${n}.${ext}`;
  const upload = await c.bucket.createMultipartUpload(key, { httpMetadata: { contentType: ext === "zip" ? "application/zip" : "application/json" } });
  const file: ImportFile = { n, name, size, key, uploadId: upload.uploadId, done: false };
  const res = await c.db
    .prepare("UPDATE imports SET files = json_insert(files, '$[#]', json(?2)), updated_at = ?3 WHERE id = ?1 AND status = 'uploading' AND json_array_length(files) = ?4")
    .bind(id, JSON.stringify(file), Date.now(), n - 1)
    .run();
  if (!res.meta.changes) {
    await upload.abort().catch(() => {});
    return fail(409, "Files must be added one at a time. Reload the page and start again.");
  }
  return json({ n, uploadId: upload.uploadId, partSize: PART_SIZE, parts: partsOf(size) });
}

async function uploadingFile(c: Ctx, id: string, n: number): Promise<{ row: ImportRow; file: ImportFile } | Response> {
  const row = await getImport(c.db, id);
  if (!row || row.status !== "uploading") return fail(409, "This upload has ended. Reload the page and start again.");
  const file = row.files[n - 1];
  if (!file || file.n !== n) return fail(404, "Unknown file.");
  if (file.done) return fail(409, "That file is already uploaded.");
  return { row, file };
}

/** PUT /import/:id/file/:n/part/:p?u=<uploadId>: one part, exactly PART_SIZE bytes except the last. */
async function putPart(c: Ctx, request: Request, id: string, n: number, p: number, uploadId: string): Promise<Response> {
  const declared = Number(request.headers.get("Content-Length"));
  if (!Number.isInteger(declared) || declared > PART_SIZE) return fail(413, `Parts are at most ${PART_SIZE / MiB} MB.`);
  const found = await uploadingFile(c, id, n);
  if (found instanceof Response) return found;
  const { file } = found;
  if (uploadId !== file.uploadId) return fail(400, "Unknown upload.");
  if (p < 1 || p > partsOf(file.size)) return fail(400, "Unknown part.");
  const expected = partLength(file.size, p);
  if (declared !== expected) return fail(400, `Part ${p} must be ${expected} bytes.`);
  const data = await request.arrayBuffer();
  if (data.byteLength !== expected) return fail(400, `Part ${p} must be ${expected} bytes.`);
  const part = await c.bucket.resumeMultipartUpload(file.key, uploadId).uploadPart(p, data);
  return json({ partNumber: part.partNumber, etag: part.etag });
}

/** POST /import/:id/file/:n/complete {uploadId, parts}: finishes the upload and checks its size. */
async function completeFile(c: Ctx, request: Request, id: string, n: number): Promise<Response> {
  const body = await readJson(request);
  const found = await uploadingFile(c, id, n);
  if (found instanceof Response) return found;
  const { file } = found;
  if (body?.uploadId !== file.uploadId) return fail(400, "Unknown upload.");
  const raw = Array.isArray(body.parts) ? body.parts : [];
  const parts = raw
    .map((p: { partNumber?: unknown; etag?: unknown }) => ({ partNumber: Number(p?.partNumber), etag: typeof p?.etag === "string" ? p.etag : "" }))
    .sort((a, b) => a.partNumber - b.partNumber);
  if (parts.length !== partsOf(file.size) || parts.some((p, i) => p.partNumber !== i + 1 || !p.etag)) return fail(400, "Some parts are missing; try again.");

  await c.bucket.resumeMultipartUpload(file.key, file.uploadId).complete(parts);
  const head = await c.bucket.head(file.key);
  if (!head || head.size !== file.size) {
    await c.bucket.delete(file.key);
    return fail(400, `${file.name} didn't arrive complete; try again.`);
  }
  await c.db
    .prepare("UPDATE imports SET files = json_set(files, ?2, json('true')), updated_at = ?3 WHERE id = ?1 AND status = 'uploading'")
    .bind(id, `$[${n - 1}].done`, Date.now())
    .run();
  return json({ ok: true });
}

/** POST /import/:id/start: every file is uploaded; the Workflow takes over. */
async function start(c: Ctx, id: string): Promise<Response> {
  const row = await getImport(c.db, id);
  if (!row || row.status !== "uploading") return fail(409, "This upload has ended. Reload the page.");
  if (!row.files.length || row.files.some((f) => !f.done)) return fail(400, "Some files haven't finished uploading.");
  if ((await openImports(c.db)).some((o) => o.id !== id)) return fail(409, "Another import is in progress.");
  if (!(await setStatus(c.db, id, "reading", "Starting", { onlyFrom: ["uploading"] }))) return fail(409, "This upload has ended. Reload the page.");
  const error = await createInstance(c.workflow, id, row.attempt);
  if (error) {
    await setStatus(c.db, id, "failed", null, { error: `Couldn't start the import: ${error}`.slice(0, 500) });
    return fail(500, "Couldn't start the import. Open the Import page to retry.");
  }
  const mb = Math.round(row.files.reduce((s, f) => s + f.size, 0) / MiB);
  await quietly("activity", () => logActivity(c.db, "import", `History import started (${row.files.length} file${row.files.length === 1 ? "" : "s"}, ${mb} MB)`));
  return json({ ok: true });
}

/** The approve form's fields (checkbox values are "on"). */
export function readApproveForm(form: FormData): ApproveForm {
  const on = (k: string) => form.get(k) === "on";
  return { frequent: on("frequent"), liked: on("liked"), likedConfirm: on("liked_confirm"), understand: on("understand") };
}

/** Problems with the approval, in owner-facing words; empty when it can go ahead. */
export function approveErrors(row: ImportRow, f: ApproveForm): string[] {
  const errors: string[] = [];
  if (f.liked && !f.likedConfirm) errors.push("To add your history to Liked Songs, tick \"I understand\" under it (or untick Liked Songs).");
  const w = row.preview?.warnings ?? {};
  if ((w.accountMismatch || w.historyLoss) && !f.understand) errors.push("Read the warning above and tick \"I understand\" to import anyway.");
  return errors;
}

/** POST /import/:id/approve: sends the owner's choices to the waiting Workflow. */
async function approve(c: Ctx, request: Request, id: string, session: Session): Promise<Response> {
  const row = await getImport(c.db, id);
  if (!row || row.status !== "review") return redirect303("/import?err=moved");
  const form = readApproveForm(await request.formData());
  const errors = approveErrors(row, form);
  if (errors.length) return importPage(c.env, c.db, session, { form, errors, status: 400 });
  const options = { liked: form.liked && form.likedConfirm, frequent: form.frequent };
  await (await c.workflow.get(instanceId(id, row.attempt))).sendEvent({ type: APPROVE_EVENT, payload: options });
  await setStatus(c.db, id, "applying", "Starting the import", { onlyFrom: ["review"] });
  return redirect303("/import?ok=approved");
}

/**
 * POST /import/:id/cancel: before approval, after a failure, or when an `applying` import's
 * Workflow stopped without finishing (months already applied stay). Refused while its Workflow
 * can't be confirmed stopped.
 */
async function cancel(c: Ctx, id: string): Promise<Response> {
  const row = await getImport(c.db, id);
  if (!row || !(CANCELLABLE.includes(row.status) || (await stuckApplying(c, row)))) return redirect303("/import?err=moved");
  const why = row.status === "failed" || row.status === "applying" ? "discarded after it stopped" : "cancelled by you";
  if (!(await discardImport(c, row, why))) return redirect303("/import?err=running");
  return redirect303("/import?ok=cancelled");
}

/**
 * POST /import/:id/retry: a failed import (or an `applying` one whose Workflow stopped) runs again
 * as a new Workflow instance and resumes. The previous attempt's instance must be stopped first.
 */
async function retry(c: Ctx, id: string): Promise<Response> {
  const row = await getImport(c.db, id);
  if (!row || !(row.status === "failed" || (await stuckApplying(c, row)))) return redirect303("/import?err=moved");
  if (!(await stopInstance(c.workflow, instanceId(id, row.attempt)))) return redirect303("/import?err=running");
  const attempt = row.attempt + 1;
  const status = row.options ? "applying" : "reading";
  const res = await c.db
    .prepare("UPDATE imports SET attempt = ?2, status = ?3, error = NULL, progress = 'Retrying', updated_at = ?4 WHERE id = ?1 AND attempt = ?5 AND status = ?6")
    .bind(id, attempt, status, Date.now(), row.attempt, row.status)
    .run();
  if (!res.meta.changes) return redirect303("/import?err=moved");
  const error = await createInstance(c.workflow, id, attempt);
  if (error) {
    await setStatus(c.db, id, "failed", null, { error: `Couldn't restart the import: ${error}`.slice(0, 500) });
    return redirect303("/import?err=retry");
  }
  await quietly("activity", () => logActivity(c.db, "import", `History import retried (attempt ${attempt + 1})`));
  return redirect303("/import?ok=retrying");
}
