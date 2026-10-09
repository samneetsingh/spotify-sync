import { env } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/env";
import { migrate } from "../src/db/schema";
import { mockSpotify, resetDb } from "./parity/spotify-fixture";

const SECRET = "correct-horse-battery-staple";
const testEnv = (overrides: Partial<Env> = {}): Env => ({
  ...(env as unknown as Env),
  SPOTIFY_ALL_PLAYLIST_ID: "all1",
  SPOTIFY_FREQUENT_PLAYLIST_ID: "",
  WRITE_MODE: "dry_run",
  SYNC_FULL_SECRET: SECRET,
  ...overrides,
});
const ctx = {} as ExecutionContext;
const post = (headers: Record<string, string> = {}, path = "/sync-full") =>
  new Request(`https://worker.test${path}`, { method: "POST", headers });

let restore: (() => void) | undefined;
beforeAll(() => migrate(env.DB));
afterEach(() => restore?.());

describe("POST /sync-full auth", () => {
  it.each([
    ["no header", {}],
    ["wrong secret", { Authorization: "Bearer nope" }],
    ["secret prefix", { Authorization: `Bearer ${SECRET.slice(0, -1)}` }],
    ["non-bearer scheme", { Authorization: `Basic ${SECRET}` }],
    ["empty bearer", { Authorization: "Bearer " }],
  ])("rejects %s with 401", async (_label, headers) => {
    const res = await worker.fetch(post(headers), testEnv(), ctx);
    expect(res.status).toBe(401);
  });

  it("rejects everything when the secret is unset", async () => {
    const res = await worker.fetch(post({ Authorization: "Bearer " }), testEnv({ SYNC_FULL_SECRET: "" }), ctx);
    expect(res.status).toBe(401);
  });

  it("runs the job with the correct secret", async () => {
    await resetDb(env.DB);
    restore = mockSpotify({}).restore;
    const res = await worker.fetch(post({ Authorization: `Bearer ${SECRET}` }), testEnv(), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ writeMode: "dry_run", likedAdded: 0, frequentAdded: 0 });
  });

  it("404s other routes", async () => {
    const res = await worker.fetch(new Request("https://worker.test/"), testEnv(), ctx);
    expect(res.status).toBe(404);
  });
});
