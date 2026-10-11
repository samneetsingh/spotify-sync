// Email design system: tokens, the page shell and the small building blocks every email uses.
//
// Email HTML rules this follows (they are why the markup looks old-fashioned):
// - Tables for layout, inline styles everywhere; no SVG, no JS, no positioning.
// - Mobile-first: inline styles are the phone layout. The one <style> block only upgrades wide
//   screens (min-width: 640px), so clients that drop <style> still get a working email.
// - One type scale with fixed line heights (TY) and one spacing scale (4/8/12/16/20/24/32/40).
// - Keep a whole email under ~100 KB: Gmail clips anything over 102 KB.

export const C = {
  page: "#0a0a0a",
  card: "#141414",
  raised: "#1c1c1c",
  line: "#2a2a2a",
  empty: "#242424",
  text: "#ffffff",
  soft: "#b3b3b3",
  mute: "#8e8e8e", // >= 4.5:1 on both card surfaces
  green: "#1ed760",
  greenDim: "#1f5a39",
  red: "#ff5c6c",
  amber: "#f5a524",
} as const;

/** Heatmap steps, darkest to brightest. */
export const SCALE = ["#1b3a28", "#1f5a39", "#178a45", "#19b04f", "#1ed760"] as const;

export const FONT = "-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',Roboto,Helvetica,Arial,sans-serif";
export const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";

export const TY = {
  micro: "font-size:12px;line-height:16px",
  meta: "font-size:14px;line-height:20px",
  body: "font-size:16px;line-height:22px",
  heading: "font-size:20px;line-height:26px;font-weight:700",
  number: "font-size:28px;line-height:32px;font-weight:800;letter-spacing:-0.5px",
  display: "font-size:44px;line-height:46px;font-weight:900;letter-spacing:-1.5px",
} as const;

/** Attributes for a full-width layout table. */
export const T = 'role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"';

// Class names are short on purpose (every byte counts toward Gmail's clip limit):
// g = gutter, p = card padding, hero, d = display type, hc = heatmap cell, fm/fw = phone/wide variants.
const WIDE = `@media (min-width:640px){
.g{padding-left:40px!important;padding-right:40px!important}
.p{padding:20px!important}
.hero{padding-top:40px!important;padding-bottom:40px!important}
.d{font-size:56px!important;line-height:56px!important;letter-spacing:-2px!important}
.hc{height:15px!important;line-height:15px!important}
.fm{display:none!important}
.fw{display:block!important}
}`;

export const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
export const fmt = (n: number) => n.toLocaleString("en-US");
export const plays = (n: number) => `${fmt(n)} play${n === 1 ? "" : "s"}`;
export const trackUrl = (id: string) => `https://open.spotify.com/track/${id}`;
export const artistUrl = (id: string) => `https://open.spotify.com/artist/${id}`;
export const playlistUrl = (id: string) => `https://open.spotify.com/playlist/${id}`;

/** An unstyled link around already-escaped HTML. `href` must be a URL we built. */
export const link = (href: string, inner: string) => `<a href="${esc(href)}" style="color:inherit;text-decoration:none">${inner}</a>`;
/** Bold white text inside a soft sentence. */
export const strong = (s: string) => `<b style="color:${C.text};font-weight:700">${esc(s)}</b>`;

/** The whole email: preheader (inbox preview text), dark page, 600px card, footer line. */
export function shell(opts: { title: string; preheader: string; body: string }): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark"><meta name="supported-color-schemes" content="dark">
<title>${esc(opts.title)}</title><style>${WIDE}</style></head>
<body style="margin:0;padding:0;background:${C.page};font-family:${FONT};-webkit-font-smoothing:antialiased">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${esc(opts.preheader)}${"&#847;&zwnj;&nbsp;".repeat(60)}</div>
<table ${T} bgcolor="${C.page}" style="background:${C.page}"><tr><td align="center" style="padding:16px 8px 32px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.card}" style="width:100%;max-width:600px;background:${C.card};border-radius:24px;overflow:hidden;font-family:${FONT};color:${C.text};${TY.body}">
${opts.body}
</table>
<div style="${TY.micro};color:${C.mute};padding:16px 20px 0">Sent by spotify-sync from your Cloudflare Worker</div>
</td></tr></table>
</body></html>`;
}

/** A titled block of the email (one table row). */
export const section = (title: string, inner: string) =>
  `<tr><td class="g" style="padding:40px 20px 0"><div style="${TY.heading};margin-bottom:16px">${esc(title)}</div>${inner}</td></tr>`;

/** A raised surface for charts and highlights. */
export const card = (inner: string) =>
  `<table ${T}><tr><td class="p" bgcolor="${C.raised}" style="background:${C.raised};border-radius:16px;padding:16px">${inner}</td></tr></table>`;

/** The sentence that leads a chart; `html` is already escaped (use strong()). */
export const insight = (html: string) => `<div style="${TY.body};color:${C.soft};margin-bottom:16px">${html}</div>`;

/** A thin horizontal bar filled to `frac` (0..1). */
export const meter = (frac: number, h = 4) =>
  `<table ${T}><tr><td height="${h}" bgcolor="${C.line}" style="background:${C.line};border-radius:2px;font-size:0;line-height:0"><div style="width:${Math.max(2, Math.round(frac * 100))}%;height:${h}px;background:${C.green};border-radius:2px;font-size:0;line-height:0">&nbsp;</div></td></tr></table>`;

/** Album or artist art; a ♪ tile when there is none. */
export function cover(url: string | undefined, name: string, size: number, radius: string, center = false): string {
  if (url) {
    return `<img src="${esc(url)}" width="${size}" height="${size}" alt="${esc(name)}" style="display:block;${center ? "margin:0 auto;" : ""}width:${size}px;height:${size}px;border-radius:${radius};border:0">`;
  }
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0"${center ? ' align="center"' : ""}><tr><td width="${size}" height="${size}" align="center" bgcolor="${C.greenDim}" style="width:${size}px;height:${size}px;border-radius:${radius};background:${C.greenDim};color:${C.green};font-size:${Math.round(size / 2.4)}px;line-height:${size}px;font-weight:700">&#9834;</td></tr></table>`;
}
