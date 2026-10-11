// Colour themes for the digests. Surfaces and text never change; a theme only swaps the accent (bars,
// pills, numbers), the heatmap scale and the hero. Every preset passes themeProblems() (WCAG contrast).
// The digest picks the seasonal theme for its period (or the AI editor picks one of themeOptions()).

import { THEME_IDS, type ThemeId, type ThemeOption } from "../editor/types";
import type { LocalDate } from "../utils/time";

/** Colours every theme shares: the dark surfaces and the text on them. */
export const SURFACES = {
  page: "#0a0a0a",
  card: "#141414",
  raised: "#1c1c1c",
  line: "#2a2a2a",
  empty: "#242424",
  text: "#ffffff",
  soft: "#b3b3b3",
  mute: "#8e8e8e", // >= 4.5:1 on both card surfaces
  red: "#ff5c6c",
} as const;

export interface Tokens {
  page: string;
  card: string;
  raised: string;
  line: string;
  empty: string;
  text: string;
  soft: string;
  mute: string;
  red: string;
  /** Highlighted bars, meters, pills, big numbers. */
  accent: string;
  /** The other bars and the placeholder-art tile. */
  accentDim: string;
  /** Text on an accent background. */
  onAccent: string;
  /** Heatmap steps, darkest to brightest; the last one is the accent. */
  scale: readonly [string, string, string, string, string];
  /** Header gradient (150deg, 0% / 55% / 100%) and its four text colours. */
  hero: { stops: readonly [string, string, string]; kicker: string; title: string; sub: string; lead: string };
}

export interface Theme {
  id: ThemeId;
  label: string;
  mood: string;
  /** Replaces "Your month in music" in the hero. */
  kicker: string | null;
  /** A text symbol before the kicker. */
  ornament: string | null;
  colors: Pick<Tokens, "accent" | "accentDim" | "onAccent" | "scale" | "hero">;
}

const GREEN = {
  accent: "#1ed760",
  accentDim: "#1f5a39",
  onAccent: "#000",
  scale: ["#1b3a28", "#1f5a39", "#178a45", "#19b04f", "#1ed760"],
} as const;

/** Text-presentation symbols only (U+FE0E keeps iOS from drawing emoji). */
export const ORNAMENTS = ["❄︎", "☾", "✦", "☀︎"] as const;

export const THEMES: Record<ThemeId, Theme> = {
  default: {
    id: "default",
    label: "Spotify green",
    mood: "neutral",
    kicker: null,
    ornament: null,
    colors: { ...GREEN, hero: { stops: ["#1ed760", "#19bd55", "#14a64b"], kicker: "#03280f", title: "#000", sub: "#0b4a25", lead: "#04230f" } },
  },
  "winter-holidays": {
    id: "winter-holidays",
    label: "Holiday red",
    mood: "festive, cozy",
    kicker: "Happy holidays",
    ornament: "❄︎",
    colors: { ...GREEN, hero: { stops: ["#ff6b6b", "#f25757", "#e04646"], kicker: "#2b0005", title: "#000", sub: "#2b0005", lead: "#1f0004" } },
  },
  halloween: {
    id: "halloween",
    label: "Pumpkin",
    mood: "spooky, playful",
    kicker: "Spooky season",
    ornament: "☾",
    colors: {
      accent: "#ff8a1f",
      accentDim: "#7a4518",
      onAccent: "#000",
      scale: ["#4a2e14", "#7a4518", "#a8561a", "#d46d12", "#ff8a1f"],
      hero: { stops: ["#ffa040", "#ff8a1f", "#f07a10"], kicker: "#3d1a00", title: "#000", sub: "#4a2200", lead: "#2a1200" },
    },
  },
  "new-year": {
    id: "new-year",
    label: "Gold",
    mood: "celebratory",
    kicker: "Happy new year",
    ornament: "✦",
    colors: {
      accent: "#f5c242",
      accentDim: "#655320",
      onAccent: "#000",
      scale: ["#3a321a", "#655320", "#9a7a22", "#d4a52e", "#f5c242"],
      hero: { stops: ["#ffe08a", "#f5c242", "#e0a92a"], kicker: "#3d2c00", title: "#000", sub: "#4a3600", lead: "#2a1e00" },
    },
  },
  summer: {
    id: "summer",
    label: "Pool aqua",
    mood: "sunny",
    kicker: "Summer listening",
    ornament: "☀︎",
    colors: {
      accent: "#3fd8e0",
      accentDim: "#1a5559",
      onAccent: "#000",
      scale: ["#173a3c", "#1a5559", "#1f8a90", "#2ab3ba", "#3fd8e0"],
      hero: { stops: ["#6ee6ea", "#3fd8e0", "#22bcc6"], kicker: "#003a3e", title: "#000", sub: "#00474c", lead: "#002629" },
    },
  },
};

