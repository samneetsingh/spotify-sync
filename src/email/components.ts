// Email components: the blocks the digests and alerts are assembled from. Each returns HTML (one or
// more table rows for page-level blocks, a fragment for the rest). Inputs are raw strings; every
// component escapes what it prints.
//
// Layout rules from the design audit: grids wrap (inline-block tiles), list-shaped content stays a
// list at every width, and sizes don't change between phone and desktop except where WIDE upgrades them.
// Digest blocks take the theme's Tokens as their last argument (default: green); alert blocks aren't themed.

import { C, MONO, T, TY, artistUrl, card, cover, esc, link, meter, plays, section, trackUrl } from "./layout";
import { DEFAULT_TOKENS, type Tokens } from "./themes";

export interface TrackItem {
  id: string;
  name: string;
  artists: string;
  plays: number;
}

export interface ArtistItem {
  id: string;
  name: string;
  plays: number;
}

/** Image URLs by Spotify track or artist id. */
export type Art = Record<string, string | undefined>;

// ---------------------------------------------------------------------------- page blocks

/** Gradient header in the theme's hero colours: small kicker, two-line display title (second line darker), one-line story. */
export function hero(kicker: string, title: string, sub: string, lead: string, t: Tokens = DEFAULT_TOKENS): string {
  const h = t.hero;
  return `<tr><td class="g hero" bgcolor="${h.stops[0]}" style="padding:32px 20px;background-color:${h.stops[0]};background-image:linear-gradient(150deg,${h.stops[0]} 0%,${h.stops[1]} 55%,${h.stops[2]} 100%);color:${h.title}">
<div style="${TY.meta};font-weight:700;color:${h.kicker}">${esc(kicker)}</div>
<div class="d" style="${TY.display};color:${h.title};margin-top:12px">${esc(title)}<br><span style="color:${h.sub}">${esc(sub)}</span></div>
<div style="${TY.body};font-weight:600;color:${h.lead};margin-top:24px">${esc(lead)}</div>
</td></tr>`;
}

export interface Tile {
  value: string;
  label: string;
  /** Percent change from the previous period; shown as "↓ 48%". */
  delta?: number | null;
}

/**
 * Stat tiles that stay side by side at every width (short labels keep them from wrapping). They are
 * the row's own cells, so they share one height even when a label wraps on a narrow phone.
 */
export function tiles(items: Tile[]): string {
  const tile = ({ value, label, delta }: Tile) =>
    `<td width="${Math.floor(96 / items.length)}%" valign="top" class="p" bgcolor="${C.raised}" style="background:${C.raised};border-radius:16px;padding:16px">
<div style="${TY.number}">${esc(value)}</div><div style="${TY.meta};color:${C.soft};margin-top:4px">${esc(label)}</div>
${delta == null ? "" : `<div style="${TY.micro};color:${C.mute};margin-top:4px">${delta < 0 ? "&#8595;" : "&#8593;"} ${Math.abs(delta)}%</div>`}</td>`;
  return `<tr><td class="g" style="padding:24px 20px 0"><table ${T}><tr>${items.map(tile).join('<td width="2%" style="font-size:0">&nbsp;</td>')}</tr></table></td></tr>`;
}

/**
 * A vinyl record with the cover as its label. The record itself (grooves, sheen, rim, label gloss,
 * spindle hole, shadow) is one pre-rendered transparent PNG with a see-through label (see
 * scripts/vinyl.html); the cover is the cell's background, sized and placed under that window.
 * Clients without background images show a dark label, which still reads as a record.
 */
