// Staging, preview and apply on local D1 must reconcile exactly like the CLI script: these tests run
// the script's in-memory semantics (ExportCollector + planReconcile, src/import/parse.ts and plan.ts)
// next to the SQL path on the same randomized fixtures and compare the outcome.
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../../src/db/schema";
import { ExportCollector, parseRecordsText, playKey, type ExportPlay } from "../../src/import/parse";
import { planReconcile } from "../../src/import/plan";
import { applySlice, buildPreview, monthSlices, previewSlice, previewYears, spanOf, yearSlices } from "../../src/import/reconcile";
import { indexImport, stageEntry } from "../../src/import/stage";
import { resetDb } from "../parity/spotify-fixture";
import { allPlays, audioRecord, clearBucket, count, enc, episodeRecord, exportJson, insertImport, putUpload, rng, type PlayRowOut } from "./helpers";

const db = env.DB;
const bucket = env.IMPORTS;

beforeAll(() => migrate(db));
beforeEach(async () => {
  await resetDb(db);
  await clearBucket(bucket);
});

interface Seeded {
  ms: number;
  track: string;
  source: string;
  msPlayed: number | null;
}

/** A random export (three files) and a database that overlaps it in every interesting way. */
function fixture(seed: number) {
  const r = rng(seed);
  const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)]!;
  const tracks = Array.from({ length: 12 }, (_, i) => `t${String(i).padStart(2, "0")}`);
  const start = Date.UTC(2019, 10, 20);
  const span = Date.UTC(2020, 2, 10) - start;
  const lengths = [5_000, 29_999, 30_000, 31_000, 180_000];
  const files: Array<Array<Record<string, unknown>>> = [[], [], []];
  const exported: Array<{ ms: number; track: string; msPlayed: number }> = [];
  for (let i = 0; i < 240; i++) {
    const ms = start + Math.floor(r() * span / 1000) * 1000;
    const file = files[Math.floor(r() * 3)]!;
    if (r() < 0.05) {
      file.push(episodeRecord(ms));
      continue;
    }
    const rec = { ms, track: pick(tracks), msPlayed: pick(lengths) };
    exported.push(rec);
    file.push(audioRecord({ ...rec, platform: pick(["ios", "android", "web"]), shuffle: r() < 0.5, skipped: r() < 0.3 ? null : r() < 0.5 }));
    // Duplicates with different fields: the last one (by file order, then record order) wins.
    if (r() < 0.08) files[Math.floor(r() * 3)]!.push(audioRecord({ ...rec, msPlayed: pick(lengths), platform: "duplicate" }));
  }
  files[0]!.push({ ts: "not a timestamp", spotify_track_uri: "spotify:track:t00" });

  const seeded: Seeded[] = [];
  for (const e of exported) {
    const roll = r();
    if (roll < 0.25) seeded.push({ ms: e.ms, track: e.track, source: "history_import", msPlayed: null }); // lacks export fields -> update (or delete if short)
    else if (roll < 0.4) seeded.push({ ms: e.ms, track: e.track, source: "history_import", msPlayed: 99_999 }); // complete -> untouched (or delete if short)
    else if (roll < 0.6) seeded.push({ ms: e.ms + 2_000, track: e.track, source: "recently_played", msPlayed: null }); // the API's twin -> delete
  }
  seeded.push({ ms: start - 60_000, track: "t01", source: "recently_played", msPlayed: null }); // before the span
  seeded.push({ ms: Date.UTC(2020, 5, 1), track: "t02", source: "recently_played", msPlayed: null }); // after the span
  return { files, seeded: dedupe(seeded) };
}

const dedupe = (rows: Seeded[]) => [...new Map(rows.map((s) => [playKey(s.ms, s.track), s])).values()];

async function seedDb(rows: Seeded[]): Promise<void> {
  const ids = [...new Set(rows.map((s) => s.track))];
  await db.batch([
    ...ids.map((id) => db.prepare("INSERT INTO tracks (track_id, track_uri, name) VALUES (?1, 'spotify:track:' || ?1, 'Seeded')").bind(id)),
    ...rows.map((s) =>
      db.prepare("INSERT INTO plays (played_at_ms, track_id, track_uri, source, ms_played) VALUES (?1, ?2, 'spotify:track:' || ?2, ?3, ?4)").bind(s.ms, s.track, s.source, s.msPlayed),
    ),
  ]);
}

