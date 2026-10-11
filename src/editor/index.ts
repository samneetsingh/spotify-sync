// The AI editor's entry point for the digest jobs: one model call per digest, validated strictly.
// Never throws. "off" = not enabled (AI_EDITOR), no key, or the kill switch; "fallback" = anything
// went wrong (the job sends the default email); "used" = a validated plan.
//
// Switches in `state`: `editor:mode` = "off" disables it; `editor:calls:<UTC YYYY-MM>` counts calls
// (incremented before each call, in every write mode) and caps them at MAX_CALLS_PER_MONTH.

import { getState, setState } from "../db/state";
import { EDITOR_MODEL, MAX_CALLS_PER_MONTH, callModel, type ModelResult } from "./client";
import { SYSTEM_PROMPT, userContent } from "./prompt";
import type { EditorConfig, EditorInput, EditorOutcome, EditorStatus, ResolvedPlan } from "./types";
import { validatePlan } from "./validate";

export { EDITOR_MODEL, MAX_CALLS_PER_MONTH } from "./client";

export const MODE_KEY = "editor:mode";
export const callsKey = (now: number) => `editor:calls:${new Date(now).toISOString().slice(0, 7)}`;

export interface PlanRequest {
  job: string;
  now: number;
  /** Builds the model's input; only called when the editor is on and under the cap. */
  load: () => Promise<EditorInput>;
}

export async function planDigest(db: D1Database, cfg: EditorConfig, req: PlanRequest): Promise<EditorOutcome> {
  let call: ModelResult | undefined;
  // Belt and braces: no log line may ever contain the key.
  const emit = (level: "log" | "warn", entry: object) => {
    const line = JSON.stringify(entry);
    console[level](cfg.apiKey ? line.replaceAll(cfg.apiKey, "[redacted]") : line);
  };
  const done = (status: EditorStatus, plan: ResolvedPlan | null, reason?: string): EditorOutcome => {
    emit(status === "fallback" ? "warn" : "log", {
      job: req.job,
      editor: status,
      reason,
      ...(call && {
        model: EDITOR_MODEL,
        ms: call.ms,
        inputTokens: call.usage?.inputTokens,
        outputTokens: call.usage?.outputTokens,
        detail: call.ok ? undefined : call.detail,
      }),
      theme: plan?.theme,
      sections: plan?.sections.map((s) => s.id),
    });
    if (plan) emit("log", { job: req.job, editor: "plan", plan: { ...plan, sections: plan.sections.map(({ highlight: _h, ...s }) => s) } });
    return reason === undefined ? { status, plan } : { status, plan, reason };
  };

  try {
    if (!cfg.enabled) return done("off", null, "disabled");
    if (!cfg.apiKey) return done("off", null, "no key");
    if ((await getState(db, MODE_KEY)) === "off") return done("off", null, `${MODE_KEY} off`);
    const key = callsKey(req.now);
    const calls = Number(await getState(db, key)) || 0;
    if (calls >= MAX_CALLS_PER_MONTH) return done("fallback", null, "monthly cap");

    const input = await req.load();
    await setState(db, key, String(calls + 1));
    call = await callModel(cfg, SYSTEM_PROMPT, userContent(input));
    if (!call.ok) return done("fallback", null, call.reason);

    let raw: unknown;
    try {
      raw = JSON.parse(call.text);
    } catch {
      return done("fallback", null, "not json");
    }
    const result = validatePlan(raw, input);
    return result.ok ? done("used", result.plan) : done("fallback", null, result.reason);
  } catch (err) {
    return done("fallback", null, `error:${err instanceof Error ? err.message : String(err)}`);
  }
}
