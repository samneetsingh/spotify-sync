// /import routes (src/import/routes.ts, page.ts): auth, the upload protocol and its limits, one
// import at a time, approve validation (Liked Songs needs its confirmation), cancel cleanup.
import { env } from "cloudflare:workers";
import { introspectWorkflowInstance } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Session } from "../../src/auth";
import { migrate } from "../../src/db/schema";
import { esc } from "../../src/email/layout";
import type { Env } from "../../src/env";
import { handleImportRoutes } from "../../src/import";
import { LIMITS, PART_SIZE } from "../../src/import/limits";
import { getImport, type Preview } from "../../src/import/store";
import { LIKED_SONGS_WARNING } from "../../src/settings";
import { resetDb } from "../parity/spotify-fixture";
import { bucketKeys, clearBucket, count, insertImport } from "./helpers";

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

describe("review and approve", () => {
  async function inReview(preview: Preview = PREVIEW) {
    const id = await insertImport(db, { status: "review", preview });
    await env.IMPORTS.put(`imports/${id}/1.zip`, "leftover");
    await db.prepare("INSERT INTO import_plays (played_at_ms, track_id, track_uri) VALUES (1, 'a', 'spotify:track:a')").run();
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

  it("can't cancel once applying", async () => {
    const id = await insertImport(db, { status: "applying", preview: PREVIEW });
    const res = await call(`/import/${id}/cancel`, { method: "POST" });
    expect(res.headers.get("Location")).toBe("/import?err=moved");
    expect((await getImport(db, id))?.status).toBe("applying");
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
