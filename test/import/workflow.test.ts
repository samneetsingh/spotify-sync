// ImportWorkflow end to end on local D1 + R2 (introspectWorkflowInstance): staging deletes the upload
// before the review, approval through the route's real event or mockEvent, expiry, failure and a
// resuming retry, and the Liked Songs backfill only when explicitly confirmed.
import { env } from "cloudflare:workers";
import { introspectWorkflowInstance } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Session } from "../../src/auth";
import { migrate } from "../../src/db/schema";
import type { Env } from "../../src/env";
import { handleImportRoutes } from "../../src/import";
import { getImport } from "../../src/import/store";
import { normalizeOptions } from "../../src/import/workflow";
import { resetDb } from "../parity/spotify-fixture";
import { allPlays, audioRecord, bucketKeys, buildZip, clearBucket, count, enc, episodeRecord, exportJson, insertImport, mockSpotifyApi, putUpload, type SpotifyMock } from "./helpers";

const db = env.DB;
const bucket = env.IMPORTS;
const ORIGIN = "https://sync.test";
const session: Session = { spotifyId: "test-user", displayName: "Test", expiresAt: Date.now() + 86_400_000 };
const routeEnv = (): Env => ({ ...(env as unknown as Env), PUBLIC_URL: ORIGIN });

let mock: SpotifyMock | undefined;
beforeAll(() => migrate(db));
beforeEach(async () => {
  await resetDb(db);
  await clearBucket(bucket);
  mock = mockSpotifyApi();
});
afterEach(() => mock?.restore());

const day = (m: number, d: number, h = 12) => Date.UTC(2020, m, d, h);

/**
 * An export spanning Dec 2019 to Feb 2020: a zip with two audio files (plus video history and a
 * PDF), and one loose JSON file. The database already has an API play inside the span (replaced by
 * its export twin) and one after it (untouched).
 */
async function uploaded(): Promise<string> {
  const id = crypto.randomUUID();
  const zip = await buildZip([
    { name: "Spotify Extended Streaming History/Streaming_History_Audio_2019-2020_0.json", data: exportJson([audioRecord({ ms: Date.UTC(2019, 11, 30, 20), track: "t1" }), audioRecord({ ms: day(0, 5), track: "t2" }), episodeRecord(day(0, 6))]) },
    { name: "Spotify Extended Streaming History/Streaming_History_Audio_2020_1.json", data: exportJson([audioRecord({ ms: day(0, 20), track: "t1", msPlayed: 12_000 }), audioRecord({ ms: day(1, 2), track: "t3" })]), descriptor: true },
    { name: "Spotify Extended Streaming History/Streaming_History_Video_2020.json", data: "[]" },
    { name: "Spotify Extended Streaming History/ReadMeFirst_ExtendedStreamingHistory.pdf", data: "%PDF-1.4", method: 0 },
  ]);
  const files = [
    await putUpload(bucket, id, 1, "my_spotify_data.zip", zip),
    await putUpload(bucket, id, 2, "Streaming_History_Audio_2020_2.json", enc(exportJson([audioRecord({ ms: day(1, 20), track: "t2" })]))),
  ];
  await insertImport(db, { id, status: "reading", files });
  await db.batch([
    db.prepare("INSERT INTO tracks (track_id, track_uri, name) VALUES ('t2', 'spotify:track:t2', 'Known')"),
    db.prepare("INSERT INTO tracks (track_id, track_uri, name) VALUES ('t9', 'spotify:track:t9', 'Later')"),
    db.prepare("INSERT INTO plays (played_at_ms, track_id, track_uri, source) VALUES (?1, 't2', 'spotify:track:t2', 'recently_played')").bind(day(0, 5) + 2_000),
    db.prepare("INSERT INTO plays (played_at_ms, track_id, track_uri, source) VALUES (?1, 't9', 'spotify:track:t9', 'recently_played')").bind(day(5, 1)),
  ]);
  return id;
}

