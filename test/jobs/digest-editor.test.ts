// The AI editor inside the digest jobs, end to end on a local D1 with a fake OpenAI (injected fetch):
// a valid plan changes the copy and layout, anything wrong sends exactly the default email.

import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getState } from "../../src/db/state";
import { migrate } from "../../src/db/schema";
import { loadHighlights } from "../../src/editor/highlights";
import { buildEditorInput } from "../../src/editor/input";
import type { EditorConfig, LayoutPlan } from "../../src/editor/types";
import { lastPeriod, loadDigest, runMonthlyRecap, runWeeklyDigest } from "../../src/jobs/digest";
import { TEST_KEY, fakeFetch, json, responseBody } from "../editor/fixtures";
import { resetDb } from "../parity/spotify-fixture";
import { TZ, artSource, config, days, fakeEmail, seed, type Sent } from "./digest-helpers";

const OCT_11 = Date.UTC(2026, 9, 11, 15); // recaps September 2026 (Los Angeles)
const NOV_2 = Date.UTC(2026, 10, 2, 15); // recaps October 2026: Halloween season
const OCT_7 = Date.UTC(2026, 9, 7, 15); // the last full week is Sep 28 - Oct 4
const F = [1, 2, 3, 4, 5];

/**
 * A month of five songs with 5 plays each (on alternate days, so no streak) and "Comeback", back
 * after 2024 with 3 plays: rank 6, so only its highlight card needs its cover.
 */
function month(prefix: "2026-09" | "2026-10", comebackName = "Comeback") {
  return [
    ...F.map((n) => ({ id: `f${n}`, name: `Filler ${n}`, artist: [`F${n}`, `Artist ${n}`] as [string, string], at: [10, 12, 14, 16, 18].map((d) => `${prefix}-${d}T18:00:00Z`) })),
    { id: "r", name: comebackName, artist: ["R1", "Returner"] as [string, string], at: [...days("2024-05", 1, 10), ...days(prefix, 2, 4)] },
  ];
}

/**
 * Sep 28 - Oct 4: This Week (the song of the week, also its new obsession) once a day except Friday,
 * Friday Song 4 times on Friday (a one-song day), so music every day; one play the week before.
 */
const WEEK = [
  { id: "w", name: "This Week", artist: ["W1", "Weekly"] as [string, string], at: ["09-28", "09-29", "09-30", "10-01", "10-03", "10-04"].map((d) => `2026-${d}T18:00:00Z`) },
  { id: "z", name: "Friday Song", artist: ["Z1", "Zed"] as [string, string], at: ["18:00", "18:10", "18:20", "18:30"].map((t) => `2026-10-02T${t}:00Z`) },
  { id: "p", name: "Last Week", artist: ["P1", "Prior"] as [string, string], at: ["2026-09-22T18:00:00Z"] },
];

/** Every chart with data (sound, year and throwback have none), reordered, plus one highlight. */
const MONTH_PLAN: LayoutPlan = {
  theme: "default",
  headline: "An old favorite returns",
  lead: "28 plays, and “Comeback” by Returner back on repeat.",
  preheader: "A comeback, plus the songs that ran your month",
  sections: [
    { id: "hl:comebackTrack", heading: "Back after a break", insight: null },
    { id: "song", heading: "Song of the month", insight: null },
    { id: "alsoOnRepeat", heading: "Close behind", insight: null },
    { id: "topArtists", heading: "Top artists", insight: null },
    { id: "welcomeBack", heading: "Welcome back", insight: "**Returner** is back in your rotation." },
    { id: "newToYou", heading: "New to you", insight: null },
    { id: "dayByDay", heading: "Day by day", insight: null },
    { id: "whenYouListen", heading: "When you listen", insight: null },
  ],
};

const WEEK_PLAN: LayoutPlan = {
  theme: "default",
  headline: "Friday on repeat",
  lead: "“This Week” led the week, but Friday belonged to “Friday Song”.",
  preheader: "One song, all day Friday",
  sections: [
    { id: "song", heading: "Song of the week", insight: null },
    { id: "hl:repeatDay", heading: "Friday, on a loop", insight: "You played **“Friday Song”** 4 times on Friday, October 2." },
    { id: "alsoOnRepeat", heading: "Also on repeat", insight: null },
    { id: "topArtists", heading: "Top artists", insight: null },
    { id: "week", heading: "Your week", insight: null },
    { id: "timeOfDay", heading: "Time of day", insight: null },
    { id: "newToYou", heading: "New to you", insight: null },
  ],
};

