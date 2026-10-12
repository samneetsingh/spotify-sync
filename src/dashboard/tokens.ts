// The dashboard's design tokens: a "glass" look on deep navy. Cards are lifted navy panels with a
// hairline edge, a top highlight and a soft shadow, blurred over two faint blue glows on a darker
// page; blue is the primary colour (buttons, active nav, chart bars), cyan the second series.
// Contrast ratios in the comments are against the card's lighter end. The emails keep their own
// tokens (src/email/layout.ts).

/** Surfaces and text, AA-checked against the card's lighter end (about #1b2246). */
export const COLOR = {
  ink: "#030c1d", // the page under the glows
  navy: "#0f1535", // inputs, the segmented control, tooltips
  raised: "#262e5e", // the current nav item, inactive nav icon squares, tags
  well: "rgba(255,255,255,.04)", // insets inside a card (empty states, error text)
  text: "#ffffff", // 15:1
  soft: "#a0aec0", // 6.7:1
  mute: "#8592a8", // 4.8:1
  blue: "#0075ff", // charts, icon tiles, active nav, focus
  blueFill: "#0069ea", // filled buttons: white text on it is 5:1 (#0075ff would be 4.2:1)
  cyan: "#2cd9ff", // the second series, gradients
  link: "#5ea8ff", // links in text, 6.2:1
  ok: "#01b574", // 5.7:1
  warn: "#ffb547", // 8.7:1
  bad: "#ee5d50", // 4.6:1
  danger: "#e31a1a", // the danger button's border and hover fill
} as const;

/** Hairlines and translucent tints (badge, chip and notice fills). */
export const LINE = "rgba(255,255,255,.08)";
export const LINE_STRONG = "rgba(226,232,240,.3)";
export const TINT = {
  ok: "rgba(1,181,116,.16)",
  warn: "rgba(255,181,71,.16)",
  bad: "rgba(238,93,80,.16)",
  blue: "rgba(0,117,255,.18)",
  neutral: "rgba(160,174,192,.12)",
} as const;

/**
 * The glass recipe: a lifted navy gradient blurred over the page's glows, with a hairline edge, a
 * faint top highlight and a soft shadow, so every panel reads clearly against the darker page.
 */
export const GLASS = {
  card: "linear-gradient(127.09deg,rgba(28,35,72,.95) 19.41%,rgba(18,24,54,.88) 76.65%)",
  blur: "-webkit-backdrop-filter:blur(60px);backdrop-filter:blur(60px)",
  edge: "border:1px solid rgba(255,255,255,.09);box-shadow:inset 0 1px 0 rgba(255,255,255,.05),0 8px 24px rgba(0,0,0,.35)",
  /** A divider that fades out at both ends. */
  divider: "linear-gradient(90deg,rgba(224,225,226,0),rgba(224,225,226,.3) 47%,rgba(224,225,226,0))",
} as const;

/** The page background's top colour: the canvas under the gradient and the browser's toolbar tint (theme-color). */
export const PAGE_TOP = "#0b1029";
/** The page background: two faint glows over a dark navy gradient (fixed, CSS only). */
export const PAGE_BACKGROUND =
  "radial-gradient(900px 600px at 88% -8%,rgba(0,117,255,.13),transparent 62%),radial-gradient(700px 520px at -6% 104%,rgba(67,24,255,.1),transparent 60%),linear-gradient(159deg,#0b1029 14%,#070a22 56%,#030c1d 86%)";

/**
 * Chart marks: the listening lines per year, this year first (cyan, with a fill underneath:
 * components/charts.tsx ChartDefs), then earlier years in quieter hues; and the heatmap steps low to
 * high (never colour alone): dim navy for a few plays, then muted amber, orange and red at the peak;
 * empty cells are darker than the card.
 */
export const CHART = {
  years: ["#2cd9ff", "#8b7dff", "#3ccf95", "#e0a45a", "#8592a8"],
  heat: ["#232e62", "#33447f", "#b8964f", "#c06f45", "#c2414f"],
  heatEmpty: "#0b1130",
} as const;

/** Type scale as [font-size, line-height] in px; one system sans throughout. */
export const TYPE = {
  micro: [12, 16],
  meta: [14, 20],
  body: [15, 22],
  title: [18, 24], // card titles, bold
  section: [22, 28],
  number: [24, 30], // stat values, tabular figures
  hero: [36, 42], // the hero track
  heroPhone: [28, 34],
} as const satisfies Record<string, readonly [size: number, lineHeight: number]>;

/** `font-size:…;line-height:…` for a step of the type scale. */
export const ty = (step: keyof typeof TYPE): string => `font-size:${TYPE[step][0]}px;line-height:${TYPE[step][1]}px`;

/** The system UI sans everywhere (no web fonts); monospace for errors. */
export const FONT = {
  sans: `-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,"Helvetica Neue",Arial,sans-serif`,
  mono: "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace",
} as const;

/** Corner radii in px: cards 20, inputs 15, buttons and icon tiles 12, badges 8. */
export const RADIUS = { card: 20, input: 15, control: 12, badge: 8, cover: 12, cell: 3 } as const;