/** What the CLI script does: collect the files in name order, diff against D1's plays in the span, apply in memory. */
function scriptOutcome(fileTexts: string[], seeded: Seeded[]) {
  const c = new ExportCollector();
  for (const t of fileTexts) c.add(parseRecordsText(t));
  const span = c.span()!;
  const current = new Map(seeded.filter((s) => s.ms >= span.from && s.ms < span.to).map((s) => [playKey(s.ms, s.track), s.msPlayed !== null]));
  const plan = planReconcile(c.plays, current);
  const row = (s: Seeded): PlayRowOut => ({
    played_at_ms: s.ms, track_id: s.track, track_uri: `spotify:track:${s.track}`, source: s.source, ms_played: s.msPlayed,
    platform: null, conn_country: null, reason_start: null, reason_end: null, shuffle: null, skipped: null, offline: null, incognito_mode: null,
  });
  const final = new Map(seeded.map((s) => [playKey(s.ms, s.track), row(s)]));
  for (const [ms, id] of plan.toDelete) final.delete(playKey(ms, id));
  const withFields = (base: PlayRowOut, p: ExportPlay): PlayRowOut => ({ ...base, ...p.fields } as PlayRowOut);
  for (const p of plan.toInsert) final.set(playKey(p.played_at_ms, p.track_id), withFields({ ...row({ ms: p.played_at_ms, track: p.track_id, source: "history_import", msPlayed: null }), track_uri: p.track_uri }, p));
  for (const p of plan.toUpdate) final.set(playKey(p.played_at_ms, p.track_id), withFields(final.get(playKey(p.played_at_ms, p.track_id))!, p));
  const plays = [...final.values()].sort((a, b) => a.played_at_ms - b.played_at_ms || (a.track_id < b.track_id ? -1 : 1));
  return { span, plan, plays, collector: c };
}

/** The dashboard path: upload, index, stage each entry, preview per year, apply per month. */
async function dashboardOutcome(fileTexts: string[], names: string[]) {
  const id = await insertImport(db, { status: "reading" });
  // Upload out of name order: staging must still use the CLI's order.
  const files = await Promise.all(fileTexts.map((t, i) => putUpload(bucket, id, i + 1, names[i]!, enc(t)))).then((f) => f.reverse());
  await db.prepare("UPDATE imports SET files = ?2 WHERE id = ?1").bind(id, JSON.stringify(files)).run();
  const entries = await indexImport(db, bucket, id);
  for (const e of entries) await stageEntry(db, bucket, id, e, entries.length);
  const row = (await db.prepare("SELECT span_from, span_to FROM imports WHERE id = ?1").bind(id).first<{ span_from: number; span_to: number }>())!;
  const span = spanOf(row.span_from, row.span_to);
  const years = [];
  for (const y of yearSlices(span)) years.push(await previewSlice(db, id, y));
  const preview = buildPreview(span, { records: 0, skipped: 0, short: 0, plays: 0 }, years);
  await db.prepare("UPDATE imports SET status = 'applying' WHERE id = ?1").bind(id).run();
  for (const m of monthSlices(span)) await applySlice(db, id, m, `applied ${m.label}`);
  return { id, span, preview };
}

describe("dashboard import == CLI script", () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    it(`seed ${seed}: same span, same per-year diff, same plays afterwards`, async () => {
      const { files, seeded } = fixture(seed);
      const names = ["Streaming_History_Audio_2019-2020_0.json", "Streaming_History_Audio_2019-2020_1.json", "Streaming_History_Audio_2020_2.json"];
      const texts = files.map(exportJson);
      await seedDb(seeded);
      const expected = scriptOutcome(texts, seeded);
      const actual = await dashboardOutcome(texts, names);
      // The fixture exercises every kind of change.
      for (const n of [expected.plan.toInsert.length, expected.plan.toUpdate.length, expected.plan.toDelete.length]) expect(n).toBeGreaterThan(0);
      expect(expected.plan.byYear.map(([y]) => y)).toEqual([2019, 2020]);

      expect(actual.span).toEqual(expected.span);
      expect(previewYears(actual.preview).map(([y, ...c]) => [y, c])).toEqual(expected.plan.byYear);
      expect(actual.preview.totals).toEqual([expected.plan.toInsert.length, expected.plan.toUpdate.length, expected.plan.toDelete.length]);
      expect(await allPlays(db)).toEqual(expected.plays);
      // Every played track exists; staging is empty; the marker covers the span.
      expect(await count(db, "SELECT COUNT(*) AS n FROM plays p WHERE NOT EXISTS (SELECT 1 FROM tracks t WHERE t.track_id = p.track_id)")).toBe(0);
      expect(await count(db, "SELECT COUNT(*) AS n FROM import_plays")).toBe(0);
      expect(await count(db, `SELECT applied_to AS n FROM imports WHERE id = '${actual.id}'`)).toBe(actual.span.to);
      // A re-run of the CLI against the result finds nothing to do.
      const again = scriptOutcome(texts, (await allPlays(db)).map((p) => ({ ms: p.played_at_ms, track: p.track_id, source: p.source, msPlayed: p.ms_played })));
      expect([again.plan.toInsert.length, again.plan.toUpdate.length, again.plan.toDelete.length]).toEqual([0, 0, 0]);
    });
  }
});

