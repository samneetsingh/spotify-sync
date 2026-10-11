// One structured-output call to OpenAI's Responses API with plain fetch (no SDK).
// Never throws: every failure becomes a short reason the caller logs before falling back.

import { PLAN_SCHEMA } from "./prompt";
import type { EditorConfig } from "./types";

export const EDITOR_MODEL = "gpt-6.1-sol";
export const MAX_CALLS_PER_MONTH = 10;
/** Reasoning tokens count against this too; the plan itself is ~1-2k tokens. */
export const MAX_OUTPUT_TOKENS = 16_000;
const API_URL = "https://api.openai.com/v1/responses";
const RETRY_DELAY_MS = 1_000;

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}
/** On failure, `detail` is OpenAI's error code/type (plus the message for a 400), for the logs. */
export type ModelResult =
  | { ok: true; text: string; usage: Usage; ms: number }
  | { ok: false; reason: string; ms: number; usage?: Usage; detail?: string };

interface ResponseBody {
  status?: string;
  incomplete_details?: { reason?: string } | null;
  error?: { message?: string } | null;
  output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>;
  usage?: { input_tokens?: number; output_tokens?: number };
}
interface ErrorBody {
  error?: { message?: string; type?: string; code?: string | null };
}

type Attempt = { status: number; body: string } | { failed: "timeout" | "connection" };

export async function callModel(cfg: EditorConfig, system: string, user: string): Promise<ModelResult> {
  const started = Date.now();
  const ms = () => Date.now() - started;
  const request = JSON.stringify({
    model: EDITOR_MODEL,
    instructions: system,
    input: user,
    max_output_tokens: MAX_OUTPUT_TOKENS,
    store: false,
    text: { format: { type: "json_schema", name: "digest_plan", strict: true, schema: PLAN_SCHEMA } },
  });
  try {
    const maxRetries = cfg.maxRetries ?? 1;
    let attempt = await post(cfg, request);
    // Retry 429/5xx/network (once by default); a timeout already waited long enough.
    for (let i = 0; i < maxRetries && retryable(attempt); i++) {
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      attempt = await post(cfg, request);
    }
    if ("failed" in attempt) return { ok: false, reason: attempt.failed, ms: ms() };
    if (attempt.status < 200 || attempt.status >= 300) {
      return { ok: false, reason: `api ${attempt.status}`, ms: ms(), detail: errorDetail(attempt.status, attempt.body) };
    }
    return readResponse(JSON.parse(attempt.body) as ResponseBody, ms());
  } catch (err) {
    return { ok: false, reason: `error:${err instanceof Error ? err.message : String(err)}`, ms: ms() };
  }
}

const retryable = (a: Attempt) => ("failed" in a ? a.failed === "connection" : a.status === 429 || a.status >= 500);

/** One request with its own timeout; the body is read before the timer stops. */
async function post(cfg: EditorConfig, body: string): Promise<Attempt> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs ?? 90_000);
  try {
    const res = await (cfg.fetch ?? fetch)(API_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}` },
      body,
      signal: controller.signal,
    });
    return { status: res.status, body: await res.text() };
  } catch {
    return { failed: controller.signal.aborted ? "timeout" : "connection" };
  } finally {
    clearTimeout(timer);
  }
}

function readResponse(body: ResponseBody, ms: number): ModelResult {
  const usage = { inputTokens: body.usage?.input_tokens ?? 0, outputTokens: body.usage?.output_tokens ?? 0 };
  const content = (body.output ?? []).filter((o) => o.type === "message").flatMap((o) => o.content ?? []);
  const failed = (reason: string): ModelResult => ({ ok: false, reason, ms, usage });
  if (content.some((c) => c.type === "refusal")) return failed("refusal");
  if (body.status === "incomplete") return failed(`incomplete:${body.incomplete_details?.reason ?? "unknown"}`);
  if (body.status !== "completed") return failed(`error:${body.error?.message ?? `status ${body.status}`}`);
  const text = content.flatMap((c) => (c.type === "output_text" && c.text ? [c.text] : [])).join("");
  if (!text) return failed("error:no output text");
  return { ok: true, text, usage, ms };
}

/** Error code/type only: a 401 message echoes part of the key. 400s keep the message (schema problems). */
function errorDetail(status: number, body: string): string | undefined {
  try {
    const e = (JSON.parse(body) as ErrorBody).error;
    const kind = e?.code || e?.type || undefined;
    return status === 400 && e?.message ? `${kind ?? "bad request"}: ${e.message.slice(0, 300)}` : kind;
  } catch {
    return undefined;
  }
}