const expectedPlays = [
  [Date.UTC(2019, 11, 30, 20), "t1", "history_import"],
  [day(0, 5), "t2", "history_import"],
  [day(1, 2), "t3", "history_import"],
  [day(1, 20), "t2", "history_import"],
  [day(5, 1), "t9", "recently_played"],
];
const playsNow = async () => (await allPlays(db)).map((p) => [p.played_at_ms, p.track_id, p.source]);

describe("ImportWorkflow", () => {
  it("reads, deletes the upload, waits for the owner's approval from the page, then imports and enriches", async () => {
    const id = await uploaded();
    await using instance = await introspectWorkflowInstance(env.IMPORT_WORKFLOW, id);
    await instance.modify(async (m) => {
      await m.disableSleeps();
    });
    await env.IMPORT_WORKFLOW.create({ id, params: { importId: id, attempt: 0 } });
    await instance.waitForStepResult({ name: "email review" });

    // Waiting for the owner: the raw export is already gone from R2; nothing is applied yet.
    expect(await bucketKeys(bucket, id)).toEqual([]);
    const review = await getImport(db, id);
    expect(review?.status).toBe("review");
    expect(review?.preview).toMatchObject({ plays: 4, records: 6, skipped: 1, short: 1, totals: [4, 0, 1], months: { "2019-12": [1, 0, 0], "2020-01": [1, 0, 1], "2020-02": [2, 0, 0] } });
    expect(review?.preview?.warnings).toEqual({});
    expect(await playsNow()).toEqual([[day(0, 5) + 2_000, "t2", "recently_played"], [day(5, 1), "t9", "recently_played"]]);
    expect(await count(db, "SELECT COUNT(*) AS n FROM import_plays")).toBe(4);

    // The owner approves on the Import page (no backfill boxes ticked): the route sends the event.
    const res = await handleImportRoutes(new Request(`${ORIGIN}/import/${id}/approve`, { method: "POST", headers: { Origin: ORIGIN }, body: new FormData() }), routeEnv(), {} as ExecutionContext, session);
    expect(res?.headers.get("Location")).toBe("/import?ok=approved");
    await instance.waitForStatus("complete");
    expect(await instance.getOutput()).toEqual({ status: "done" });

    const done = await getImport(db, id);
    expect(done).toMatchObject({ status: "done", options: { liked: false, frequent: false }, applied_to: day(1, 20) + 30_000, error: null });
    expect(await playsNow()).toEqual(expectedPlays);
    expect(await count(db, "SELECT COUNT(*) AS n FROM import_plays")).toBe(0);
    // Enriched: credits and artists for every track that had none (t1, t2, t3 and the later t9).
    expect(await count(db, "SELECT COUNT(*) AS n FROM track_artists")).toBe(4);
    expect(await count(db, "SELECT COUNT(*) AS n FROM artists")).toBe(4);
    expect(mock!.liked).toEqual([]);
    const activity = (await db.prepare("SELECT kind, summary FROM activity ORDER BY id").all<{ kind: string; summary: string }>()).results;
    expect(activity.map((a) => a.kind)).toEqual(["import", "email", "import", "import", "email"]);
    expect(activity[0]!.summary).toBe("History ready to review: +4 / ~0 / -1");
    expect(activity[3]!.summary).toBe("History imported (Dec 2019 to Feb 2020): +4 / ~0 / -1");
    expect(activity[4]!.summary).toMatch(/^Your listening history is imported/);
  });

  it("adds the history to Liked Songs only when the owner confirmed it (and the setting is on)", async () => {
    await db.prepare("INSERT INTO settings (key, value) VALUES ('liked', 'true')").run();
    for (const liked of [false, true]) {
      await resetDb(db);
      await db.prepare("INSERT INTO settings (key, value) VALUES ('liked', 'true')").run();
      mock!.liked.length = 0;
      const id = await uploaded();
      await using instance = await introspectWorkflowInstance(env.IMPORT_WORKFLOW, id);
      await instance.modify(async (m) => {
        await m.disableSleeps();
        await m.mockEvent({ type: "approve", payload: { liked, frequent: false } });
      });
      await env.IMPORT_WORKFLOW.create({ id, params: { importId: id, attempt: 0 } });
      await instance.waitForStatus("complete");
      expect((await getImport(db, id))?.status).toBe("done");
      expect(mock!.liked.sort()).toEqual(liked ? ["t1", "t2", "t3", "t9"] : []);
    }
    // Only an explicit true counts as a yes.
    expect(normalizeOptions({ liked: "true", frequent: 1 })).toEqual({ liked: false, frequent: false });
    expect(normalizeOptions(null)).toEqual({ liked: false, frequent: false });
  });

  it("expires after 7 days without approval: staging deleted, nothing applied", async () => {
    const id = await uploaded();
    await using instance = await introspectWorkflowInstance(env.IMPORT_WORKFLOW, id);
    await instance.modify(async (m) => {
      await m.disableSleeps();
      await m.forceEventTimeout({ name: "owner approval" });
    });
    await env.IMPORT_WORKFLOW.create({ id, params: { importId: id, attempt: 0 } });
    await instance.waitForStatus("complete");
    expect(await instance.getOutput()).toEqual({ status: "expired" });
    expect((await getImport(db, id))?.status).toBe("expired");
    expect(await count(db, "SELECT COUNT(*) AS n FROM import_plays")).toBe(0);
    expect(await playsNow()).toEqual([[day(0, 5) + 2_000, "t2", "recently_played"], [day(5, 1), "t9", "recently_played"]]);
  });

  it("fails visibly, and a retry resumes after the months already applied", async () => {
    const id = await uploaded();
    {
      await using instance = await introspectWorkflowInstance(env.IMPORT_WORKFLOW, id);
      await instance.modify(async (m) => {
        await m.disableSleeps();
        await m.disableRetryDelays();
        await m.mockEvent({ type: "approve", payload: { liked: false, frequent: false } });
        await m.mockStepError({ name: "apply 2020-02" }, new Error("D1 hiccup"));
      });
      await env.IMPORT_WORKFLOW.create({ id, params: { importId: id, attempt: 0 } });
      await instance.waitForStatus("errored");
    }
    const failed = await getImport(db, id);
    expect(failed).toMatchObject({ status: "failed", error: "D1 hiccup", applied_to: day(1, 1, 0) });
    expect(failed?.options).toMatchObject({ liked: false, frequent: false });
    // December and January are in; February's staging rows wait for the retry.
    expect(await count(db, "SELECT COUNT(*) AS n FROM import_plays")).toBe(2);

    await using retry = await introspectWorkflowInstance(env.IMPORT_WORKFLOW, `${id}-r1`);
    await retry.modify(async (m) => {
      await m.disableSleeps();
    });
    const res = await handleImportRoutes(new Request(`${ORIGIN}/import/${id}/retry`, { method: "POST", headers: { Origin: ORIGIN } }), routeEnv(), {} as ExecutionContext, session);
    expect(res?.headers.get("Location")).toBe("/import?ok=retrying");
    await retry.waitForStatus("complete");
    // Approved before the failure: no second review or wait, and the applied months were skipped.
    expect(await retry.getOutput()).toEqual({ status: "done" });
    expect(await getImport(db, id)).toMatchObject({ status: "done", attempt: 1, error: null });
    expect(await playsNow()).toEqual(expectedPlays);
  });

  it("explains an export without listening history", async () => {
    const id = crypto.randomUUID();
    const zip = await buildZip([{ name: "MyData/StreamingHistory_music_0.json", data: "[]" }]);
    await insertImport(db, { id, status: "reading", files: [await putUpload(bucket, id, 1, "my_spotify_data.zip", zip)] });
    await using instance = await introspectWorkflowInstance(env.IMPORT_WORKFLOW, id);
    await instance.modify(async (m) => {
      await m.disableSleeps();
    });
    await env.IMPORT_WORKFLOW.create({ id, params: { importId: id, attempt: 0 } });
    await instance.waitForStatus("errored");
    expect((await getImport(db, id))?.error).toMatch(/^This looks like the regular Account data export/);
  });
});
