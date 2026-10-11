// Contract for the optional AI editor of the digests (tasks/ai-digest-plan.md in the main checkout).
// Code computes every number and chart; the model only picks sections/highlights, orders them,
// chooses a preset theme and writes short copy. Anything invalid falls back to the default email.

export type DigestKind = "month" | "week";
export const THEME_IDS = ["default", "winter-holidays", "halloween", "new-year", "summer"] as const;
export type ThemeId = (typeof THEME_IDS)[number];
export const HIGHLIGHT_KINDS = ["streak", "lateNight", "repeatDay", "binge", "comebackTrack", "comebackArtist", "genreShift", "newObsession"] as const;
export type HighlightKind = (typeof HIGHLIGHT_KINDS)[number];
export const BASE_SECTION_IDS = [
  "song",
  "alsoOnRepeat",
  "topArtists",
  "sound",
  "dayByDay",
  "whenYouListen",
  "year",
  "newToYou",
  "welcomeBack",
  "throwback",
  "week",
  "timeOfDay",
] as const;
export type BaseSectionId = (typeof BASE_SECTION_IDS)[number];
export type HighlightSectionId = `hl:${HighlightKind}`;
export type SectionId = BaseSectionId | HighlightSectionId;

/** pct = |rounded change|, an integer. */
export interface Pct {
  pct: number;
  direction: "up" | "down" | "same";
}
export interface NamedCount {
  name: string;
  plays: number;
}

/** What the model sees. Only code-computed values; every number copy may cite is precomputed and rounded here. */
export interface DigestFacts {
  period: { kind: DigestKind; label: string /* "September 2026" | "Sep 28 to Oct 4" */; days: number; previousLabel: string /* "August" | "last week" */ };
  totals: { plays: number; hours: number; tracks: number; artists: number; newTracks: number };
  change?: { plays?: Pct; hours?: Pct; newTracks?: Pct };
  topTracks: Array<{ rank: number; name: string; artists: string; plays: number }>;
  topArtists: Array<{ rank: number; name: string; plays: number; sharePct: number }>;
  genres?: Array<{ name: string; plays: number; sharePct: number }>;
  busiestDay?: { label: string /* "Tuesday, September 1" */; plays: number };
  peak?: { label: string /* "Mondays around 11 PM" | "10 PM" */ };
  newArtists?: NamedCount[];
  returningArtists?: Array<NamedCount & { lastHeardLabel: string }>;
  throwbacks?: Array<{ year: number; yearsAgo: number; name: string; artists: string; plays: number }>;
  /** Month only. */
  year?: { bestMonthLabel: string; bestMonthPlays: number; previousMonthLabel: string; change: Pct };
  split?: { oldFavoritesPct: number; newFindsPct: number };
}

export interface Highlight {
  id: HighlightSectionId;
  kind: HighlightKind;
  /** 0..1, code's ranking; never sent to the model, never citable. */
  score: number;
  /** The card's big number, e.g. { value: 23, unit: "days in a row" }. */
  stat: { value: number; unit: string };
  subject?: { type: "track" | "artist"; id: string; name: string; artists?: string };
  /** Everything copy may cite, pre-formatted labels included. */
  facts: Record<string, string | number>;
  /** Deterministic copy (may use **bold**). */
  defaultHeading: string;
  defaultInsight: string;
}

export interface SectionSpec {
  id: BaseSectionId;
  component: string;
  /** One-line description for the model. */
  shows: string;
  insightSlot: boolean;
  required: boolean;
  available: boolean;
  defaultHeading: string;
  defaultInsight: string | null;
}

export interface ThemeOption {
  id: ThemeId;
  label: string;
  mood: string;
}

export interface EditorInput {
  kind: DigestKind;
  facts: DigestFacts;
  /** Sorted by score, descending; at most 8. */
  highlights: Highlight[];
  /** In default order. */
  specs: SectionSpec[];
  /** Allowed this period: default + the seasonal theme. */
  themes: ThemeOption[];
  defaultTheme: ThemeId;
  defaults: { headline: string; lead: string; preheader: string };
}

export interface PlanSection {
  id: SectionId;
  heading: string;
  insight: string | null;
}
export interface LayoutPlan {
  theme: ThemeId;
  headline: string;
  lead: string;
  preheader: string;
  sections: PlanSection[];
}
export interface ResolvedSection extends PlanSection {
  highlight?: Highlight;
}
export interface ResolvedPlan extends Omit<LayoutPlan, "sections"> {
  sections: ResolvedSection[];
}

export type EditorStatus = "used" | "fallback" | "off";
export interface EditorOutcome {
  status: EditorStatus;
  plan: ResolvedPlan | null;
  reason?: string;
}

/** OpenAI Responses API settings. No key = editor off. `fetch` is injected by tests. */
export interface EditorConfig {
  apiKey: string | null;
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxRetries?: number;
}
