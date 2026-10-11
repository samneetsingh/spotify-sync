// Strict checks on the model's plan, in order: shape, theme, sections, copy, number guard, resolve.
// The first failure wins and the digest falls back to the default email, so each reason names
// exactly what broke (e.g. `number: lead 1,600`) for tuning the prompt from the logs.

import { LIMITS } from "./prompt";
import type { EditorInput, Highlight, LayoutPlan, ResolvedPlan, ResolvedSection, SectionSpec } from "./types";

export type Validation = { ok: true; plan: ResolvedPlan } | { ok: false; reason: string };

class Invalid extends Error {}
function fail(reason: string): never {
  throw new Invalid(reason);
}

export function validatePlan(raw: unknown, input: EditorInput): Validation {
  try {
    return { ok: true, plan: check(raw, input) };
  } catch (err) {
    if (err instanceof Invalid) return { ok: false, reason: err.message };
    throw err;
  }
}

function check(raw: unknown, input: EditorInput): ResolvedPlan {
  // 1. Shape
  const plan = shape(raw);

  // 2. Theme
  if (!input.themes.some((t) => t.id === plan.theme)) fail(`theme not allowed: ${plan.theme}`);

  // 3. Sections
  const specs = new Map<string, SectionSpec>(input.specs.map((s) => [s.id, s]));
  const highlights = new Map<string, Highlight>(input.highlights.map((h) => [h.id, h]));
  const ids = plan.sections.map((s) => s.id as string);
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) fail(`duplicate section: ${id}`);
    seen.add(id);
  }
  for (const id of ids) {
    if (id.startsWith("hl:") ? !highlights.has(id) : !specs.get(id)?.available) fail(`unavailable section: ${id}`);
  }
  for (const s of input.specs) if (s.required && s.available && !seen.has(s.id)) fail(`missing required section: ${s.id}`);
  const song = ids.indexOf("song");
  if (song > 1) fail(`song position: ${song}`);
  const pickedCount = ids.filter((id) => id.startsWith("hl:")).length;
  if (pickedCount > LIMITS.maxHighlights[input.kind]) fail(`too many highlights: ${pickedCount}`);
  if (ids.length > LIMITS.maxSections[input.kind]) fail(`too many sections: ${ids.length}`);

  // 4. Copy. `written` collects the model's own strings for the number guard.
  const written: Array<{ field: string; text: string }> = [];
  const copy = (field: string, value: string, max: number, bold = false): string => {
    const text = value.trim();
    if (!text) fail(`copy: ${field} empty`);
    checkCopy(field, text, max, bold);
    written.push({ field, text });
    return text;
  };
  const headline = copy("headline", plan.headline, LIMITS.headline);
  const lead = copy("lead", plan.lead, LIMITS.lead);
  const preheader = copy("preheader", plan.preheader, LIMITS.preheader);
  const sections: ResolvedSection[] = plan.sections.map((s) => {
    const heading = copy(`heading ${s.id}`, s.heading, LIMITS.heading);
    const highlight = highlights.get(s.id);
    let insight: string | null;
    if (specs.get(s.id)?.insightSlot === false) insight = null; // no slot: dropped silently
    else if (s.insight === null || !s.insight.trim()) insight = highlight ? highlight.defaultInsight : null;
    else insight = copy(`insight ${s.id}`, s.insight, LIMITS.insight, true);
    return highlight ? { id: s.id, heading, insight, highlight } : { id: s.id, heading, insight };
  });

  // 5. Number guard
  const allowed = allowedNumbers(input, sections.flatMap((s) => (s.highlight ? [s.highlight] : [])));
  for (const { field, text } of written) {
    const problem = numberProblem(text, allowed);
    if (problem) fail(`${problem[0]}: ${field} ${problem[1]}`);
  }

  // 6. Resolve
  return { theme: plan.theme, headline, lead, preheader, sections };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function exactKeys(v: Record<string, unknown>, keys: string[], at: string): void {
  for (const k of keys) if (!Object.hasOwn(v, k)) fail(`shape: ${at}${k}`);
  for (const k of Object.keys(v)) if (!keys.includes(k)) fail(`shape: ${at}${k}`);
}

function shape(raw: unknown): LayoutPlan {
  if (!isRecord(raw)) fail("shape: plan");
  exactKeys(raw, ["theme", "headline", "lead", "preheader", "sections"], "");
  for (const k of ["theme", "headline", "lead", "preheader"]) if (typeof raw[k] !== "string") fail(`shape: ${k}`);
  const sections = raw.sections;
  if (!Array.isArray(sections) || sections.length === 0) fail("shape: sections");
  sections.forEach((s: unknown, i) => {
    const at = `sections[${i}]`;
    if (!isRecord(s)) fail(`shape: ${at}`);
    exactKeys(s, ["id", "heading", "insight"], `${at}.`);
    if (typeof s.id !== "string") fail(`shape: ${at}.id`);
    if (typeof s.heading !== "string") fail(`shape: ${at}.heading`);
    if (s.insight !== null && typeof s.insight !== "string") fail(`shape: ${at}.insight`);
  });
  return raw as unknown as LayoutPlan;
}

const FORBIDDEN = ["<", ">", "{", "}", "`", "http", "www.", "@", "#"];