describe("staging", () => {
  const ms = (d: number, h = 12) => Date.UTC(2020, 0, d, h);

  async function stageAll(texts: Array<[string, string]>) {
    const id = await insertImport(db, { status: "reading" });
    const files = await Promise.all(texts.map(([name, t], i) => putUpload(bucket, id, i + 1, name, enc(t))));
    await db.prepare("UPDATE imports SET files = ?2 WHERE id = ?1").bind(id, JSON.stringify(files)).run();
    const entries = await indexImport(db, bucket, id);
    return { id, entries };
  }

  it("is idempotent: a replayed stage step reads nothing and changes nothing", async () => {
    const { id, entries } = await stageAll([["Streaming_History_Audio_0.json", exportJson([audioRecord({ ms: ms(1), track: "a" }), audioRecord({ ms: ms(2), track: "b" })])]]);
    const first = await stageEntry(db, bucket, id, entries[0]!, 1);
    expect(first).toEqual({ already: false, records: 2, plays: 2 });
    // The object is deleted once its last entry is staged; a replay must not need it.
    expect((await bucket.list({ prefix: `imports/${id}/` })).objects).toEqual([]);
    expect(await stageEntry(db, bucket, id, entries[0]!, 1)).toEqual({ already: true, records: 0, plays: 0 });
    expect(await count(db, "SELECT COUNT(*) AS n FROM import_plays")).toBe(2);
    const row = await db.prepare("SELECT entries FROM imports WHERE id = ?1").bind(id).first<{ entries: string }>();
    expect(Object.values(JSON.parse(row!.entries))).toMatchObject([{ done: true, records: 2, plays: 2, skipped: 0, short: 0 }]);
    // indexImport on a retry reuses the recorded entries (the uploads are gone by then).
    expect(await indexImport(db, bucket, id)).toMatchObject([{ key: entries[0]!.key, done: true }]);
  });

  it("spans records under 30 s too, and lets the last duplicate win across files", async () => {
    const { id, entries } = await stageAll([
      ["Streaming_History_Audio_0.json", exportJson([audioRecord({ ms: ms(1, 1), track: "short", msPlayed: 10_000 }), audioRecord({ ms: ms(5), track: "a", platform: "first" })])],
      ["Streaming_History_Audio_1.json", exportJson([audioRecord({ ms: ms(5), track: "a", platform: "second" }), audioRecord({ ms: ms(9), track: "b", msPlayed: 29_000 })])],
    ]);
    for (const e of entries) await stageEntry(db, bucket, id, e, entries.length);
    const row = await db.prepare("SELECT span_from, span_to FROM imports WHERE id = ?1").bind(id).first<{ span_from: number; span_to: number }>();
    expect(row).toEqual({ span_from: ms(1, 1), span_to: ms(9) });
    const staged = await db.prepare("SELECT track_id, platform FROM import_plays").all<{ track_id: string; platform: string }>();
    expect(staged.results).toEqual([{ track_id: "a", platform: "second" }]);
  });

  it("clears staging rows an abandoned import left behind, once", async () => {
    await db.prepare("INSERT INTO import_plays (import_id, played_at_ms, track_id, track_uri) VALUES ('gone', 1, 'old', 'spotify:track:old')").run();
    const { id, entries } = await stageAll([["Streaming_History_Audio_0.json", exportJson([audioRecord({ ms: ms(1), track: "a" })])]]);
    expect(await count(db, "SELECT COUNT(*) AS n FROM import_plays")).toBe(0);
    await stageEntry(db, bucket, id, entries[0]!, 1);
    await indexImport(db, bucket, id);
    expect(await count(db, "SELECT COUNT(*) AS n FROM import_plays")).toBe(1);
  });
});