const TOKENS = Object.fromEntries(THEME_IDS.map((id) => [id, { ...SURFACES, ...THEMES[id].colors }])) as Record<ThemeId, Tokens>;

export const tokensFor = (id: ThemeId): Tokens => TOKENS[id];
/** What components use when they aren't given tokens (alerts are never themed). */
export const DEFAULT_TOKENS = TOKENS.default;

/** Seasons by the period's last local day, inclusive ("MM-DD" ranges). */
const SEASONS: Array<[from: string, to: string, ThemeId]> = [
  ["01-01", "01-31", "new-year"],
  ["06-21", "08-31", "summer"],
  ["10-15", "11-01", "halloween"],
  ["12-01", "12-31", "winter-holidays"],
];

/** The theme for a period ending on `lastDay` when nobody picks one. */
export function seasonalTheme(lastDay: LocalDate): ThemeId {
  const md = `${String(lastDay.month).padStart(2, "0")}-${String(lastDay.day).padStart(2, "0")}`;
  return SEASONS.find(([from, to]) => md >= from && md <= to)?.[2] ?? "default";
}

/** The themes the editor may choose from: default, plus the seasonal one if there is one. */
export function themeOptions(lastDay: LocalDate): ThemeOption[] {
  return [...new Set<ThemeId>(["default", seasonalTheme(lastDay)])].map((id) => ({ id, label: THEMES[id].label, mood: THEMES[id].mood }));
}

/** WCAG relative luminance of "#rgb" or "#rrggbb". */
function luminance(hex: string): number {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? [...h].map((c) => c + c).join("") : h;
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(full.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/** WCAG contrast ratio (1..21), order-independent. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/** Why a theme isn't readable on the email's surfaces; empty when it is. */
export function themeProblems(theme: Theme): string[] {
  const { accent, accentDim, onAccent, scale, hero } = theme.colors;
  const problems: string[] = [];
  const need = (what: string, a: string, b: string, min: number) => {
    const ratio = contrast(a, b);
    if (!(ratio >= min)) problems.push(`${what} ${ratio.toFixed(2)} < ${min}`);
  };
  need("accent on card", accent, SURFACES.card, 4.5);
  need("accent on raised", accent, SURFACES.raised, 4.5);
  need("onAccent on accent", onAccent, accent, 4.5);
  need("accentDim on raised", accentDim, SURFACES.raised, 2);
  need("accent vs accentDim", accent, accentDim, 3);
  scale.slice(1).forEach((c, i) => {
    if (!(luminance(c) > luminance(scale[i]!))) problems.push(`scale[${i + 1}] not brighter than scale[${i}]`);
  });
  if (scale[4] !== accent) problems.push("scale[4] is not the accent");
  need("scale[0] vs empty", scale[0], SURFACES.empty, 1.2);
  hero.stops.forEach((stop, i) => {
    need(`hero kicker on stop ${i}`, hero.kicker, stop, 4.5);
    need(`hero lead on stop ${i}`, hero.lead, stop, 4.5);
    need(`hero title on stop ${i}`, hero.title, stop, 3);
    need(`hero sub on stop ${i}`, hero.sub, stop, 3);
  });
  if (theme.ornament !== null && !(ORNAMENTS as readonly string[]).includes(theme.ornament)) problems.push(`ornament not allowed: ${theme.ornament}`);
  return problems;
}