function vinyl(discUrl: string, coverUrl: string | undefined, name: string, href: string): string {
  const bg = coverUrl ? ` url('${esc(coverUrl)}') no-repeat 65px 57px / 86px 86px` : "";
  return link(
    href,
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center"><tr>
<td width="216" height="216" bgcolor="${C.raised}" style="width:216px;height:216px;background:${C.raised}${bg}">
<img src="${esc(discUrl)}" width="216" height="216" alt="${esc(name)}" style="display:block;width:216px;height:216px;border:0"></td></tr></table>`,
  );
}

/**
 * Song of the week/month. Phones: a centered record (wrapped layouts read oddly left-aligned).
 * Wide screens: the cover beside left-aligned text. Without `discUrl` phones get a centered cover.
 */
export function feature(title: string, track: TrackItem, coverUrl: string | undefined, discUrl?: string, t: Tokens = DEFAULT_TOKENS): string {
  const href = trackUrl(track.id);
  const text = (align: string) => `<div style="${TY.number};text-align:${align}">${link(href, esc(track.name))}</div>
<div style="${TY.body};color:${C.soft};margin-top:4px;text-align:${align}">${esc(track.artists)}</div>
<div style="margin-top:12px;text-align:${align}"><span style="display:inline-block;background:${t.accent};color:${t.onAccent};${TY.meta};font-weight:700;border-radius:999px;padding:4px 12px">${plays(track.plays)}</span></div>`;
  const art = discUrl ? vinyl(discUrl, coverUrl, track.name, href) : link(href, cover(coverUrl, track.name, 136, "12px", true, t));
  const phone = `<div class="fm">${art}<div style="margin-top:${discUrl ? 4 : 20}px">${text("center")}</div></div>`;
  const wide = `<div class="fw" style="display:none"><table ${T}><tr>
<td width="136" valign="middle">${link(href, cover(coverUrl, track.name, 136, "12px", false, t))}</td>
<td valign="middle" style="padding-left:20px">${text("left")}</td></tr></table></div>`;
  return section(title, card(phone + wide));
}

/** Ranked tracks: rank, cover, then title / artist / meter with the count, stacked. */
export function trackList(title: string, tracks: TrackItem[], art: Art, firstRank: number, max: number, t: Tokens = DEFAULT_TOKENS): string {
  const row = (x: TrackItem, i: number) => `<tr>
<td width="24" valign="middle" style="${TY.meta};font-weight:700;color:${C.mute};padding:8px 0">${i + firstRank}</td>
<td width="48" valign="middle" style="padding:8px 0">${link(trackUrl(x.id), cover(art[x.id], x.name, 48, "8px", false, t))}</td>
<td valign="middle" style="padding:8px 0 8px 12px">
<div style="${TY.body};font-weight:600">${link(trackUrl(x.id), esc(x.name))}</div>
<div style="${TY.meta};color:${C.soft}">${esc(x.artists)}</div>
<table ${T} style="margin-top:8px"><tr><td>${meter(x.plays / max, 4, t)}</td><td width="1" style="${TY.micro};color:${C.soft};padding-left:8px;white-space:nowrap">${plays(x.plays)}</td></tr></table>
</td></tr>`;
  return section(title, `<table ${T}>${tracks.map(row).join("")}</table>`);
}

/** Artist photos in 100px tiles that wrap: 5 in a row on desktop, 3 + 2 at 390px, 2 + 2 + 1 at 320px. */
export function avatars(title: string, artists: ArtistItem[], art: Art, t: Tokens = DEFAULT_TOKENS): string {
  const tile = (x: ArtistItem) => `<div style="display:inline-block;vertical-align:top;width:100px;padding-bottom:16px;text-align:center">
${link(artistUrl(x.id), cover(art[x.id], x.name, 72, "50%", true, t))}
<div style="${TY.meta};font-weight:600;margin-top:8px;padding:0 4px">${link(artistUrl(x.id), esc(x.name))}</div>
<div style="${TY.micro};color:${C.mute}">${plays(x.plays)}</div></div>`;
  return section(title, `<div style="font-size:0;text-align:center">${artists.map(tile).join("")}</div>`);
}

/** Artists as a compact list (photo, name, count). */
export function artistList(artists: ArtistItem[], art: Art, note?: (a: ArtistItem) => string, t: Tokens = DEFAULT_TOKENS): string {
  return `<table ${T}>${artists
    .map(
      (x) => `<tr><td width="40" style="padding:6px 0">${link(artistUrl(x.id), cover(art[x.id], x.name, 40, "50%", false, t))}</td>
<td style="${TY.body};font-weight:600;padding:6px 0 6px 12px">${link(artistUrl(x.id), esc(x.name))}</td>
<td align="right" style="${TY.meta};color:${C.soft};white-space:nowrap;padding-left:8px">${esc(note ? note(x) : plays(x.plays))}</td></tr>`,
    )
    .join("")}</table>`;
}

/** Tracks with a small caption above each title, divided by hairlines (throwbacks). */
export function captionedTracks(items: Array<{ caption: string; track: TrackItem; note: string }>, art: Art, t: Tokens = DEFAULT_TOKENS): string {
  return items
    .map(({ caption, track: x, note }, i) => {
      const top = i ? 12 : 0;
      return `<table ${T} style="${i ? `border-top:1px solid ${C.line};margin-top:12px;` : ""}"><tr>
<td width="56" valign="top" style="padding-top:${top}px">${link(trackUrl(x.id), cover(art[x.id], x.name, 56, "8px", false, t))}</td>
<td valign="top" style="padding:${top}px 0 0 12px">
<div style="${TY.micro};font-weight:700;color:${t.accent}">${esc(caption)}</div>
<div style="${TY.body};font-weight:600;margin-top:2px">${link(trackUrl(x.id), esc(x.name))}</div>
<div style="${TY.meta};color:${C.soft}">${esc(x.artists)}</div>
<div style="${TY.micro};color:${C.mute};margin-top:4px">${esc(note)}</div>
</td></tr></table>`;
    })
    .join("");
}

/** Links to the playlists the Worker keeps updating. */
export function playlistPills(links: Array<{ name: string; url: string }>): string {
  if (!links.length) return "";
  return `<tr><td class="g" style="padding:40px 20px 0">
<div style="border-top:1px solid ${C.line};padding-top:24px;${TY.meta};color:${C.soft};margin-bottom:12px">Still updating in your library</div>
<div style="font-size:0">${links
    .map(
      (l) =>
        `<a href="${esc(l.url)}" style="display:inline-block;border:1px solid ${C.line};border-radius:999px;padding:8px 16px;margin:0 8px 8px 0;${TY.meta};font-weight:600;color:${C.text};text-decoration:none">${esc(l.name)}</a>`,
    )
    .join("")}</div>
</td></tr>`;
}

/** Bottom padding of the card; always the last row. */
export const cardEnd = `<tr><td style="padding:32px 0 0;font-size:0;line-height:0">&nbsp;</td></tr>`;

// ---------------------------------------------------------------------------- charts

/** Vertical bars; the highlighted one in the accent, the rest dim, empty ones a grey stub. */
export function columns(values: number[], opts: { height?: number; highlight?: number; gap?: number } = {}, t: Tokens = DEFAULT_TOKENS): string {
  const { height = 88, highlight = -1, gap = 1 } = opts;
  const max = Math.max(1, ...values);
  const bars = values.map((n, i) => {
    const h = n ? Math.max(3, Math.round((n / max) * height)) : 2;
    const color = !n ? C.empty : i === highlight ? t.accent : t.accentDim;
    return `<td valign="bottom" height="${height}" style="padding:0 ${gap}px"><div style="height:${h}px;background:${color};border-radius:2px 2px 1px 1px;font-size:0;line-height:0">&nbsp;</div></td>`;
  });
  return `<table ${T} style="table-layout:fixed"><tr>${bars.join("")}</tr></table>`;
}

/** Labels under a chart, in their own row so they never sit in 8px cells. Three labels: left, center, right. */
export function axis(labels: string[]): string {
  const align = (i: number) => (labels.length === 3 ? ["left", "center", "right"][i] : "center");
  return `<table ${T} style="table-layout:fixed;margin-top:8px"><tr>${labels
    .map((l, i) => `<td align="${align(i)}" style="${TY.micro};color:${C.mute};white-space:nowrap">${esc(l)}</td>`)
    .join("")}</tr></table>`;
}

/** 7 x 24 grid, rows Monday..Sunday; cells 9px tall on phones, 15px on wide screens (close to square at both). */
export function heatmap(grid: number[][], t: Tokens = DEFAULT_TOKENS): string {
  const max = Math.max(1, ...grid.flat());
  const shade = (n: number) => (n ? t.scale[Math.min(4, Math.ceil((n / max) * 5) - 1)] : C.empty);
  const rows = grid.map(
    (row, d) =>
      `<tr><td class="hc" width="16" height="9" style="font-size:10px;line-height:9px;height:9px;color:${C.mute}">${"MTWTFSS"[d]}</td>${row
        .map((n) => `<td class="hc" height="9" style="height:9px;background:${shade(n)};border-radius:2px;font-size:0;line-height:0">&nbsp;</td>`)
        .join("")}</tr>`,
  );
  const ticks = `<tr><td></td>${["12 AM", "6 AM", "12 PM", "6 PM"]
    .map((l) => `<td colspan="6" style="${TY.micro};color:${C.mute};padding-top:6px;white-space:nowrap">${l}</td>`)
    .join("")}</tr>`;
  const legend = `<div style="${TY.micro};color:${C.mute};margin-top:12px">Fewer plays ${t.scale.map(
    (c) => `<span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${c};vertical-align:-1px"></span>`,
  ).join(" ")} More plays</div>`;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="2" border="0" style="table-layout:fixed">${rows.join("")}${ticks}</table>${legend}`;
}

/** Labelled horizontal bars: name and count on one line, the bar full width under it. */
export function barList(items: Array<{ label: string; value: number }>, t: Tokens = DEFAULT_TOKENS): string {
  const max = Math.max(1, ...items.map((i) => i.value));
  return items
    .map(
      (i, k) => `<table ${T} style="margin-top:${k ? 12 : 0}px"><tr>
<td style="${TY.meta};font-weight:600">${esc(i.label)}</td><td align="right" style="${TY.micro};color:${C.soft}">${plays(i.value)}</td></tr>
<tr><td colspan="2" style="padding-top:6px">${meter(i.value / max, 8, t)}</td></tr></table>`,
    )
    .join("");
}

/** Two-part proportion bar with a legend that wraps instead of squeezing. */
export function split(left: { label: string; value: number }, right: { label: string; value: number }, t: Tokens = DEFAULT_TOKENS): string {
  const lp = Math.round((left.value / Math.max(1, left.value + right.value)) * 100);
  const key = (color: string, text: string) =>
    `<div style="display:inline-block;${TY.meta};color:${C.soft};margin:8px 16px 0 0"><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${color}"></span> ${esc(text)}</div>`;
  const part = (w: number, color: string, radius: string) =>
    w ? `<td width="${w}%" height="12" bgcolor="${color}" style="background:${color};border-radius:${radius};font-size:0;line-height:0">&nbsp;</td>` : "";
  return `<table ${T}><tr>${part(lp, t.accentDim, lp === 100 ? "6px" : "6px 0 0 6px")}${part(100 - lp, t.accent, lp === 0 ? "6px" : "0 6px 6px 0")}</tr></table>
<div style="font-size:0">${key(t.accentDim, `${lp}% ${left.label}`)}${key(t.accent, `${100 - lp}% ${right.label}`)}</div>`;
}

// ---------------------------------------------------------------------------- alerts

/** Alert statuses, plus `setup` and `connected` for the account emails (src/emails/account.ts). */
export type Status = "failing" | "recovered" | "notice" | "setup" | "connected";

const STATUS: Record<Status, { label: string; color: string; bg: string }> = {
  failing: { label: "Failing", color: C.red, bg: "#3a1418" },
  recovered: { label: "Recovered", color: C.green, bg: "#10301d" },
  notice: { label: "Heads up", color: C.amber, bg: "#3a2a0c" },
  setup: { label: "Almost ready", color: C.amber, bg: "#3a2a0c" },
  connected: { label: "Connected", color: C.green, bg: "#10301d" },
};

/** Status pill, title and lead paragraph at the top of an alert. */
export function alertHeader(status: Status, title: string, lead: string): string {
  const s = STATUS[status];
  return `<tr><td class="g" style="padding:32px 20px 0">
<span style="display:inline-block;background:${s.bg};color:${s.color};${TY.micro};font-weight:700;border-radius:999px;padding:4px 12px">&#9679; ${s.label}</span>
<div style="${TY.number};margin-top:16px">${esc(title)}</div>
<div style="${TY.body};color:${C.soft};margin-top:8px">${esc(lead)}</div>
</td></tr>`;
}

/** A big green button with a note under it. */
export function actionButton(label: string, url: string, note: string): string {
  return `<tr><td class="g" style="padding:24px 20px 0">
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="${C.green}" style="background:${C.green};border-radius:999px">
<a href="${esc(url)}" style="display:inline-block;padding:14px 28px;${TY.body};font-weight:700;color:#000;text-decoration:none">${esc(label)}</a></td></tr></table>
<div style="${TY.meta};color:${C.mute};margin-top:12px">${esc(note)}</div>
</td></tr>`;
}

/** Label / value rows between hairlines. */
export function facts(rows: Array<[string, string]>): string {
  return `<tr><td class="g" style="padding:24px 20px 0"><table ${T} style="border-top:1px solid ${C.line};border-bottom:1px solid ${C.line}">${rows
    .map(([k, v]) => `<tr><td width="112" valign="top" style="${TY.meta};color:${C.mute};padding:8px 0">${esc(k)}</td><td style="${TY.meta};padding:8px 0">${esc(v)}</td></tr>`)
    .join("")}</table></td></tr>`;
}

/** A labelled monospace block (error messages). */
export function codeBlock(label: string, text: string): string {
  return `<tr><td class="g" style="padding:24px 20px 0">
<div style="${TY.meta};color:${C.mute};margin-bottom:8px">${esc(label)}</div>
<div style="background:#0d0d0d;border:1px solid ${C.line};border-radius:12px;padding:12px 16px;font-family:${MONO};${TY.meta};color:#ffb4bc;word-break:break-word">${esc(text)}</div>
</td></tr>`;
}

/** A plain paragraph of small print. */
export const smallPrint = (text: string) => `<tr><td class="g" style="padding:24px 20px 0;${TY.meta};color:${C.mute}">${esc(text)}</td></tr>`;

