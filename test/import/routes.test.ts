// /import routes (src/import/routes.ts, page.ts): auth, the upload protocol and its limits, one
// import at a time, approve validation (Liked Songs needs its confirmation), cancel cleanup.
import { env } from "cloudflare:workers";
import { introspectWorkflowInstance } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Session } from "../../src/auth";
import { migrate } from "../../src/db/schema";
import { esc } from "../../src/email/layout";
import type { Env } from "../../src/env";
import { handleImportRoutes, importSection } from "../../src/import";
import { LIMITS, PART_SIZE } from "../../src/import/limits";
import { getImport, type Preview } from "../../src/import/store";
import { LIKED_SONGS_WARNING } from "../../src/settings";
import { resetDb } from "../parity/spotify-fixture";
import { bucketKeys, clearBucket, count, insertImport } from "./helpers";
import type { ImportParams } from "../../src/env";

const ORIGIN = "https://sync.test";
const testEnv = (overrides: Partial<Env> = {}): Env => ({ ...(env as unknown as Env), PUBLIC_URL: ORIGIN, WRITE_MODE: "dry_run", ...overrides });
const session: Session = { spotifyId: "test-user", displayName: "Test", expiresAt: Date.now() + 86_400_000 };
const ctx = {} as ExecutionContext;
const db = env.DB;
const MiB = 1024 * 1024;

const req = (path: string, init: RequestInit & { json?: unknown } = {}) => {
  const headers = new Headers(init.headers);
  headers.set("Origin", ORIGIN);
  let body = init.body;
  if (init.json !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(init.json);
  }
  return new Request(`${ORIGIN}${path}`, { ...init, headers, body });
};
const call = async (path: string, init: RequestInit & { json?: unknown } = {}, s: Session | null = session, e = testEnv()) => (await handleImportRoutes(req(path, init), e, ctx, s))!;
const callJson = async (path: string, init: RequestInit & { json?: unknown } = {}) => {
  const res = await call(path, { method: "POST", ...init });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};
const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

const PREVIEW: Preview = {
  from: Date.UTC(2016, 2, 5),
  to: Date.UTC(2020, 0, 2),
  records: 1200,
  skipped: 30,
  short: 170,
  plays: 1000,
  months: { "2016-03": [400, 0, 2], "2019-12": [550, 10, 40] },
  totals: [950, 10, 42],
  warnings: {},
};

beforeAll(() => migrate(db));
beforeEach(async () => {
  await resetDb(db);
  await clearBucket(env.IMPORTS);
});

describe("access", () => {
  it("ignores other paths", async () => {
    expect(await handleImportRoutes(req("/settings"), testEnv(), ctx, session)).toBeNull();
    expect(await handleImportRoutes(req("/imports"), testEnv(), ctx, session)).toBeNull();
  });

  it("shows the import page under Settings (there's no Import nav item)", async () => {
    const page = await (await call("/import")).text();
    expect(page).toMatch(/<a href="\/settings" aria-current="page">(?:(?!<\/a>)[\s\S])*Settings<\/a>/);
    expect(page).not.toContain(`<a href="/import"`);
  });

  it("sends anonymous visitors to the login and refuses their POSTs", async () => {
    const get = await call("/import", {}, null);
    expect(get.status).toBe(303);
    expect(get.headers.get("Location")).toBe("/login?next=%2Fimport");
    expect((await call("/import/new", { method: "POST" }, null)).status).toBe(401);
    expect((await call(`/import/${crypto.randomUUID()}/file/1/part/1?u=x`, { method: "PUT", body: "x" }, null)).status).toBe(401);
  });

  it("is a 404 without the bucket or the Workflow", async () => {
    const e = testEnv({ IMPORTS: undefined });
    expect((await call("/import", {}, session, e)).status).toBe(404);
    expect((await call("/import/new", { method: "POST" }, session, e)).status).toBe(404);
  });
});

