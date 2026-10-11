// The zip reader (src/import/zip.ts) and reading entries from local R2 (src/import/stage.ts).
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { listEntries, readEntryText } from "../../src/import/stage";
import { ImportError, MAX_ENTRY_BYTES, NOT_EXTENDED_HISTORY, audioEntries, listZipEntries, r2Source, readTextLimited, type ByteSource } from "../../src/import/zip";
import { audioRecord, buildZip, clearBucket, enc, exportJson, putUpload } from "./helpers";

const memory = (b: Uint8Array): ByteSource => ({
  size: b.length,
  read: async (o, n) => b.slice(o, o + n),
  stream: async (o, n) => new Blob([b.slice(o, o + n)]).stream(),
});

const AUDIO = "Spotify Extended Streaming History/Streaming_History_Audio_2020_0.json";
const records = exportJson([audioRecord({ ms: Date.UTC(2020, 0, 1), track: "t1" }), audioRecord({ ms: Date.UTC(2020, 0, 2), track: "t2" })]);

afterEach(() => clearBucket(env.IMPORTS));

describe("listZipEntries / audioEntries", () => {
  it("lists entries from the central directory and keeps only audio history files", async () => {
    const zip = await buildZip(
      [
        { name: "Spotify Extended Streaming History/", data: "" },
        { name: AUDIO, data: records },
        { name: "Spotify Extended Streaming History/Streaming_History_Video_2020.json", data: "[]" },
        { name: "__MACOSX/Spotify Extended Streaming History/._Streaming_History_Audio_2020_0.json", data: "junk" },
        { name: "Spotify Extended Streaming History/ReadMeFirst_ExtendedStreamingHistory.pdf", data: "%PDF" },
      ],
      { comment: "made by a test" },
    );
    const all = await listZipEntries(memory(zip));
    expect(all.map((e) => e.name)).toHaveLength(4); // the directory entry is skipped
    expect(audioEntries(all).map((e) => e.name)).toEqual([AUDIO]);
  });

  it("reads stored and deflated entries, with and without a data descriptor", async () => {
    const zip = await buildZip([
      { name: "a/Streaming_History_Audio_1.json", data: records, method: 0 },
      { name: "a/Streaming_History_Audio_2.json", data: records, method: 8 },
      { name: "a/Streaming_History_Audio_3.json", data: records, method: 8, descriptor: true },
      { name: "a/endsong_0.json", data: records, method: 0, descriptor: true },
    ]);
    const file = await putUpload(env.IMPORTS, "zip-read", 1, "my_spotify_data.zip", zip);
    const entries = await listEntries(env.IMPORTS, [file]);
    expect(entries.map((e) => [e.name, e.method])).toEqual([
      ["a/Streaming_History_Audio_1.json", 0],
      ["a/Streaming_History_Audio_2.json", 8],
      ["a/Streaming_History_Audio_3.json", 8],
      ["a/endsong_0.json", 0],
    ]);
    for (const e of entries) expect(await readEntryText(env.IMPORTS, e)).toBe(records);
    expect(entries.map((e) => e.lastOfFile)).toEqual([false, false, false, true]);
  });

  it("treats a JSON upload as one entry and sorts entries by file name like the CLI", async () => {
    const zip = await buildZip([{ name: "x/Streaming_History_Audio_2021_1.json", data: records }]);
    const files = [
      await putUpload(env.IMPORTS, "zip-sort", 1, "Streaming_History_Audio_2022_2.json", enc(records)),
      await putUpload(env.IMPORTS, "zip-sort", 2, "export.zip", zip),
      await putUpload(env.IMPORTS, "zip-sort", 3, "Streaming_History_Audio_2020_0.json", enc(records)),
    ];
    const entries = await listEntries(env.IMPORTS, files);
    expect(entries.map((e) => [e.name, e.kind, e.lastOfFile])).toEqual([
      ["Streaming_History_Audio_2020_0.json", "json", true],
      ["x/Streaming_History_Audio_2021_1.json", "zip", true],
      ["Streaming_History_Audio_2022_2.json", "json", true],
    ]);
    expect(await readEntryText(env.IMPORTS, entries[0]!)).toBe(records);
  });

  it("explains a regular Account data export", async () => {
    const zip = await buildZip([
      { name: "MyData/StreamingHistory_music_0.json", data: "[]" },
      { name: "MyData/YourLibrary.json", data: "{}" },
    ]);
    const file = await putUpload(env.IMPORTS, "zip-account", 1, "my_spotify_data.zip", zip);
    await expect(listEntries(env.IMPORTS, [file])).rejects.toThrow(NOT_EXTENDED_HISTORY);
  });

  it.each([
    ["zip64", async () => buildZip([{ name: AUDIO, data: records }], { zip64Locator: true }), /zip64/],
    ["zip64 sizes", async () => buildZip([{ name: AUDIO, data: records, zip64Sizes: true }]), /zip64/],
    ["encrypted", async () => buildZip([{ name: AUDIO, data: records, encrypted: true }]), /password-protected/],
    ["oversized", async () => buildZip([{ name: AUDIO, data: records, declaredSize: MAX_ENTRY_BYTES + 1 }]), /larger than 32 MB/],
    ["unsupported method", async () => buildZip([{ name: AUDIO, data: records, method: 12 }]), /unsupported compression/],
    ["too many entries", async () => buildZip(Array.from({ length: 201 }, (_, i) => ({ name: `f${i}.txt`, data: "x", method: 0 }))), /more than 200/],
    ["not a zip", async () => enc("PK\u0003\u0004 then nothing useful"), /no zip directory/],
  ])("rejects %s with an owner-facing message", async (_label, make, message) => {
    const bytes = await make();
    const run = async () => audioEntries(await listZipEntries(memory(bytes)));
    await expect(run()).rejects.toThrow(ImportError);
    await expect(run()).rejects.toThrow(message);
  });

  it("stops inflating past the size cap (zip bombs) and reports damaged data", async () => {
    const big = enc("[" + " ".repeat(5000) + "]");
    const zip = await buildZip([{ name: AUDIO, data: big, declaredSize: 10 }]);
    const [entry] = audioEntries(await listZipEntries(memory(zip)));
    const { zipEntryStream } = await import("../../src/import/zip");
    await expect(readTextLimited(await zipEntryStream(memory(zip), entry!), 1000, "the file")).rejects.toThrow(/larger than/);
    const garbage = new Blob([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    await expect(readTextLimited(garbage, 1000, "the file")).rejects.toThrow(/damaged/);
  });

  it("says when an upload has expired from R2", async () => {
    const src = r2Source(env.IMPORTS, "imports/gone/1.zip", 100);
    await expect(src.read(0, 10)).rejects.toThrow(/gone/);
  });
});
