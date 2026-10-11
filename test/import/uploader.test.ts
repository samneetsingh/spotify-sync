// public/import.js: the pure helpers, and its upload protocol driven against the real routes.
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Session } from "../../src/auth";
import { migrate } from "../../src/db/schema";
import type { Env } from "../../src/env";
import { handleImportRoutes } from "../../src/import";
import { LIMITS, PART_SIZE } from "../../src/import/limits";
import { getImport, latestImport } from "../../src/import/store";
// @ts-expect-error plain JS module (served as-is from public/) without type declarations
import { backoffMs, checkFiles, formatBytes, partRanges, upload, withRetry } from "../../public/import.js";
import { resetDb } from "../parity/spotify-fixture";
import { clearBucket } from "./helpers";

const ORIGIN = "https://sync.test";
const session: Session = { spotifyId: "test-user", displayName: "Test", expiresAt: Date.now() + 86_400_000 };
const file = (name: string, size: number, fill = 1) => new File([new Uint8Array(size).fill(fill)], name);

describe("helpers", () => {
  it("cuts equal parts except the last", () => {
    expect(partRanges(25, 10)).toEqual([
      { partNumber: 1, start: 0, end: 10 },
      { partNumber: 2, start: 10, end: 20 },
      { partNumber: 3, start: 20, end: 25 },
    ]);
    expect(partRanges(10, 10)).toEqual([{ partNumber: 1, start: 0, end: 10 }]);
  });

  it("backs off 1, 2, 4 s, capped at 10 s, and retries only what can succeed", async () => {
    expect([1, 2, 3, 6].map(backoffMs)).toEqual([1000, 2000, 4000, 10000]);
    const waits: number[] = [];
    let calls = 0;
    const flaky = () => (++calls < 3 ? Promise.reject(new Error("network")) : Promise.resolve("ok"));
    expect(await withRetry(flaky, 3, async (ms: number) => void waits.push(ms))).toBe("ok");
    expect(waits).toEqual([1000, 2000]);
    const final = Object.assign(new Error("Part 1 must be 10 bytes."), { final: true });
    calls = 0;
    await expect(withRetry(() => (calls++, Promise.reject(final)), 3, async () => {})).rejects.toBe(final);
    expect(calls).toBe(1);
  });

  it("checks files like the server", () => {
    expect(checkFiles([], LIMITS)).toMatch(/Choose the zip/);
    expect(checkFiles([file("export.zip", 10)], LIMITS)).toBeNull();
    expect(checkFiles([file("Streaming_History_Audio_2020.json", 10), file("endsong_1.json", 10)], LIMITS)).toBeNull();
    expect(checkFiles([file("StreamingHistory_music_0.json", 10)], LIMITS)).toMatch(/isn't a listening history file/);
    expect(checkFiles([file("photo.png", 10)], LIMITS)).toMatch(/only the export's/);
    expect(checkFiles([file("export.zip", 0)], LIMITS)).toMatch(/empty/);
    expect(checkFiles([{ name: "export.zip", size: LIMITS.zipBytes + 1 }], LIMITS)).toMatch(/larger than 300 MB/);
    expect(checkFiles(Array.from({ length: 41 }, () => file("export.zip", 1)), LIMITS)).toMatch(/At most 40 files/);
    expect(formatBytes(1536)).toBe("2 KB");
    expect(formatBytes(5.5 * 1024 * 1024)).toBe("5.5 MB");
    expect(formatBytes(300 * 1024 * 1024)).toBe("300 MB");
  });
});

describe("upload", () => {
  let original: typeof fetch;
  beforeAll(() => migrate(env.DB));
  beforeEach(async () => {
    await resetDb(env.DB);
    await clearBucket(env.IMPORTS);
    original = globalThis.fetch;
  });
  afterEach(() => void (globalThis.fetch = original));

  it("sends every file in parts through the routes, then starts", async () => {
    const seen: string[] = [];
    let failOnce = true;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), ORIGIN);
      seen.push(`${init?.method} ${url.pathname}`);
      if (url.pathname.endsWith("/start")) return Response.json({ ok: true }); // the Workflow is tested elsewhere
      if (url.pathname.endsWith("/part/2") && failOnce) {
        failOnce = false;
        return Response.json({ error: "busy" }, { status: 503 }); // retried
      }
      const headers = new Headers(init?.headers);
      headers.set("Origin", ORIGIN);
      if (init?.body instanceof Blob) headers.set("Content-Length", String(init.body.size));
      const res = await handleImportRoutes(new Request(url, { ...init, headers }), { ...(env as unknown as Env), PUBLIC_URL: ORIGIN }, {} as ExecutionContext, session);
      return res ?? new Response("not found", { status: 404 });
    }) as typeof fetch;

    const files = [file("my_spotify_data.zip", PART_SIZE + 5, 2), file("Streaming_History_Audio_2020_1.json", 10, 3)];
    const progress: number[] = [];
    await upload(files, (sent: number) => progress.push(sent));

    const row = (await latestImport(env.DB))!;
    expect(row.files.map((f) => [f.name, f.size, f.done])).toEqual([
      ["my_spotify_data.zip", PART_SIZE + 5, true],
      ["Streaming_History_Audio_2020_1.json", 10, true],
    ]);
    expect((await env.IMPORTS.head(row.files[0]!.key))?.size).toBe(PART_SIZE + 5);
    const second = await env.IMPORTS.get(row.files[1]!.key);
    expect(new Uint8Array(await second!.arrayBuffer())).toEqual(new Uint8Array(10).fill(3));
    expect(progress).toEqual([PART_SIZE, PART_SIZE + 5, PART_SIZE + 15, PART_SIZE + 15]);
    expect(seen.filter((s) => s.includes("/part/2"))).toHaveLength(2);
    expect(seen.at(-1)).toBe(`POST /import/${row.id}/start`);
    expect((await getImport(env.DB, row.id))?.status).toBe("uploading");
  });

  it("stops at the server's refusal with its message", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), ORIGIN);
      const headers = new Headers(init?.headers);
      headers.set("Origin", ORIGIN);
      return (await handleImportRoutes(new Request(url, { ...init, headers }), { ...(env as unknown as Env), PUBLIC_URL: ORIGIN }, {} as ExecutionContext, session))!;
    }) as typeof fetch;
    await expect(upload([file("StreamingHistory_music_0.json", 10)], () => {})).rejects.toThrow(/isn't a listening history file/);
  });
});