type Kind = "month" | "week";
const RUN = {
  month: { run: runMonthlyRecap, now: OCT_11, job: "monthly-recap", state: "recap:last_month", seed: () => seed(month("2026-09")), plan: MONTH_PLAN },
  week: { run: runWeeklyDigest, now: OCT_7, job: "weekly-digest", state: "recap:last_week", seed: () => seed(WEEK), plan: WEEK_PLAN },
};

/** An editor whose model answers `respond` (no retries). */
function editor(respond: Parameters<typeof fakeFetch>[0], over: Partial<EditorConfig> = {}) {
  const f = fakeFetch(respond);
  return { cfg: { enabled: true, apiKey: TEST_KEY, fetch: f.fetch, maxRetries: 0, ...over } as EditorConfig, calls: f.calls };
}
const answer = (plan: unknown) => () => json(responseBody(JSON.stringify(plan)));

/** Runs the digest live and returns what it sent (and the art lookups). */
async function send(kind: Kind, cfg?: EditorConfig, now = RUN[kind].now) {
  const { sent, cfg: alerts } = fakeEmail();
  const art = artSource();
  const result = await RUN[kind].run(config(), env.DB, art.sp, alerts, now, cfg);
  return { result, sent, artCalls: art.calls };
}

/** The default email for the period: the editor switched off. Clears the sent marker and the logs again. */
async function defaultEmail(kind: Kind, now = RUN[kind].now): Promise<Sent> {
  const { sent } = await send(kind, undefined, now);
  await env.DB.prepare("DELETE FROM state WHERE key = ?1").bind(RUN[kind].state).run();
  logs.length = 0;
  return sent[0]!;
}

let logs: string[];
const entries = () => logs.filter((l) => l.startsWith("{")).map((l) => JSON.parse(l) as Record<string, unknown>);
const editorLines = () => entries().filter((e) => "editor" in e && e.editor !== "plan");

