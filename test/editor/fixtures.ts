// Editor inputs, plans and fake OpenAI responses for the editor tests. Numbers are chosen so the
// guard tests are unambiguous: 50, 17, 19, 22 (outside the streak) and 1,600 appear nowhere.

import type { EditorInput, Highlight, LayoutPlan, SectionSpec } from "../../src/editor/types";

const spec = (id: SectionSpec["id"], component: string, shows: string, insightSlot: boolean, required: boolean, defaultHeading: string, available = true): SectionSpec => ({
  id,
  component,
  shows,
  insightSlot,
  required,
  available,
  defaultHeading,
  defaultInsight: insightSlot ? `Default insight for ${id}.` : null,
});

export function monthSpecs(): SectionSpec[] {
  return [
    spec("song", "feature", "The most played song with its cover", false, true, "Song of the month"),
    spec("alsoOnRepeat", "trackList", "Songs #2-5 with play counts", false, true, "Also on repeat"),
    spec("topArtists", "avatars", "Top artists with photos", false, true, "Your top artists"),
    spec("sound", "barList", "Genre shares", true, false, "Your sound"),
    spec("dayByDay", "columns", "Plays per day", true, false, "Day by day"),
    spec("whenYouListen", "heatmap", "Weekday x hour heatmap", true, false, "When you listen"),
    spec("year", "columns", "Plays per month this year", true, false, "Your year"),
    spec("newToYou", "split", "New artists and the old/new split", true, false, "New to you"),
    spec("welcomeBack", "artistList", "Artists back after a long break", true, false, "Welcome back"),
    spec("throwback", "captionedTracks", "Songs from past years", true, false, "Throwbacks", false),
  ];
}

export function weekSpecs(): SectionSpec[] {
  return [
    spec("song", "feature", "The most played song with its cover", false, true, "Song of the week"),
    spec("alsoOnRepeat", "trackList", "Songs #2-5 with play counts", false, true, "Also on repeat"),
    spec("topArtists", "avatars", "Top artists with photos", false, true, "Your top artists"),
    spec("newToYou", "split", "New artists and the old/new split", true, false, "New to you"),
    spec("week", "columns", "Plays per day, Monday to Sunday", true, false, "Your week"),
    spec("timeOfDay", "columns", "Plays per hour", true, false, "Time of day"),
  ];
}

export function highlights(): Highlight[] {
  return [
    {
      id: "hl:streak",
      kind: "streak",
      score: 0.73,
      stat: { value: 22, unit: "days in a row" },
      facts: { days: 22, startLabel: "Oct 3", endLabel: "Oct 24" },
      defaultHeading: "Every single day",
      defaultInsight: "You pressed play **22 days in a row**, Oct 3 to Oct 24.",
    },
    {
      id: "hl:comebackTrack",
      kind: "comebackTrack",
      score: 0.67,
      stat: { value: 9, unit: "plays" },
      subject: { type: "track", id: "9tQ48271xYzAbC", name: "Yellow", artists: "Coldplay" },
      facts: { plays: 9, lastHeardLabel: "May 2024", yearsAway: 2, track: "Yellow" },
      defaultHeading: "Back on repeat",
      defaultInsight: "**Yellow** is back: 9 plays, last heard in May 2024.",
    },
    {
      id: "hl:lateNight",
      kind: "lateNight",
      score: 0.6,
      stat: { value: 64, unit: "plays after midnight" },
      subject: { type: "track", id: "4uLU6hMCjMI", name: "Espresso", artists: "Sabrina Carpenter" },
      facts: { plays: 64, sharePct: 4, track: "Espresso", trackPlays: 9 },
      defaultHeading: "After midnight",
      defaultInsight: "**64 plays** after midnight, mostly Espresso.",
    },
    {
      id: "hl:binge",
      kind: "binge",
      score: 0.42,
      stat: { value: 4.5, unit: "hours straight" },
      facts: { minutes: 270, hours: 4.5, plays: 61, dayLabel: "Saturday, October 10", startLabel: "9 PM" },
      defaultHeading: "One long session",
      defaultInsight: "**4.5 hours straight** on Saturday, October 10, from 9 PM.",
    },
  ];
}

