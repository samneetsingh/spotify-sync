import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getState, setState } from "../../src/db/state";
import { migrate } from "../../src/db/schema";
import { MAX_CALLS_PER_MONTH, callsKey, planDigest } from "../../src/editor";
import { EDITOR_MODEL, MAX_OUTPUT_TOKENS } from "../../src/editor/client";
import { LIMITS, PLAN_SCHEMA, SYSTEM_PROMPT, userContent } from "../../src/editor/prompt";
import { BASE_SECTION_IDS, HIGHLIGHT_KINDS, THEME_IDS, type EditorConfig } from "../../src/editor/types";
import { resetDb } from "../parity/spotify-fixture";
import { TEST_KEY, fakeFetch, json, monthInput, responseBody, validPlan } from "./fixtures";

const NOW = Date.UTC(2026, 10, 1, 2); // Nov 1, 02:00 UTC (Oct 31 in Los Angeles): counts toward 2026-11
const JOB = "monthly-recap";
type Respond = Parameters<typeof fakeFetch>[0];

let logs: string[];
beforeAll(() => migrate(env.DB));
beforeEach(async () => {
  await resetDb(env.DB);
  logs = [];
  for (const level of ["log", "warn", "error", "info", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logs.push(args.map(String).join(" ")));
  }
});
afterEach(() => vi.restoreAllMocks());

/** planDigest with a fake OpenAI; no retries unless asked. */
async function plan(respond: Respond, cfg: Partial<EditorConfig> = {}) {
  const f = fakeFetch(respond);
  let loads = 0;
  const load = async () => (loads++, monthInput());
  const outcome = await planDigest(env.DB, { apiKey: TEST_KEY, fetch: f.fetch, maxRetries: 0, ...cfg }, { job: JOB, now: NOW, load });
  return { outcome, calls: f.calls, loads };
}
const good: Respond = () => json(responseBody(JSON.stringify(validPlan())));
const entries = () => logs.map((l) => JSON.parse(l) as Record<string, unknown>);
const calls = () => getState(env.DB, callsKey(NOW));

describe("request", () => {
  it("sends one strict json_schema request to gpt-6.1-sol", async () => {
    const { calls } = await plan(good);
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/responses");
    expect(init.method).toBe("POST");
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer test-key");
    expect(headers.get("content-type")).toBe("application/json");
    expect(init.signal).toBeInstanceOf(AbortSignal);

    const body = JSON.parse(init.body as string);
    expect(EDITOR_MODEL).toBe("gpt-6.1-sol");
    expect(body.model).toBe("gpt-6.1-sol");
    expect(body.instructions).toBe(SYSTEM_PROMPT);
    expect(body.input).toBe(userContent(monthInput()));
    expect(body.max_output_tokens).toBe(MAX_OUTPUT_TOKENS);
    expect(body.store).toBe(false);
    expect(body.text.format.type).toBe("json_schema");
    expect(body.text.format.strict).toBe(true);
    expect(body.text.format).toEqual({ type: "json_schema", name: "digest_plan", strict: true, schema: JSON.parse(JSON.stringify(PLAN_SCHEMA)) });
  });

  it("gives the model the digest without scores", () => {
    const content = userContent(monthInput());
    expect(content.startsWith("Here is this period's digest.\n<digest>\n")).toBe(true);
    expect(content.endsWith("\n</digest>\nReturn the plan.")).toBe(true);
    const digest = JSON.parse(content.split("\n")[2]!);
    expect(Object.keys(digest)).toEqual(["kind", "facts", "highlights", "sections", "themes", "defaults", "limits"]);
    expect(digest.limits).toEqual(LIMITS);
    expect(digest.highlights).toHaveLength(4);
    expect(content).not.toContain('"score"');
    expect(digest.highlights[0]).toEqual({ ...monthInput().highlights[0], score: undefined });
  });

  it("uses a strict-mode schema built from the contract", () => {
    const objects: Array<Record<string, any>> = [];
    const walk = (s: any): void => {
      if (s && typeof s === "object") {
        if (s.type === "object") objects.push(s);
        Object.values(s).forEach(walk);
      }
    };
    walk(PLAN_SCHEMA);
    expect(objects).toHaveLength(2);
    for (const o of objects) {
      expect(o.additionalProperties).toBe(false);
      expect([...o.required].sort()).toEqual(Object.keys(o.properties).sort());
    }
    const item = PLAN_SCHEMA.properties.sections.items.properties;
    expect(item.insight).toEqual({ type: ["string", "null"] });
    expect(item.id.enum).toEqual([...BASE_SECTION_IDS, ...HIGHLIGHT_KINDS.map((k) => `hl:${k}`)]);
    expect(PLAN_SCHEMA.properties.theme.enum).toEqual([...THEME_IDS]);
    expect(JSON.stringify(PLAN_SCHEMA)).not.toMatch(/maxLength|minLength|minimum|maximum|anyOf/);
  });
});