beforeAll(() => migrate(env.DB));
beforeEach(async () => {
  await resetDb(env.DB);
  logs = [];
  for (const level of ["log", "warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logs.push(args.map(String).join(" ")));
  }
});
afterEach(() => vi.restoreAllMocks());

describe("buildEditorInput", () => {
  it("combines the facts, highlights, sections, themes and default copy", async () => {
    await seed(month("2026-09"));
    const data = (await loadDigest(env.DB, artSource().sp, lastPeriod("month", OCT_11, TZ), TZ))!;
    const input = await buildEditorInput(env.DB, data, TZ);
    expect(input.kind).toBe("month");
    expect(input.facts.totals.plays).toBe(28);
    expect(input.facts.period.label).toBe("September 2026");
    expect(input.highlights.map((h) => h.id)).toEqual(["hl:comebackTrack", "hl:comebackArtist"]);
    expect(input.highlights[0]!.subject).toMatchObject({ type: "track", id: "r", name: "Comeback" });
    expect(input.specs.map((s) => s.id)).toEqual(["song", "alsoOnRepeat", "topArtists", "sound", "dayByDay", "whenYouListen", "year", "newToYou", "welcomeBack", "throwback"]);
    expect(input.specs.filter((s) => !s.available).map((s) => s.id)).toEqual(["sound", "year", "throwback"]);
    expect(input.specs.every((s) => s.required === s.available)).toBe(true); // every chart with data stays
    expect(input.themes.map((t) => t.id)).toEqual(["default"]);
    expect(input.defaultTheme).toBe("default");
    expect(input.defaults).toEqual({
      headline: "September 2026",
      lead: "28 plays. Filler 1 on repeat, Artist 1 all month.",
      preheader: "28 plays and 0 hours. Song of the month: Filler 1 by Artist 1.",
    });
  });

  it("drops highlights about the song of the period (it has its own section)", async () => {
    await seed(WEEK);
    const data = (await loadDigest(env.DB, artSource().sp, lastPeriod("week", OCT_7, TZ), TZ))!;
    expect(data.topTracks[0]!.track_id).toBe("w");
    const all = await loadHighlights(env.DB, "week", data.period, TZ, data);
    expect(all.map((h) => [h.kind, h.subject?.id])).toEqual([["streak", undefined], ["newObsession", "w"], ["repeatDay", "z"]]);
    const input = await buildEditorInput(env.DB, data, TZ);
    expect(input.highlights.map((h) => h.kind)).toEqual(["streak", "repeatDay"]);
  });

  it("offers the seasonal theme", async () => {
    await seed(month("2026-10"));
    const data = (await loadDigest(env.DB, artSource().sp, lastPeriod("month", NOV_2, TZ), TZ))!;
    const input = await buildEditorInput(env.DB, data, TZ);
    expect(input.themes.map((t) => t.id)).toEqual(["default", "halloween"]);
    expect(input.defaultTheme).toBe("halloween");
  });
});

describe("with a valid plan", () => {
  it("monthly: the AI copy, order and highlight card go out; the subject doesn't change", async () => {
    await RUN.month.seed();
    const expected = await defaultEmail("month");
    const ai = editor(answer(MONTH_PLAN));
    const { result, sent, artCalls } = await send("month", ai.cfg);
    expect(result).toEqual({ period: "2026-09", sent: true });
    expect(ai.calls).toHaveLength(1);

    const [email] = sent;
    expect(email!.subject).toBe(expected.subject);
    expect(email!.subject).toBe("Your September 2026 in music: 28 plays");
    const html = email!.html!;
    expect(html).toContain("An old favorite returns<br><span");
    expect(html).toContain(">September 2026</span>"); // the period label under the headline
    expect(html).toContain("28 plays, and “Comeback” by Returner back on repeat.");
    expect(html).toContain("A comeback, plus the songs that ran your month"); // preheader
    expect(html).not.toContain("Song of the month: Filler 1 by Artist 1."); // the default preheader
    // The highlight card, with the comeback's cover fetched after planning (it isn't a top-5 song).
    expect(html).toContain("Back after a break");
    expect(html).toContain("years away");
    expect(html).toContain("https://i.test/r-300");
    expect(artCalls).toHaveLength(3);
    expect(artCalls.at(-1)).toBe("tracks:r");

    const text = email!.text;
    const order = MONTH_PLAN.sections.map((s) => text.indexOf(`\n${s.heading}`));
    expect(order.every((at) => at > 0)).toBe(true); // every chart, in the plan's order
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(text).toContain("Your month in music: September 2026\nAn old favorite returns\n28 plays, and “Comeback” by Returner back on repeat.");
    expect(text).toContain("Back after a break\n  2 years away\n  Comeback is back: 3 plays this month, your first since May 2024.\n  Comeback — Returner");
    expect(text).toContain("Welcome back\n  Returner is back in your rotation.");
    expect(editorLines()).toEqual([expect.objectContaining({ job: "monthly-recap", editor: "used", model: "gpt-6.1-sol", theme: "default" })]);
  });

  it("weekly: same, with the card's song already in the top tracks (no extra art call)", async () => {
    await RUN.week.seed();
    const expected = await defaultEmail("week");
    const ai = editor(answer(WEEK_PLAN));
    const { sent, artCalls } = await send("week", ai.cfg);
    const [email] = sent;
    expect(email!.subject).toBe(expected.subject);
    expect(email!.text).toContain("Your week in music: Sep 28 to Oct 4\nFriday on repeat\n“This Week” led the week, but Friday belonged to “Friday Song”.");
    expect(email!.text).toContain("Friday, on a loop\n  4 plays in one day\n  You played “Friday Song” 4 times on Friday, October 2.\n  Friday Song — Zed");
    expect(email!.html).toContain("One song, all day Friday");
    expect(email!.html).toContain("https://i.test/z-300");
    expect(artCalls).toHaveLength(2);
    const order = WEEK_PLAN.sections.map((s) => email!.text.indexOf(`\n${s.heading}`));
    expect(order.every((at) => at > 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
});

describe("falls back to exactly the default email", () => {
  it.each<[Kind, string, Parameters<typeof fakeFetch>[0], string]>([
    ["month", "text that isn't JSON", () => json(responseBody("Sure! Here's your plan.")), "not json"],
    ["month", "an API error", () => json({ error: { message: "boom", type: "server_error" } }, 500), "api 500"],
    ["month", "a plan that fails validation", answer({ ...MONTH_PLAN, lead: "1,600 plays and counting." }), "number: lead 1,600"],
    ["month", "a theme not offered this month", answer({ ...MONTH_PLAN, theme: "halloween" }), "theme not allowed: halloween"],
    ["month", "a plan that drops a chart", answer({ ...MONTH_PLAN, sections: MONTH_PLAN.sections.filter((x) => x.id !== "whenYouListen") }), "missing required section: whenYouListen"],
    ["week", "a highlight about the song of the week", answer({ ...WEEK_PLAN, sections: [...WEEK_PLAN.sections, { id: "hl:newObsession", heading: "New", insight: null }] }), "unavailable section: hl:newObsession"],
    ["week", "text that isn't JSON", () => json(responseBody("{")), "not json"],
    ["week", "an API error", () => json({ error: { message: "bad key", type: "invalid_request_error", code: "invalid_api_key" } }, 401), "api 401"],
  ])("%s: %s", async (kind, _name, respond, reason) => {
    await RUN[kind].seed();
    const expected = await defaultEmail(kind);
    const ai = editor(respond);
    const { sent } = await send(kind, ai.cfg);
    expect(ai.calls).toHaveLength(1);
    expect(sent).toEqual([expected]);
    expect(editorLines()).toEqual([expect.objectContaining({ job: RUN[kind].job, editor: "fallback", reason })]);
  });

  it("when the edited email would be too big for Gmail (measured in UTF-8 bytes)", async () => {
    // 10,000 three-byte characters, shown three times in the card: ~90 KB of UTF-8 but only ~30k characters.
    await seed(month("2026-09", "音".repeat(10_000)));
    const expected = await defaultEmail("month");
    const ai = editor(answer(MONTH_PLAN));
    const { sent } = await send("month", ai.cfg);
    expect(sent).toEqual([expected]);
    const lines = editorLines();
    expect(lines.map((l) => [l.editor, l.reason])).toEqual([["used", undefined], ["fallback", "size"]]);
    expect(lines[1]!.bytes).toBeGreaterThan(100_000);
  });
});

describe("modes and switches", () => {
  it("dry_run never sends but still asks the model (the preview path)", async () => {
    await RUN.month.seed();
    const { sent, cfg: alerts } = fakeEmail();
    const ai = editor(answer(MONTH_PLAN));
    expect(await runMonthlyRecap(config("dry_run"), env.DB, artSource().sp, alerts, OCT_11, ai.cfg)).toEqual({ period: "2026-09", sent: false });
    expect(sent).toEqual([]);
    expect(ai.calls).toHaveLength(1);
    expect(await getState(env.DB, "recap:last_month")).toBeNull();
    expect(await getState(env.DB, "editor:calls:2026-10")).toBe("1"); // the cap counts every call
    expect(logs.some((l) => l.includes("An old favorite returns<br>"))).toBe(true); // the logged HTML
  });

  it("live sends once, with one model call", async () => {
    await RUN.week.seed();
    const ai = editor(answer(WEEK_PLAN));
    const first = await send("week", ai.cfg);
    expect(first.sent).toHaveLength(1);
    const again = await send("week", ai.cfg, OCT_7 + 86_400_000);
    expect(again.result).toBeNull();
    expect(again.sent).toEqual([]);
    expect(ai.calls).toHaveLength(1);
    expect(await getState(env.DB, "recap:last_week")).toBe("2026-W40");
  });

  it.each<[string, Partial<EditorConfig>, string]>([
    ["no key", { apiKey: null }, "no key"],
    ["AI_EDITOR not on, even with a key", { enabled: false }, "disabled"],
  ])("is off without calling the model: %s", async (_name, over, reason) => {
    await RUN.month.seed();
    const expected = await defaultEmail("month");
    const ai = editor(answer(MONTH_PLAN), over);
    const { sent } = await send("month", ai.cfg);
    expect(ai.calls).toHaveLength(0);
    expect(sent).toEqual([expected]);
    expect(editorLines()).toEqual([{ job: "monthly-recap", editor: "off", reason }]);
  });
});

describe("seasonal theme", () => {
  it("applies without the editor: an October recap is in Halloween colours", async () => {
    await seed(month("2026-10"));
    const { sent } = await send("month", undefined, NOV_2);
    const html = sent[0]!.html!;
    expect(html).toContain("Spooky season");
    expect(html).toContain("#ff8a1f");
    expect(html).not.toContain("#1ed760");
    expect(editorLines()).toEqual([{ job: "monthly-recap", editor: "off", reason: "disabled" }]);
  });

  it("the plan's theme wins when the editor picks one", async () => {
    await seed(month("2026-10"));
    const ai = editor(answer(MONTH_PLAN));
    const { sent } = await send("month", ai.cfg, NOV_2);
    const html = sent[0]!.html!;
    expect(html).toContain("An old favorite returns");
    expect(html).toContain("#1ed760");
    expect(html).not.toContain("Spooky season");
  });
});
