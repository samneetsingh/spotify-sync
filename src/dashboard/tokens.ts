// The "After hours" design tokens for the dashboard: a late-night listening
// room, deep blue-indigo with a warm apricot accent and mint for "ok". Contrast ratios in the
// comments are against the panel. The emails keep their own tokens (src/email/layout.ts).

/** Surfaces and text, AA-checked against the panel. */
export const COLOR = {
  ink: "#0f1020", // the page
  panelTop: "#181a30", // panel gradient, top to bottom
  panelBottom: "#15172a",
  raisedTop: "#2a2d4d", // controls: a gradient from raisedTop to raised
  raised: "#23264a",
  well: "#101225", // chart insets
  text: "#f2f1f8", // 15.2:1
  soft: "#b9bad3", // 9.0:1
  mute: "#8f91b3", // 5.6:1 (4.75:1 on raised)
  accent: "#ffb454", // apricot, 9.7:1
  onAccent: "#1f1405", // text on apricot, 10.3:1
  ok: "#5fe3b0", // mint: ok and up, 10.7:1
  bad: "#ff7b88", // coral: bad and down, 6.9:1
  second: "#a99cff", // lilac: a second chart series, 7.2:1
} as const;

/** Hairlines and translucent tints (pill, chip and notice backgrounds). */
export const LINE = "rgba(255,255,255,.06)";
export const LINE_STRONG = "rgba(255,255,255,.12)";
export const TINT = {
  ok: "rgba(95,227,176,.12)",
  warn: "rgba(255,180,84,.12)",
  bad: "rgba(255,123,136,.12)",
  neutral: "rgba(185,186,211,.08)",
} as const;

/** The depth recipe: panels, raised controls and inset wells. */
export const SHADOW = {
  panel: "inset 0 1px 0 rgba(255,255,255,.05),0 1px 2px rgba(0,0,0,.4),0 12px 32px -12px rgba(0,0,0,.6)",
  raised: "inset 0 1px 0 rgba(255,255,255,.08),0 2px 6px rgba(0,0,0,.4)",
  well: "inset 0 1px 3px rgba(0,0,0,.55),inset 0 0 0 1px rgba(0,0,0,.2)",
} as const;

/** Chart marks: bars (3.2:1 vs the well), the highlighted bar, and the heatmap steps low to high (never colour alone). */
export const CHART = {
  bar: "#5b5fa8",
  highlight: "#ffb454",
  heat: ["#2f3366", "#4c4592", "#8f5298", "#dc6b70", "#ffb454"],
  heatEmpty: "#1b1d36",
} as const;

/** Type scale as [font-size, line-height] in px; display sizes are Bricolage Grotesque, body is system sans. */
export const TYPE = {
  micro: [12, 16],
  meta: [14, 20],
  body: [16, 24],
  title: [18, 24], // widget titles, sentence case
  section: [24, 28],
  number: [36, 40], // big numbers, tabular figures
  hero: [48, 52], // the hero track
  heroPhone: [36, 40],
} as const satisfies Record<string, readonly [size: number, lineHeight: number]>;

/** `font-size:…;line-height:…` for a step of the type scale. */
export const ty = (step: keyof typeof TYPE): string => `font-size:${TYPE[step][0]}px;line-height:${TYPE[step][1]}px`;

/** Bricolage Grotesque (self-hosted, public/fonts) for display type and big numbers; the system sans for text. */
export const FONT = {
  display: `"Bricolage Grotesque",ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif`,
  body: `system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif`,
  mono: "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace",
} as const;

/** The display font file: the shell preloads it and styles/base.ts declares it. */
export const DISPLAY_FONT_URL = "/fonts/bricolage-grotesque-latin.woff2";

/** Spacing scale in px. */
export const SPACE = [4, 8, 12, 16, 24, 32, 48, 64] as const;

/** Corner radii in px by hierarchy; avatars are round (50%) and chips use `pill`. */
export const RADIUS = { panel: 20, tile: 12, cover: 8, cell: 3, pill: 999 } as const;