describe("planDigest", () => {
  it("uses a valid plan, counts the call and logs it", async () => {
    const { outcome, loads } = await plan(good);
    expect(outcome.status).toBe("used");
    expect(outcome.reason).toBeUndefined();
    expect(outcome.plan!.headline).toBe("Espresso all October");
    expect(outcome.plan!.sections[0]!.highlight?.kind).toBe("streak");
    expect(loads).toBe(1);
    expect(await calls()).toBe("1");

    const [line, planLine, ...rest] = entries();
    expect(rest).toEqual([]);
    expect(line).toEqual({
      job: JOB,
      editor: "used",
      model: "gpt-6.1-sol",
      ms: expect.any(Number),
      inputTokens: 2400,
      outputTokens: 900,
      theme: "halloween",
      sections: validPlan().sections.map((s) => s.id),
    });
    expect(planLine!.editor).toBe("plan");
    const logged = planLine!.plan as { headline: string; sections: object[] };
    expect(logged.headline).toBe("Espresso all October");
    expect(logged.sections[0]).toEqual({ id: "hl:streak", heading: "Twenty-two days straight", insight: "You played music **every day** from Oct 3 to Oct 24." });
  });

  const refusal = { output: [{ id: "msg_1", type: "message", role: "assistant", status: "completed", content: [{ type: "refusal", refusal: "I can't help with that." }] }] };
  it.each<[string, Respond, string | RegExp]>([
    ["a network error", () => Promise.reject(new TypeError("fetch failed")), "connection"],
    ["a server error", () => json({ error: { message: "boom", type: "server_error", code: null } }, 500), "api 500"],
    ["a rate limit", () => json({ error: { message: "slow down", type: "requests", code: "rate_limit_exceeded" } }, 429), "api 429"],
    ["a refusal", () => json(responseBody("", refusal)), "refusal"],
    ["running out of tokens", () => json(responseBody('{"theme":', { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } })), "incomplete:max_output_tokens"],
    ["a content filter", () => json(responseBody("", { status: "incomplete", incomplete_details: { reason: "content_filter" } })), "incomplete:content_filter"],
    ["a failed response", () => json(responseBody("", { status: "failed", error: { code: "server_error", message: "The model failed" } })), "error:The model failed"],
    ["no output text", () => json(responseBody("")), "error:no output text"],
    ["text that isn't JSON", () => json(responseBody("Sure! Here's your plan.")), "not json"],
    ["a body that isn't JSON", () => new Response("<html>bad gateway</html>"), /^error:/],
    ["an invalid plan", () => json(responseBody(JSON.stringify({ ...validPlan(), theme: "summer" }))), "theme not allowed: summer"],
  ])("falls back on %s", async (_name, respond, reason) => {
    const { outcome, calls: requests } = await plan(respond);
    expect(outcome.status).toBe("fallback");
    expect(outcome.plan).toBeNull();
    expect(outcome.reason).toMatch(reason);
    expect(requests).toHaveLength(1);
    expect(await calls()).toBe("1"); // counted before the call
    const [line, ...rest] = entries();
    expect(rest).toEqual([]); // no plan line
    expect(line).toMatchObject({ job: JOB, editor: "fallback", reason: outcome.reason, model: "gpt-6.1-sol" });
  });

  it("logs token usage for a refusal and error details for API errors", async () => {
    await plan(() => json(responseBody("", { output: [{ type: "message", content: [{ type: "refusal", refusal: "No." }] }] })));
    expect(entries()[0]).toMatchObject({ reason: "refusal", inputTokens: 2400, outputTokens: 900 });
    logs.length = 0;
    await plan(() => json({ error: { message: "Invalid schema for response_format 'digest_plan'", type: "invalid_request_error", param: "text.format.schema", code: null } }, 400), { maxRetries: 1 });
    expect(entries()[0]).toMatchObject({ reason: "api 400", detail: "invalid_request_error: Invalid schema for response_format 'digest_plan'" });
  });

  it("retries a 5xx once", async () => {
    const { outcome, calls: requests } = await plan((n) => (n === 0 ? json({ error: { message: "overloaded" } }, 503) : good(n, {})), { maxRetries: undefined });
    expect(outcome.status).toBe("used");
    expect(requests).toHaveLength(2);
    expect(await calls()).toBe("1"); // one planDigest, one count
  });

  it("retries a network error once", async () => {
    const { outcome, calls: requests } = await plan((n) => (n === 0 ? Promise.reject(new TypeError("fetch failed")) : good(n, {})), { maxRetries: 1 });
    expect(outcome.status).toBe("used");
    expect(requests).toHaveLength(2);
  });

  it("doesn't retry a 4xx", async () => {
    const { outcome, calls: requests } = await plan(() => json({ error: { message: "bad", type: "invalid_request_error" } }, 400), { maxRetries: 1 });
    expect(outcome.reason).toBe("api 400");
    expect(requests).toHaveLength(1);
  });

  it("times out (and doesn't retry a timeout)", async () => {
    const hang: Respond = (_n, init) =>
      new Promise((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError"))));
    const { outcome, calls: requests } = await plan(hang, { timeoutMs: 20, maxRetries: 1 });
    expect(outcome).toEqual({ status: "fallback", plan: null, reason: "timeout" });
    expect(requests).toHaveLength(1);
  });

  it("is off without a key, without loading or calling", async () => {
    for (const apiKey of [null, ""]) {
      const { outcome, calls: requests, loads } = await plan(good, { apiKey });
      expect(outcome).toEqual({ status: "off", plan: null, reason: "no key" });
      expect(requests).toHaveLength(0);
      expect(loads).toBe(0);
    }
    expect(await calls()).toBeNull();
    expect(entries()[0]).toEqual({ job: JOB, editor: "off", reason: "no key" });
  });

  it("is off with the kill switch", async () => {
    await setState(env.DB, "editor:mode", "off");
    const { outcome, calls: requests, loads } = await plan(good);
    expect(outcome).toEqual({ status: "off", plan: null, reason: "editor:mode off" });
    expect(requests).toHaveLength(0);
    expect(loads).toBe(0);
    expect(await calls()).toBeNull();

    await setState(env.DB, "editor:mode", "on");
    expect((await plan(good)).outcome.status).toBe("used");
  });

  it("stops at the monthly cap, counted per UTC month", async () => {
    expect(callsKey(NOW)).toBe("editor:calls:2026-11");
    await setState(env.DB, "editor:calls:2026-10", "10"); // last month's count doesn't apply
    await setState(env.DB, "editor:calls:2026-11", String(MAX_CALLS_PER_MONTH - 1));
    expect((await plan(good)).outcome.status).toBe("used");
    expect(await calls()).toBe("10");

    const capped = await plan(good);
    expect(capped.outcome).toEqual({ status: "fallback", plan: null, reason: "monthly cap" });
    expect(capped.calls).toHaveLength(0);
    expect(capped.loads).toBe(0);
    expect(await calls()).toBe("10");
  });

  it("falls back without throwing when loading the input fails", async () => {
    const f = fakeFetch(good);
    const load = async () => {
      throw new Error("D1 hiccup");
    };
    const outcome = await planDigest(env.DB, { apiKey: TEST_KEY, fetch: f.fetch }, { job: JOB, now: NOW, load });
    expect(outcome).toEqual({ status: "fallback", plan: null, reason: "error:D1 hiccup" });
    expect(f.calls).toHaveLength(0);
    expect(await calls()).toBeNull();
  });

  it("never logs the key", async () => {
    const key = "sk-proj-secret-XYZ";
    const wrongKey = () =>
      json({ error: { message: `Incorrect API key provided: ${key}. You can find your API key at https://platform.openai.com/account/api-keys.`, type: "invalid_request_error", code: "invalid_api_key" } }, 401);
    const denied = await plan(wrongKey, { apiKey: key });
    expect(denied.outcome.reason).toBe("api 401");
    expect(entries()[0]).toMatchObject({ reason: "api 401", detail: "invalid_api_key" });

    // Even if a key somehow came back in the model's output, the log line is redacted.
    await plan(() => json(responseBody(JSON.stringify({ ...validPlan(), theme: key }))), { apiKey: key });
    await plan(good, { apiKey: key });
    await plan(good);
    expect(logs.length).toBeGreaterThanOrEqual(5);
    expect(logs.join("\n")).not.toContain(key);
    expect(logs.join("\n")).not.toContain(TEST_KEY);
    expect(logs.join("\n")).toContain("[redacted]");
  });
});
