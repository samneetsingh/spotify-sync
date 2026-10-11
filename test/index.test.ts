import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker, { ImportWorkflow } from "../src/index";
import type { Env } from "../src/env";

const testEnv = (overrides: Partial<Env> = {}): Env => ({
  ...(env as unknown as Env),
  PUBLIC_URL: "https://sync.test",
  WRITE_MODE: "dry_run",
  ...overrides,
});
const ctx = {} as ExecutionContext;
const request = (path: string, init: RequestInit = {}) => new Request(`https://sync.test${path}`, init);

describe("fetch router", () => {
  it("404s paths no handler owns, with the HTML security headers", async () => {
    const res = await worker.fetch(request("/nope"), testEnv(), ctx);
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Security-Policy")).toMatch(/style-src 'nonce-[A-Za-z0-9+/=]+'/);
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
  });

  it("no longer serves POST /sync-full", async () => {
    const res = await worker.fetch(
      request("/sync-full", { method: "POST", headers: { Origin: "https://sync.test", Authorization: "Bearer anything" } }),
      testEnv(),
      ctx,
    );
    expect(res.status).toBe(404);
  });

  it.each([
    ["no Origin", {}],
    ["another site", { Origin: "https://evil.test" }],
    ["a sibling subdomain", { Origin: "https://evil.sync.test" }],
    ["an opaque origin", { Origin: "null" }],
    ["a cross-site fetch without Origin", { "Sec-Fetch-Site": "cross-site" }],
  ])("blocks a POST from %s before any handler runs", async (_label, headers) => {
    const res = await worker.fetch(request("/nope", { method: "POST", headers }), testEnv(), ctx);
    expect(res.status).toBe(403);
  });

  it("blocks every POST when PUBLIC_URL is unset", async () => {
    const res = await worker.fetch(request("/nope", { method: "POST", headers: { Origin: "https://sync.test" } }), testEnv({ PUBLIC_URL: undefined }), ctx);
    expect(res.status).toBe(403);
  });

  it("lets same-origin POSTs through to the handlers", async () => {
    const allowed: Array<Record<string, string>> = [{ Origin: "https://sync.test" }, { "Sec-Fetch-Site": "same-origin" }];
    for (const headers of allowed) {
      const res = await worker.fetch(request("/nope", { method: "POST", headers }), testEnv(), ctx);
      expect(res.status).toBe(404);
    }
  });
});

it("exports the import Workflow class for its binding", () => {
  expect(typeof ImportWorkflow).toBe("function");
});
