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

/**
 * Throws away an import before it was applied (or after it failed): stops its Workflow, aborts
 * unfinished uploads, deletes its R2 objects and the staging rows. Months already applied stay.
 */
export async function discardImport(c: Pick<Ctx, "db" | "bucket" | "workflow">, row: ImportRow, why: string): Promise<void> {
  if (row.status !== "uploading") {
    try {
      await (await c.workflow.get(instanceId(row.id, row.attempt))).terminate();
    } catch {
      // Not created, or already finished/errored: nothing to stop.
    }
  }
  await setStatus(c.db, row.id, "cancelled", why);
  for (const f of row.files.filter((f) => !f.done)) {
    await c.bucket.resumeMultipartUpload(f.key, f.uploadId).abort().catch(() => {});
  }
  await deleteUpload(c.bucket, row.id);
  // Only one import is open at a time, so all staging rows are this one's.
  await c.db.prepare("DELETE FROM import_plays").run();
  await quietly("activity", () => logActivity(c.db, "import", `History import cancelled: ${why}`));
}

/** POST /import/new: a fresh import in `uploading`. An unfinished upload is replaced; anything further along blocks. */
async function createImport(c: Ctx): Promise<Response> {
  for (const open of await openImports(c.db)) {
    if (open.status !== "uploading") return fail(409, "Another import is in progress. Open the Import page to continue or cancel it.");
    const row = await getImport(c.db, open.id);
    if (row) await discardImport(c, row, "replaced by a new upload");
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
  try {
    await c.workflow.create({ id: instanceId(id, row.attempt), params: { importId: id, attempt: row.attempt } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await setStatus(c.db, id, "failed", null, { error: `Couldn't start the import: ${message}`.slice(0, 500) });
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

/** POST /import/:id/cancel: before approval (or after a failure) only. */
async function cancel(c: Ctx, id: string): Promise<Response> {
  const row = await getImport(c.db, id);
  if (!row || !CANCELLABLE.includes(row.status)) return redirect303("/import?err=moved");
  await discardImport(c, row, row.status === "failed" ? "discarded after it stopped" : "cancelled by you");
  return redirect303("/import?ok=cancelled");
}

/** POST /import/:id/retry: a failed import runs again as a new Workflow instance and resumes. */
async function retry(c: Ctx, id: string): Promise<Response> {
  const row = await getImport(c.db, id);
  if (!row || row.status !== "failed") return redirect303("/import?err=moved");
  const attempt = row.attempt + 1;
  const status = row.options ? "applying" : "reading";
  const res = await c.db
    .prepare("UPDATE imports SET attempt = ?2, status = ?3, error = NULL, progress = 'Retrying', updated_at = ?4 WHERE id = ?1 AND status = 'failed'")
    .bind(id, attempt, status, Date.now())
    .run();
  if (!res.meta.changes) return redirect303("/import?err=moved");
  try {
    await c.workflow.create({ id: instanceId(id, attempt), params: { importId: id, attempt } });
  } catch (err) {
    await setStatus(c.db, id, "failed", null, { error: `Couldn't restart the import: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500) });
    return redirect303("/import?err=retry");
  }
  await quietly("activity", () => logActivity(c.db, "import", `History import retried (attempt ${attempt + 1})`));
  return redirect303("/import?ok=retrying");
}