describe("apply", () => {
  const t = (d: number) => Date.UTC(2020, 0, d, 12);

  async function staged(rows: Array<[number, string, number | null]>, plays: Seeded[]) {
    await seedDb(plays);
    const id = await insertImport(db, { status: "applying", spanFrom: t(1), spanTo: t(28) });
    await db.batch(
      rows.map(([ms, track, msPlayed]) =>
        db.prepare("INSERT INTO import_plays (import_id, played_at_ms, track_id, track_uri, name, ms_played, platform) VALUES (?4, ?1, ?2, 'spotify:track:' || ?2, 'Staged', ?3, 'ios')").bind(ms, track, msPlayed, id),
      ),
    );
    return id;
  }

  it("a replayed apply step after its commit deletes nothing", async () => {
    const id = await staged([[t(2), "a", 60_000]], [{ ms: t(3), track: "z", source: "recently_played", msPlayed: null }]);
    const [jan] = monthSlices(spanOf(t(1), t(28)));
    expect(await applySlice(db, id, jan!, "Imported 2020-01")).toEqual({ skipped: false, written: 1, deleted: 1 });
    const after = await allPlays(db);
    // Staging for the month is gone now; without the applied_to guard this would delete "a" too.
    expect(await applySlice(db, id, jan!, "Imported 2020-01")).toEqual({ skipped: true, written: 0, deleted: 0 });
    expect(await allPlays(db)).toEqual(after);
    expect(after.map((p) => p.track_id)).toEqual(["a"]);
  });

  it("does nothing unless the import is applying (cancelled, or not approved)", async () => {
    const id = await staged([[t(2), "a", 60_000]], [{ ms: t(3), track: "z", source: "recently_played", msPlayed: null }]);
    await db.prepare("UPDATE imports SET status = 'review' WHERE id = ?1").bind(id).run();
    const [jan] = monthSlices(spanOf(t(1), t(28)));
    expect(await applySlice(db, id, jan!, "x")).toEqual({ skipped: true, written: 0, deleted: 0 });
    expect((await allPlays(db)).map((p) => p.track_id)).toEqual(["z"]);
    expect(await count(db, "SELECT COUNT(*) AS n FROM import_plays")).toBe(1);
  });

  it("only completes plays that lack the export fields, and leaves plays outside the span alone", async () => {
    const id = await staged(
      [[t(2), "a", 60_000], [t(4), "b", 70_000]],
      [
        { ms: t(2), track: "a", source: "recently_played", msPlayed: null },
        { ms: t(4), track: "b", source: "history_import", msPlayed: 12_345 },
        { ms: t(1) - 1, track: "before", source: "recently_played", msPlayed: null },
        { ms: t(28) + 30_000, track: "after", source: "recently_played", msPlayed: null },
      ],
    );
    for (const m of monthSlices(spanOf(t(1), t(28)))) await applySlice(db, id, m, "x");
    const plays = await allPlays(db);
    expect(plays.map((p) => [p.track_id, p.source, p.ms_played, p.platform])).toEqual([
      ["before", "recently_played", null, null],
      ["a", "recently_played", 60_000, "ios"],
      ["b", "history_import", 12_345, null],
      ["after", "recently_played", null, null],
    ]);
  });

  it("cuts the span at UTC month boundaries", () => {
    const span = { from: Date.UTC(2019, 11, 31, 23), to: Date.UTC(2020, 2, 1, 0, 0, 30) };
    expect(monthSlices(span).map((m) => [m.label, m.from, m.to])).toEqual([
      ["2019-12", span.from, Date.UTC(2020, 0, 1)],
      ["2020-01", Date.UTC(2020, 0, 1), Date.UTC(2020, 1, 1)],
      ["2020-02", Date.UTC(2020, 1, 1), Date.UTC(2020, 2, 1)],
      ["2020-03", Date.UTC(2020, 2, 1), span.to],
    ]);
    expect(yearSlices(span).map((y) => y.year)).toEqual([2019, 2020]);
  });
});

describe("preview warnings", () => {
  it("flags an export whose plays don't match what the live sync recorded", async () => {
    const base = Date.UTC(2021, 0, 1);
    await seedDb(Array.from({ length: 25 }, (_, i) => ({ ms: base + i * 3_600_000, track: `s${i}`, source: "recently_played", msPlayed: null })));
    await db.batch(
      Array.from({ length: 25 }, (_, i) =>
        db.prepare("INSERT INTO import_plays (import_id, played_at_ms, track_id, track_uri, ms_played) VALUES ('imp', ?1, ?2, 'x', 60000)").bind(base + i * 3_600_000 - 2_000, i < 5 ? `s${i}` : `other${i}`),
      ),
    );
    const span = { from: base - 10_000, to: base + 30 * 3_600_000 };
    const preview = buildPreview(span, { records: 25, skipped: 0, short: 0, plays: 25 }, [await previewSlice(db, "imp", span)]);
    expect(preview.warnings).toEqual({ accountMismatch: { synced: 25, matched: 5 } });
  });

  it("flags an import that would delete many earlier imported plays", async () => {
    const base = Date.UTC(2021, 0, 1);
    await seedDb(Array.from({ length: 150 }, (_, i) => ({ ms: base + i * 60_000, track: "h", source: "history_import", msPlayed: 60_000 })));
    const span = { from: base, to: base + 200 * 60_000 };
    const preview = buildPreview(span, { records: 0, skipped: 0, short: 0, plays: 0 }, [await previewSlice(db, "imp", span)]);
    expect(preview.warnings).toEqual({ historyLoss: { deletes: 150, imported: 150 } });
    expect(preview.totals).toEqual([0, 0, 150]);
  });
});
