// planReconcile and ExportCollector (src/import) were extracted from scripts/import-history.ts. This
// pins them to the script's original in-memory logic, copied below from the last version before the
// extraction (a97b8ed), on randomized inputs: same plays, tracks, counts, span and per-year diff.
import { describe, expect, it } from "vitest";
import { ExportCollector, MIN_MS_PLAYED, SPAN_TAIL_MS, parseRecord, playKey, type ExportPlay, type ExportRecord, type ExportTrack } from "../../src/import/parse";
import { planReconcile } from "../../src/import/plan";
import { audioRecord, endsongRecord, episodeRecord, rng } from "./helpers";

/** The script's main() before the extraction, minus the file reading and D1 (records per file, current plays given). */
function originalScript(files: ExportRecord[][], currentInDb: Map<string, boolean> | ((from: number, to: number) => Map<string, boolean>)) {
  const year = (ms: number) => new Date(ms).getUTCFullYear();
  const plays = new Map<string, ExportPlay>();
  const tracks = new Map<string, ExportTrack>();
  let [seen, skipped, short] = [0, 0, 0];
  let [first, last] = [Infinity, -Infinity];
  for (const records of files) {
    seen += records.length;
    for (const r of records) {
      const parsed = parseRecord(r);
      if (!parsed) {
        skipped++;
        continue;
      }
      const { play, track } = parsed;
      [first, last] = [Math.min(first, play.played_at_ms), Math.max(last, play.played_at_ms)];
      if ((play.fields.ms_played ?? 0) < MIN_MS_PLAYED) {
        short++;
        continue;
      }
      plays.set(playKey(play.played_at_ms, play.track_id), play);
      if (!tracks.has(track.track_id)) tracks.set(track.track_id, track);
    }
  }
  if (first > last) return { seen, skipped, short, plays, tracks, span: null };
  const [from, to] = [first, last + SPAN_TAIL_MS];
  const current = typeof currentInDb === "function" ? currentInDb(from, to) : currentInDb;
  const toInsert = [...plays].filter(([k]) => !current.has(k)).map(([, p]) => p);
  const toUpdate = [...plays].filter(([k]) => current.get(k) === false).map(([, p]) => p);
  const toDelete = [...current.keys()].filter((k) => !plays.has(k)).map((k): [number, string] => {
    const [ms, trackId] = k.split(":");
    return [Number(ms), trackId!];
  });
  const byYear = new Map<number, [number, number, number]>();
  const tally = (ms: number, i: 0 | 1 | 2) => {
    const counts = byYear.get(year(ms)) ?? [0, 0, 0];
    counts[i]++;
    byYear.set(year(ms), counts);
  };
  for (const p of toInsert) tally(p.played_at_ms, 0);
  for (const p of toUpdate) tally(p.played_at_ms, 1);
  for (const [ms] of toDelete) tally(ms, 2);
  return { seen, skipped, short, plays, tracks, span: { from, to }, toInsert, toUpdate, toDelete, byYear: [...byYear].sort(([a], [b]) => a - b) };
}

function randomExport(seed: number) {
  const r = rng(seed);
  const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)]!;
  const start = Date.UTC(2015, 11, 1);
  const files: ExportRecord[][] = Array.from({ length: 4 }, () => []);
  const keys: Array<[number, string]> = [];
  for (let i = 0; i < 400; i++) {
    const ms = start + Math.floor((r() * 3 * 365 * 86_400_000) / 1000) * 1000;
    const track = pick(["a", "b", "c", "d", "e", "f"]);
    const file = pick(files);
    const roll = r();
    if (roll < 0.05) file.push(episodeRecord(ms));
    else if (roll < 0.08) file.push({ ts: "bad", spotify_track_uri: `spotify:track:${track}` });
    else if (roll < 0.3) file.push(endsongRecord({ ms, track, msPlayed: pick([0, 29_999, 30_000, 200_000]), name: `v${i}` }));
    else file.push(audioRecord({ ms, track, msPlayed: pick([1_000, 29_999, 30_000, 200_000]), name: `v${i}`, skipped: pick([true, false, null]) }));
    keys.push([ms, track]);
  }
  // The database: some of the export's keys (with and without export fields) and some others.
  const current = new Map<string, boolean>();
  for (const [ms, track] of keys) if (r() < 0.4) current.set(playKey(ms + (r() < 0.3 ? 2_000 : 0), track), r() < 0.5);
  return { files, current };
}

describe("planReconcile / ExportCollector == the script's original logic", () => {
  for (const seed of [11, 12, 13, 14, 15, 16]) {
    it(`seed ${seed}`, () => {
      const { files, current } = randomExport(seed);
      const before = originalScript(files, current);
      const c = new ExportCollector();
      for (const f of files) c.add(f);
      const plan = planReconcile(c.plays, current);

      expect([c.seen, c.skipped, c.short]).toEqual([before.seen, before.skipped, before.short]);
      expect([...c.plays]).toEqual([...before.plays]);
      expect([...c.tracks]).toEqual([...before.tracks]);
      expect(c.span()).toEqual(before.span);
      expect(plan.toInsert).toEqual(before.toInsert);
      expect(plan.toUpdate).toEqual(before.toUpdate);
      expect(plan.toDelete).toEqual(before.toDelete);
      expect(plan.byYear).toEqual(before.byYear);
      expect(plan.toInsert.length + plan.toUpdate.length + plan.toDelete.length).toBeGreaterThan(0);
    });
  }

  it("agrees on an export without track records", () => {
    const files = [[episodeRecord(Date.UTC(2020, 0, 1))]];
    const c = new ExportCollector();
    for (const f of files) c.add(f);
    expect(c.span()).toBe(originalScript(files, new Map()).span);
  });
});