function checkCopy(field: string, text: string, max: number, bold: boolean): void {
  const length = text.replaceAll("**", "").length;
  if (length > max) fail(`copy: ${field} too long (${length} > ${max})`);
  if (/[\p{Cc}\u2028\u2029]/u.test(text)) fail(`copy: ${field} control character`);
  const lower = text.toLowerCase();
  const bad = FORBIDDEN.find((f) => lower.includes(f));
  if (bad) fail(`copy: ${field} contains ${JSON.stringify(bad)}`);
  if (/\p{Extended_Pictographic}/u.test(text)) fail(`copy: ${field} emoji`);
  // Odd parts are bold phrases: balanced, at most two, non-empty, no other asterisks (nesting, italics).
  const parts = text.split("**");
  if (parts.length > 1 && !bold) fail(`copy: ${field} bold`);
  if (parts.length % 2 === 0 || parts.length > 5 || parts.some((p, i) => p.includes("*") || (i % 2 === 1 && !p.trim()))) {
    fail(`copy: ${field} bold`);
  }
}

// --- number guard

export interface Allowed {
  /** Every number in the facts and the picked highlights, plus digit tokens in their strings. */
  numbers: Set<number>;
  /** Values under keys ending in Pct/pct: the only numbers copy may write as a percentage. */
  pcts: Set<number>;
  /** Input strings (names, titles, labels): number and ratio words inside them aren't claims. */
  names: string[];
}

const NUMBER = /\d+(?:,\d{3})*(?:\.\d+)?/g;
const PERCENT = /(\d+(?:,\d{3})*(?:\.\d+)?)\s?(?:%|percent\b)/gi;
const RATIO = /\b(twice|double[ds]?|triple[ds]?|half|halved|quadruple[ds]?)\b/i;

const UNITS = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
const TEENS = ["ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
const WORD_VALUES = new Map<string, number>([
  ...UNITS.slice(1).map((w, i): [string, number] => [w, i + 2]), // "one" is too common to police
  ...TEENS.map((w, i): [string, number] => [w, i + 10]),
  ...TENS.map((w, i): [string, number] => [w, i * 10 + 20]),
  ["hundred", 100],
  ["thousand", 1000],
  ["dozen", 12],
]);
// "twenty-three" counts as 23, not as 20 and 3.
const NUMBER_WORDS = new RegExp(`\\b(?:(${TENS.join("|")})[- ](${UNITS.join("|")})|(${[...WORD_VALUES.keys()].join("|")}))\\b`, "gi");

/** Digit tokens in text ("1,564" -> 1564, "11 PM" -> 11). */
export function numbersIn(text: string): Array<{ raw: string; value: number }> {
  return [...text.matchAll(NUMBER)].map((m) => ({ raw: m[0], value: Number(m[0].replaceAll(",", "")) }));
}

/** What copy may cite: the facts plus the highlights the plan features (never ids or scores). */
export function allowedNumbers(input: EditorInput, picked: Highlight[]): Allowed {
  const out: Allowed = { numbers: new Set(), pcts: new Set(), names: [] };
  const add = (n: number, pct: boolean) => {
    if (!Number.isFinite(n)) return;
    out.numbers.add(n).add(Math.abs(n));
    if (pct) out.pcts.add(n).add(Math.abs(n));
  };
  const walk = (v: unknown, key: string): void => {
    if (key === "id" || key === "score") return;
    const pct = /pct$/i.test(key);
    if (typeof v === "number") add(v, pct);
    else if (typeof v === "string") {
      for (const { value } of numbersIn(v)) add(value, pct);
      if (/\p{L}/u.test(v)) out.names.push(v);
    } else if (Array.isArray(v)) for (const x of v) walk(x, key);
    else if (isRecord(v)) for (const [k, x] of Object.entries(v)) walk(x, k);
  };
  walk({ facts: input.facts, highlights: picked.map((h) => ({ stat: h.stat, facts: h.facts, subject: h.subject })) }, "");
  return out;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Text with input strings removed (whole words, exact case), so the artist "TWICE" or the song
 * "Seventeen Going Under" isn't read as a claim while "twice as much" still is.
 */
function withoutNames(text: string, names: string[]): string {
  let rest = text;
  for (const name of [...names].sort((a, b) => b.length - a.length)) {
    rest = rest.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(name)}(?![\\p{L}\\p{N}])`, "gu"), " ");
  }
  return rest;
}

/** [rule, offending token] for the first number the input doesn't back, or null. */
function numberProblem(text: string, allowed: Allowed): [string, string] | null {
  for (const { raw, value } of numbersIn(text)) if (!allowed.numbers.has(value)) return ["number", raw];
  for (const m of text.matchAll(PERCENT)) if (!allowed.pcts.has(Number(m[1]!.replaceAll(",", "")))) return ["percent", m[0]];
  const rest = withoutNames(text, allowed.names);
  for (const m of rest.matchAll(NUMBER_WORDS)) {
    const value = m[1] ? WORD_VALUES.get(m[1].toLowerCase())! + UNITS.indexOf(m[2]!.toLowerCase()) + 1 : WORD_VALUES.get(m[3]!.toLowerCase())!;
    if (!allowed.numbers.has(value)) return ["number word", m[0]];
  }
  const ratio = rest.match(RATIO);
  return ratio ? ["ratio", ratio[0]] : null;
}