export function monthInput(): EditorInput {
  return {
    kind: "month",
    facts: {
      period: { kind: "month", label: "October 2026", days: 31, previousLabel: "September" },
      totals: { plays: 1564, hours: 82, tracks: 412, artists: 168, newTracks: 97 },
      change: { plays: { pct: 48, direction: "down" }, hours: { pct: 12, direction: "up" } },
      topTracks: [
        { rank: 1, name: "Espresso", artists: "Sabrina Carpenter", plays: 41 },
        { rank: 2, name: "Two Weeks", artists: "FKA twigs", plays: 33 },
        { rank: 3, name: "Lose My Mind", artists: "5 Seconds of Summer", plays: 29 },
        { rank: 4, name: "The Feels", artists: "TWICE", plays: 25 },
        { rank: 5, name: "Seventeen Going Under", artists: "Sam Fender", plays: 21 },
      ],
      topArtists: [
        { rank: 1, name: "Sabrina Carpenter", plays: 120, sharePct: 8 },
        { rank: 2, name: "TWICE", plays: 95, sharePct: 6 },
        { rank: 3, name: "5 Seconds of Summer", plays: 80, sharePct: 5 },
      ],
      genres: [
        { name: "pop", plays: 600, sharePct: 38 },
        { name: "k-pop", plays: 200, sharePct: 13 },
      ],
      busiestDay: { label: "Friday, October 16", plays: 87 },
      peak: { label: "Mondays around 11 PM" },
      newArtists: [{ name: "Chappell Roan", plays: 14 }],
      returningArtists: [{ name: "Coldplay", plays: 9, lastHeardLabel: "May 2024" }],
      year: { bestMonthLabel: "March", bestMonthPlays: 1820, previousMonthLabel: "September", change: { pct: 48, direction: "down" } },
      split: { oldFavoritesPct: 70, newFindsPct: 30 },
    },
    highlights: highlights(),
    specs: monthSpecs(),
    themes: [
      { id: "default", label: "Spotify green", mood: "neutral" },
      { id: "halloween", label: "Pumpkin", mood: "spooky, playful" },
    ],
    defaultTheme: "halloween",
    defaults: {
      headline: "Your month in music",
      lead: "1,564 plays over 82 hours. Your song of the month was Espresso.",
      preheader: "Your top songs and artists from October 2026.",
    },
  };
}

export function weekInput(): EditorInput {
  return { ...monthInput(), kind: "week", specs: weekSpecs() };
}

/** Valid for monthInput(): two highlights, the streak cited in words, a null highlight insight. */
export function validPlan(): LayoutPlan {
  return {
    theme: "halloween",
    headline: "Espresso all October",
    lead: "1,564 plays, 82 hours, and Espresso by Sabrina Carpenter on top with 41 plays.",
    preheader: "A streak, a comeback and the songs that ran your October.",
    sections: [
      { id: "hl:streak", heading: "Twenty-two days straight", insight: "You played music **every day** from Oct 3 to Oct 24." },
      { id: "song", heading: "Song of the month", insight: null },
      { id: "alsoOnRepeat", heading: "Also on repeat", insight: null },
      { id: "topArtists", heading: "Your top artists", insight: null },
      { id: "hl:comebackTrack", heading: "Yellow is back", insight: null },
      { id: "sound", heading: "Your sound", insight: "Pop took **38%** of your plays." },
      { id: "dayByDay", heading: "Day by day", insight: "Friday, October 16 was your busiest day with 87 plays." },
      { id: "newToYou", heading: "New to you", insight: "Chappell Roan was your best new find." },
    ],
  };
}

// --- fake OpenAI Responses API

export const TEST_KEY = "test-key";

/** A completed Responses API body whose message holds `text`. */
export function responseBody(text: string, over: Record<string, unknown> = {}) {
  return {
    id: "resp_1",
    object: "response",
    status: "completed",
    model: "gpt-6.1-sol",
    output: [
      { id: "rs_1", type: "reasoning", summary: [] },
      { id: "msg_1", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] },
    ],
    usage: { input_tokens: 2400, output_tokens: 900, total_tokens: 3300 },
    ...over,
  };
}

export const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** fetch that answers call n (0-based) with `respond(n)` and records every request. */
export function fakeFetch(respond: (n: number, init: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return respond(calls.length - 1, init ?? {});
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}