describe("upload", () => {
  it("uploads in fixed-size parts, checks every part and the final size", async () => {
    const created = await callJson("/import/new");
    expect(created.status).toBe(200);
    const id = created.body.id as string;
    expect(created.body.partSize).toBe(PART_SIZE);

    const size = PART_SIZE + 1234;
    const file = await callJson(`/import/${id}/file`, { json: { name: "C:\\Users\\me\\my_spotify_data.zip", size } });
    expect(file.body).toMatchObject({ n: 1, partSize: PART_SIZE, parts: 2 });
    const u = encodeURIComponent(file.body.uploadId);
    const bytes = new Uint8Array(size).fill(7);

    const put = (p: number, chunk: Uint8Array, uploadId = u) => call(`/import/${id}/file/1/part/${p}?u=${uploadId}`, { method: "PUT", body: chunk, headers: { "Content-Length": String(chunk.length) } });
    expect((await put(1, bytes.subarray(0, PART_SIZE - 1))).status).toBe(400); // parts must be exactly PART_SIZE
    expect((await put(1, bytes.subarray(0, PART_SIZE), "wrong")).status).toBe(400);
    expect((await put(3, bytes.subarray(PART_SIZE))).status).toBe(400);
    const parts = [];
    for (const [p, chunk] of [[1, bytes.subarray(0, PART_SIZE)], [2, bytes.subarray(PART_SIZE)]] as const) {
      const res = await put(p, chunk);
      expect(res.status).toBe(200);
      parts.push(await res.json());
    }
    expect((await callJson(`/import/${id}/file/1/complete`, { json: { uploadId: file.body.uploadId, parts: parts.slice(0, 1) } })).status).toBe(400);
    expect((await callJson(`/import/${id}/file/1/complete`, { json: { uploadId: file.body.uploadId, parts } })).body).toEqual({ ok: true });

    const row = await getImport(db, id);
    expect(row?.files).toEqual([{ n: 1, name: "my_spotify_data.zip", size, key: `imports/${id}/1.zip`, uploadId: file.body.uploadId, done: true }]);
    expect((await env.IMPORTS.head(`imports/${id}/1.zip`))?.size).toBe(size);
  });

  it("refuses parts over the part size before reading them", async () => {
    const { body } = await callJson("/import/new");
    const res = await call(`/import/${body.id}/file/1/part/1?u=x`, { method: "PUT", body: "x", headers: { "Content-Length": String(PART_SIZE + 1) } });
    expect(res.status).toBe(413);
  });

  it.each([
    ["a text file", { name: "notes.txt", size: 10 }, /only the export's .zip or its .json/],
    ["the account-data history", { name: "StreamingHistory_music_0.json", size: 10 }, /isn't a listening history file/],
    ["the video history", { name: "Streaming_History_Video_2020.json", size: 10 }, /isn't a listening history file/],
    ["an empty file", { name: "export.zip", size: 0 }, /empty/],
    ["a huge zip", { name: "export.zip", size: LIMITS.zipBytes + 1 }, /larger than 300 MB/],
    ["a huge JSON file", { name: "Streaming_History_Audio_2020.json", size: LIMITS.jsonBytes + 1 }, /larger than 32 MB/],
  ])("rejects %s", async (_label, file, message) => {
    const { body } = await callJson("/import/new");
    const res = await callJson(`/import/${body.id}/file`, { json: file });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(message);
    expect((await getImport(db, body.id))?.files).toEqual([]);
  });

  it("caps the total size per import", async () => {
    const { body } = await callJson("/import/new");
    for (const _ of [1, 2]) expect((await callJson(`/import/${body.id}/file`, { json: { name: "export.zip", size: 300 * MiB } })).status).toBe(200);
    const third = await callJson(`/import/${body.id}/file`, { json: { name: "Streaming_History_Audio_1.json", size: 1 } });
    expect(third.body.error).toMatch(/600 MB/);
  });

  it("won't start before every file is uploaded", async () => {
    const { body } = await callJson("/import/new");
    expect((await callJson(`/import/${body.id}/start`)).status).toBe(400); // no files
    await callJson(`/import/${body.id}/file`, { json: { name: "export.zip", size: 10 } });
    expect((await callJson(`/import/${body.id}/start`)).body.error).toMatch(/haven't finished/);
  });

  it("runs one import at a time: a new upload replaces an unfinished one, anything further along blocks", async () => {
    const first = (await callJson("/import/new")).body.id as string;
    const file = await callJson(`/import/${first}/file`, { json: { name: "export.zip", size: 10 } });
    const second = (await callJson("/import/new")).body.id as string;
    expect((await getImport(db, first))?.status).toBe("cancelled");
    // The replaced upload's multipart upload was aborted.
    await expect(env.IMPORTS.resumeMultipartUpload(`imports/${first}/1.zip`, file.body.uploadId).uploadPart(1, new Uint8Array(10))).rejects.toThrow();

    await db.prepare("UPDATE imports SET status = 'review' WHERE id = ?1").bind(second).run();
    const blocked = await callJson("/import/new");
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toMatch(/in progress/);
  });
});

describe("start", () => {
  it("hands over to the Workflow; a bad zip fails with an owner-facing error, and discarding deletes the upload", async () => {
    const { body } = await callJson("/import/new");
    const id = body.id as string;
    const file = await callJson(`/import/${id}/file`, { json: { name: "my_spotify_data.zip", size: 64 } });
    const part = await (await call(`/import/${id}/file/1/part/1?u=${encodeURIComponent(file.body.uploadId)}`, { method: "PUT", body: new Uint8Array(64), headers: { "Content-Length": "64" } })).json();
    await callJson(`/import/${id}/file/1/complete`, { json: { uploadId: file.body.uploadId, parts: [part] } });

    await using instance = await introspectWorkflowInstance(env.IMPORT_WORKFLOW, id);
    await instance.modify(async (m) => {
      await m.disableSleeps();
      await m.disableRetryDelays();
    });
    expect((await callJson(`/import/${id}/start`)).body).toEqual({ ok: true });
    await instance.waitForStatus("errored");

    const failed = await getImport(db, id);
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toMatch(/That zip can't be read/);
    expect(await bucketKeys(env.IMPORTS, id)).toEqual([`imports/${id}/1.zip`]); // kept for a retry

    const page = await call("/import");
    expect(await page.text()).toContain("The import stopped");

    const discard = await call(`/import/${id}/cancel`, { method: "POST" });
    expect(discard.headers.get("Location")).toBe("/import?ok=cancelled");
    expect((await getImport(db, id))?.status).toBe("cancelled");
    expect(await bucketKeys(env.IMPORTS, id)).toEqual([]);
    const activity = await db.prepare("SELECT kind, ok, summary FROM activity ORDER BY id").all();
    expect(activity.results).toEqual([
      { kind: "import", ok: 1, summary: "History import started (1 file, 0 MB)" },
      { kind: "import", ok: 0, summary: "History import failed" },
      expect.objectContaining({ kind: "email", summary: expect.stringContaining("Your history import stopped") }),
      { kind: "import", ok: 1, summary: "History import cancelled: discarded after it stopped" },
    ]);
  });
});

describe("finished import", () => {
  it("shows the last import with the time in the owner's time zone, on the page and the home card", async () => {
    const finished = Date.UTC(2026, 9, 11, 22, 15);
    await insertImport(db, { status: "done", preview: PREVIEW, createdAt: finished });
    await db.prepare("INSERT INTO settings (key, value) VALUES ('timeZone', '\"America/Los_Angeles\"')").run();
    const html = await (await call("/import")).text();
    expect(html).toContain("Last import");
    expect(html).toContain("Oct 11, 2026, 3:15 PM PDT");
    expect(await importSection(db, "America/Los_Angeles")).toContain("Oct 11, 2026, 3:15 PM PDT");
    expect(await importSection(db)).toContain("Oct 11, 2026, 10:15 PM UTC");
  });
});

describe("review and approve", () => {
  async function inReview(preview: Preview = PREVIEW) {
    const id = await insertImport(db, { status: "review", preview });
    await env.IMPORTS.put(`imports/${id}/1.zip`, "leftover");
    await db.prepare("INSERT INTO import_plays (import_id, played_at_ms, track_id, track_uri) VALUES (?1, 1, 'a', 'spotify:track:a')").bind(id).run();
    return id;
  }

  it("shows the diff with Frequent Plays on and Liked Songs off behind its warning", async () => {
    await db.batch([
      db.prepare("INSERT INTO settings (key, value) VALUES ('liked', 'true')"),
      db.prepare("INSERT INTO settings (key, value) VALUES ('frequent', 'true')"),
    ]);
    const id = await inReview();
    const res = await call("/import");
    const html = await res.text();
    expect(res.headers.get("Content-Security-Policy")).toMatch(/script-src 'self'/);
    expect(html).not.toMatch(/\sstyle=/);
    expect(html).toContain("Plays to add");
    expect(html).toContain("950");
    expect(html).toContain(`action="/import/${id}/approve"`);
    expect(html).toMatch(/<input class="toggle" type="checkbox" id="f-frequent" name="frequent" checked/);
    expect(html).toMatch(/<input class="toggle" type="checkbox" id="f-liked" name="liked" aria-describedby/); // unchecked
    expect(html).toContain(esc(LIKED_SONGS_WARNING));
    expect(html).toContain('name="liked_confirm"');
  });

  it("explains instead of offering a backfill whose setting is off", async () => {
    await db.prepare("INSERT INTO settings (key, value) VALUES ('liked', 'false')").run();
    await inReview();
    const html = await (await call("/import")).text();
    expect(html).not.toContain('name="liked"');
    expect(html).toContain("Adding songs to Liked Songs is off");
  });

  it("refuses Liked Songs without its confirmation, and warnings without 'I understand'", async () => {
    await db.prepare("INSERT INTO settings (key, value) VALUES ('liked', 'true')").run();
    const id = await inReview({ ...PREVIEW, warnings: { accountMismatch: { synced: 40, matched: 2 } } });
    const res = await call(`/import/${id}/approve`, { method: "POST", body: form({ frequent: "on", liked: "on" }) });
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("tick &quot;I understand&quot; under it");
    expect(html).toContain("Read the warning above");
    expect(html).toContain("Is this your export?");
    // The choices survive the round trip; nothing was sent or changed.
    expect(html).toMatch(/id="f-liked" name="liked" checked/);
    expect((await getImport(db, id))?.status).toBe("review");
  });

  it("cancels before approval: Workflow stopped, upload and staging deleted", async () => {
    const id = await inReview();
    const res = await call(`/import/${id}/cancel`, { method: "POST" });
    expect(res.headers.get("Location")).toBe("/import?ok=cancelled");
    expect((await getImport(db, id))?.status).toBe("cancelled");
    expect(await bucketKeys(env.IMPORTS, id)).toEqual([]);
    expect(await count(db, "SELECT COUNT(*) AS n FROM import_plays")).toBe(0);
    expect(await (await call("/import?ok=cancelled")).text()).toContain("Import cancelled");
  });

  it("can't cancel once applying while its Workflow runs", async () => {
    const id = await insertImport(db, { status: "applying", preview: PREVIEW });
    const wf = fakeWorkflow({ [id]: { status: "running" } });
    const res = await call(`/import/${id}/cancel`, { method: "POST" }, session, testEnv({ IMPORT_WORKFLOW: wf.binding }));
    expect(res.headers.get("Location")).toBe("/import?err=moved");
    expect((await getImport(db, id))?.status).toBe("applying");
    expect(wf.terminated).toEqual([]);
  });

  it("escapes what came from the export or an error", async () => {
    const id = await insertImport(db, { status: "failed" });
    await db.prepare("UPDATE imports SET error = '<script>alert(1)</script>' WHERE id = ?1").bind(id).run();
    const html = await (await call("/import")).text();
    expect(html).not.toContain("<script>alert(1)");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("serves the uploader only on the upload page", async () => {
    const html = await (await call("/import")).text();
    expect(html).toContain('<script type="module" src="/import.js"></script>');
    expect(html).toContain(`data-part-size="${PART_SIZE}"`);
  });
});

/**
 * A Workflow binding whose instances are plain records: `status` is what status() reports; terminate
 * stops one unless `stuck` (it then throws and keeps running); create can fail before or after
 * creating the instance.
 */
function fakeWorkflow(instances: Record<string, { status: string; stuck?: boolean }>, opts: { createFails?: "before" | "after" } = {}) {
  const terminated: string[] = [];
  const created: Array<{ id: string; params: ImportParams }> = [];
  const handle = (id: string) => ({
    id,
    status: async () => ({ status: instances[id]!.status }),
    terminate: async () => {
      terminated.push(id);
      if (instances[id]!.stuck) throw new Error("internal error");
      instances[id]!.status = "terminated";
    },
    sendEvent: async () => {},
  });
  const binding = {
    get: async (id: string) => {
      if (!instances[id]) throw new Error("instance.not_found");
      return handle(id);
    },
    create: async ({ id, params }: { id: string; params: ImportParams }) => {
      if (opts.createFails === "before") throw new Error("network error");
      instances[id] = { status: "running" };
      created.push({ id, params });
      if (opts.createFails === "after") throw new Error("timed out");
      return handle(id);
    },
  } as unknown as Workflow<ImportParams>;
  return { binding, instances, terminated, created };
}

describe("Workflow instance safety", () => {
  const stage = (id: string, track: string) =>
    db.prepare("INSERT INTO import_plays (import_id, played_at_ms, track_id, track_uri) VALUES (?1, 1, ?2, 'spotify:track:' || ?2)").bind(id, track).run();
  const staged = (id: string) => count(db, `SELECT COUNT(*) AS n FROM import_plays WHERE import_id = '${id}'`);

  it("refuses to cancel while the instance can't be stopped, and changes nothing", async () => {
    const id = await insertImport(db, { status: "review", preview: PREVIEW });
    await stage(id, "a");
    const wf = fakeWorkflow({ [id]: { status: "waiting", stuck: true } });
    const res = await call(`/import/${id}/cancel`, { method: "POST" }, session, testEnv({ IMPORT_WORKFLOW: wf.binding }));
    expect(res.headers.get("Location")).toBe("/import?err=running");
    expect(wf.terminated).toEqual([id]);
    expect((await getImport(db, id))?.status).toBe("review");
    expect(await staged(id)).toBe(1);
    expect(await (await call("/import?err=running")).text()).toContain("still running");
  });

  it("cancels once the instance is confirmed stopped, deleting only this import's staging rows", async () => {
    const id = await insertImport(db, { status: "review", preview: PREVIEW });
    await stage(id, "a");
    await stage("another-import", "b");
    const wf = fakeWorkflow({ [id]: { status: "waiting" } });
    const res = await call(`/import/${id}/cancel`, { method: "POST" }, session, testEnv({ IMPORT_WORKFLOW: wf.binding }));
    expect(res.headers.get("Location")).toBe("/import?ok=cancelled");
    expect(wf.instances[id]!.status).toBe("terminated");
    expect(await staged(id)).toBe(0);
    expect(await staged("another-import")).toBe(1);
  });

  it("lets a stuck applying import (instance stopped) be cancelled or retried", async () => {
    for (const status of ["errored", "terminated", "complete"]) {
      await resetDb(db);
      const id = await insertImport(db, { status: "applying", preview: PREVIEW, options: { liked: false, frequent: true } });
      await stage(id, "a");
      const wf = fakeWorkflow({ [id]: { status } });
      const e = testEnv({ IMPORT_WORKFLOW: wf.binding });
      expect((await call(`/import/${id}/retry`, { method: "POST" }, session, e)).headers.get("Location")).toBe("/import?ok=retrying");
      expect(await getImport(db, id)).toMatchObject({ status: "applying", attempt: 1 });
      expect(wf.created).toEqual([{ id: `${id}-r1`, params: { importId: id, attempt: 1 } }]);

      // The retry's instance stops too: now discard it. Months already applied would stay.
      wf.instances[`${id}-r1`]!.status = "errored";
      expect((await call(`/import/${id}/cancel`, { method: "POST" }, session, e)).headers.get("Location")).toBe("/import?ok=cancelled");
      expect((await getImport(db, id))?.status).toBe("cancelled");
      expect(await staged(id)).toBe(0);
    }
  });

  it("shows Retry and Cancel on an applying import that hasn't moved for a while, and stops refreshing", async () => {
    const id = await insertImport(db, { status: "applying", preview: PREVIEW, createdAt: Date.now() - 2 * 3_600_000 });
    const res = await call("/import");
    const html = await res.text();
    expect(html).toContain(`action="/import/${id}/retry"`);
    expect(html).toContain(`action="/import/${id}/cancel"`);
    expect(html).not.toContain('http-equiv="refresh"');
    await db.prepare("UPDATE imports SET updated_at = ?2 WHERE id = ?1").bind(id, Date.now()).run();
    const fresh = await (await call("/import")).text();
    expect(fresh).not.toContain(`action="/import/${id}/retry"`);
    expect(fresh).toContain('http-equiv="refresh"');
  });

  it("refuses a retry while the previous attempt's instance still runs", async () => {
    const id = await insertImport(db, { status: "failed" });
    const wf = fakeWorkflow({ [id]: { status: "running", stuck: true } });
    const res = await call(`/import/${id}/retry`, { method: "POST" }, session, testEnv({ IMPORT_WORKFLOW: wf.binding }));
    expect(res.headers.get("Location")).toBe("/import?err=running");
    expect(await getImport(db, id)).toMatchObject({ status: "failed", attempt: 0 });
    expect(wf.created).toEqual([]);
  });

  async function readyToStart() {
    const { body } = await callJson("/import/new");
    const id = body.id as string;
    const file = await callJson(`/import/${id}/file`, { json: { name: "my_spotify_data.zip", size: 64 } });
    const part = await (await call(`/import/${id}/file/1/part/1?u=${encodeURIComponent(file.body.uploadId)}`, { method: "PUT", body: new Uint8Array(64), headers: { "Content-Length": "64" } })).json();
    await callJson(`/import/${id}/file/1/complete`, { json: { uploadId: file.body.uploadId, parts: [part] } });
    return id;
  }

  it("start: a create that fails after creating the instance counts as started (no zombie next to a retry)", async () => {
    const id = await readyToStart();
    const wf = fakeWorkflow({}, { createFails: "after" });
    const res = await call(`/import/${id}/start`, { method: "POST" }, session, testEnv({ IMPORT_WORKFLOW: wf.binding }));
    expect(await res.json()).toEqual({ ok: true });
    expect(await getImport(db, id)).toMatchObject({ status: "reading", attempt: 0 });
    expect(wf.created.map((c) => c.id)).toEqual([id]);
  });

  it("start: a create that fails before creating anything marks the import failed", async () => {
    const id = await readyToStart();
    const wf = fakeWorkflow({}, { createFails: "before" });
    const res = await call(`/import/${id}/start`, { method: "POST" }, session, testEnv({ IMPORT_WORKFLOW: wf.binding }));
    expect(res.status).toBe(500);
    expect(await getImport(db, id)).toMatchObject({ status: "failed", error: "Couldn't start the import: network error" });
    // Nothing runs for it, so a retry is safe.
    expect((await call(`/import/${id}/retry`, { method: "POST" }, session, testEnv({ IMPORT_WORKFLOW: fakeWorkflow({}).binding }))).headers.get("Location")).toBe("/import?ok=retrying");
  });
});
