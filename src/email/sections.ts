// The digest's copy and middle sections, as a registry the AI editor (src/editor) can pick from,
// reorder and re-word. Code still computes every number and chart: from outside, a section only gets
// a heading and an optional insight sentence (`**bold**` allowed). Without a plan, defaultLayout()
// is the fixed email: every section with data, in the original order, with the original copy.

import type { BaseSectionId, DigestKind, Highlight, PlanSection, ResolvedSection, SectionSpec } from "../editor/types";
import type { RecapArtist, RecapTrack } from "../db/queries";
import type { DigestData } from "../jobs/digest";
import { addDays, type LocalDate } from "../utils/time";
import { artistList, avatars, axis, barList, captionedTracks, columns, feature, heatmap, split, trackList, type ArtistItem, type Tile, type TrackItem } from "./components";
import { C, T, TY, artistUrl, bold, card, cover, esc, fmt, insight, link, plays, section, trackUrl, unbold } from "./layout";
import { DEFAULT_TOKENS, type Tokens } from "./themes";

const utc = (opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-US", { ...opts, timeZone: "UTC" });
const dateMs = (d: LocalDate) => Date.UTC(d.year, d.month - 1, d.day);
const MONTH = utc({ month: "long" });
const MONTH_NARROW = utc({ month: "narrow" });
const SHORT = utc({ month: "short", day: "numeric" });
const LONG_DAY = utc({ weekday: "long", month: "long", day: "numeric" });
const WEEKDAY = utc({ weekday: "long" });
const WEEKDAYS = ["Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays", "Sundays"];
const hourLabel = (h: number) => `${h % 12 || 12} ${h < 12 ? "AM" : "PM"}`;
const toHours = (ms: number) => Math.round(ms / 3_600_000);
const pct = (now: number, before: number) => (before ? Math.round(((now - before) / before) * 100) : null);
const indexOfMax = (xs: number[]) => xs.reduce((best, x, i) => (x > xs[best]! ? i : best), 0);

const trackItem = (t: RecapTrack): TrackItem => ({ id: t.track_id, name: t.name ?? "Unknown track", artists: t.artists ?? "", plays: t.plays });
const artistItem = (a: RecapArtist): ArtistItem => ({ id: a.artist_id, name: a.name, plays: a.plays });

/** What sections render from: the data, the theme's tokens and a few derived values. */
export interface RenderCtx {
  d: DigestData;
  t: Tokens;
  month: boolean;
  unit: "month" | "week";
  /** Name of the period's (first) month, e.g. "September". */
  monthName: string;
  /** The period's last day. */
  last: LocalDate;
  top: TrackItem | null;
}

export function renderContext(d: DigestData, t: Tokens = DEFAULT_TOKENS): RenderCtx {
  const month = d.period.kind === "month";
  return {
    d,
    t,
    month,
    unit: month ? "month" : "week",
    monthName: MONTH.format(dateMs(d.period.start)),
    last: addDays(d.period.end, -1),
    top: d.topTracks[0] ? trackItem(d.topTracks[0]) : null,
  };
}

/** HTML rows plus the plain-text lines for the same block. */
export interface Block {
  html: string;
  text: string[];
}

// ---------------------------------------------------------------------------- hero, tiles, subject

/** The copy around the sections when there is no plan (also the editor's defaults). */
export function digestCopy(d: DigestData): { title: string; sub: string; label: string; lead: string; preheader: string; subject: string } {
  const { month, unit, monthName, last, top } = renderContext(d);
  const [title, sub] = month ? [monthName, String(d.period.start.year)] : [`${SHORT.format(dateMs(d.period.start))} to`, SHORT.format(dateMs(last))];
  const label = month ? `${monthName} ${d.period.start.year}` : `${title} ${sub}`;
  const hours = toHours(d.totals.ms);
  const topArtist = d.topArtists[0]?.name;
  const change = d.previous ? pct(d.totals.plays, d.previous.totals.plays) : null;
  const vsLast =
    change === null ? "" : Math.abs(change) < 5 ? ", about the same as last week" : `, ${Math.abs(change)}% ${change < 0 ? "less" : "more"} than last week`;
  const lead = [
    `${plays(d.totals.plays)}${vsLast}.`,
    top ? `${top.name} on repeat${topArtist ? `, ${topArtist} all ${unit}` : ""}.` : "",
  ].join(" ").trim();
  const subject = month ? `Your ${label} in music: ${plays(d.totals.plays)}` : `Your week in music, ${label}: ${plays(d.totals.plays)}`;
  const preheader = `${plays(d.totals.plays)} and ${fmt(hours)} hour${hours === 1 ? "" : "s"}.${top ? ` Song of the ${unit}: ${top.name}${top.artists ? ` by ${top.artists}` : ""}.` : ""}`;
  return { title, sub, label, lead, preheader, subject };
}

/** Hours, tracks, artists for a month; plays, hours, new tracks with changes for a week. */
export function statTiles(d: DigestData): Tile[] {
  const stat = (value: number, label: string, before?: number) => ({ value: fmt(value), label, delta: before === undefined ? undefined : pct(value, before) });
  const p = d.previous;
  return d.period.kind === "month"
    ? [stat(toHours(d.totals.ms), "hours"), stat(d.totals.tracks, "tracks"), stat(d.totals.artists, "artists")]
    : [
        stat(d.totals.plays, "plays", p?.totals.plays),
        stat(toHours(d.totals.ms), "hours", p ? toHours(p.totals.ms) : undefined),
        stat(d.newTrackCount, "new tracks", p?.newTrackCount),
      ];
}

// ---------------------------------------------------------------------------- the registry

interface SectionDef {
  component: string;
  /** One line for the model. */
  shows: string;
  insightSlot: boolean;
  required: boolean;
  heading: string | ((c: RenderCtx) => string);
  /** Whether there is data to show (sections without data are left out). */
  available: (d: DigestData) => boolean;
  /** The default sentence above the chart, if it has one. */
  insight?: (c: RenderCtx) => string;
  render: (c: RenderCtx, heading: string, insight: string | null) => Block;
}

const lead = (ins: string | null) => (ins ? insight(bold(ins)) : "");
const say = (ins: string | null) => (ins ? [`  ${unbold(ins)}`] : []);
const busiest = (d: DigestData) => indexOfMax(d.days);
const byHour = (d: DigestData) => Array.from({ length: 24 }, (_, h) => d.hours.reduce((sum, row) => sum + row[h]!, 0));

const SECTIONS: Record<BaseSectionId, SectionDef> = {
  song: {
    component: "feature",
    shows: "The most-played song: cover (on a vinyl record on phones), artists and play count",
    insightSlot: false,
    required: true,
    heading: (c) => `Song of the ${c.unit}`,
    available: (d) => d.topTracks.length > 0,
    render: ({ d, t, top }, heading) => ({
      html: feature(heading, top!, d.art[top!.id], d.discUrl ?? undefined, t),
      text: [`${heading}: ${top!.name}${top!.artists ? ` by ${top!.artists}` : ""} (${plays(top!.plays)})`],
    }),
  },
  alsoOnRepeat: {
    component: "trackList",
    shows: "Songs #2 to #5 with covers and play-count bars",
    insightSlot: false,
    required: true,
    heading: "Also on repeat",
    available: (d) => d.topTracks.length >= 2,
    render: ({ d, t, top }, heading) => {
      const rest = d.topTracks.slice(1).map(trackItem);
      return {
        html: trackList(heading, rest, d.art, 2, top!.plays, t),
        text: [heading, ...rest.map((x, i) => `  ${i + 2}. ${x.name}${x.artists ? ` — ${x.artists}` : ""} (${plays(x.plays)})`)],
      };
    },
  },
  topArtists: {
    component: "avatars",
    shows: "Top 5 artists with photos and play counts",
    insightSlot: false,
    required: true,
    heading: "Top artists",
    available: (d) => d.topArtists.length > 0,
    render: ({ d, t }, heading) => {
      const artists = d.topArtists.map(artistItem);
      return { html: avatars(heading, artists, d.art, t), text: [heading, ...artists.map((a, i) => `  ${i + 1}. ${a.name} (${plays(a.plays)})`)] };
    },
  },
  sound: {
    component: "barList",
    shows: "Top genres (of each play's main artist) as horizontal bars with play counts",
    insightSlot: true,
    required: false,
    heading: "Your sound",
    available: (d) => d.genres.length > 0,
    render: ({ d, t }, heading, ins) => ({
      html: section(heading, card(lead(ins) + barList(d.genres.map((g) => ({ label: g.genre, value: g.plays })), t))),
      text: [heading, ...say(ins), ...d.genres.map((g) => `  ${g.genre} (${plays(g.plays)})`)],
    }),
  },
  dayByDay: {
    component: "columns",
    shows: "Plays per day of the month as columns, the busiest day highlighted",
    insightSlot: true,
    required: false,
    heading: "Day by day",
    available: () => true,
    insight: ({ d }) => `Your biggest day was **${LONG_DAY.format(dateMs(addDays(d.period.start, busiest(d))))}**, with ${plays(d.days[busiest(d)]!)}.`,
    render: ({ d, t, last }, heading, ins) => {
      const ends = [d.period.start, addDays(d.period.start, 14), last].map((x) => SHORT.format(dateMs(x)));
      return { html: section(heading, card(lead(ins) + columns(d.days, { highlight: busiest(d) }, t) + axis(ends))), text: [heading, ...say(ins)] };
    },
  },
  whenYouListen: {
    component: "heatmap",
    shows: "Plays by weekday and hour as a 7 x 24 heatmap",
    insightSlot: true,
    required: false,
    heading: "When you listen",
    available: () => true,
    insight: ({ d }) => {
      const peak = indexOfMax(d.hours.flat());
      return `You listen most on **${WEEKDAYS[Math.floor(peak / 24)]} around ${hourLabel(peak % 24)}**.`;
    },
    render: ({ d, t }, heading, ins) => ({ html: section(heading, card(lead(ins) + heatmap(d.hours, t))), text: [heading, ...say(ins)] }),
  },
  year: {
    component: "columns",
    shows: "Plays per month over the last 12 months, this month highlighted",
    insightSlot: true,
    required: false,
    heading: "Your year",
    available: (d) => d.year.filter((m) => m.plays).length >= 2,
    insight: ({ d }) => {
      const prev = d.year.at(-2)!;
      const best = d.year[indexOfMax(d.year.map((m) => m.plays))]!;
      const diff = pct(d.totals.plays, prev.plays);
      const trend = diff === null ? "" : `, ${diff < 0 ? "down" : "up"} ${Math.abs(diff)}% from ${MONTH.format(dateMs(prev.month))}`;
      return `**${plays(d.totals.plays)}**${trend}. Your biggest month was **${MONTH.format(dateMs(best.month))}**.`;
    },
    render: ({ d, t }, heading, ins) => ({
      html: section(
        heading,
        card(
          lead(ins) +
            columns(d.year.map((m) => m.plays), { height: 72, highlight: 11, gap: 3 }, t) +
            axis(d.year.map((m) => MONTH_NARROW.format(dateMs(m.month)))),
        ),
      ),
      text: [heading, ...say(ins)],
    }),
  },
  newToYou: {
    component: "number + split + artistList",
    shows: "How many tracks were first listens, old favorites vs new finds as a split bar, and first-listen artists",
    insightSlot: true,
    required: false,
    heading: "New to you",
    available: (d) => d.newTrackCount > 0 || d.newArtists.length > 0,
    render: ({ d, t }, heading, ins) => {
      const newTracks = `track${d.newTrackCount === 1 ? "" : "s"} you'd never played before`;
      const artists = d.newArtists.map(artistItem);
      return {
        html: section(
          heading,
          card(
            lead(ins) +
              `<div style="${TY.number};color:${t.accent}">${fmt(d.newTrackCount)}</div><div style="${TY.body};color:${C.soft};margin-top:4px">${newTracks}</div>` +
              `<div style="margin:16px 0 ${artists.length ? 24 : 0}px">${split({ label: "old favorites", value: d.repeatPlays }, { label: "new finds", value: d.totals.plays - d.repeatPlays }, t)}</div>` +
              (artists.length ? `<div style="${TY.meta};color:${C.mute};margin-bottom:4px">First listens</div>${artistList(artists, d.art, undefined, t)}` : ""),
          ),
        ),
        text: [heading, ...say(ins), `  ${fmt(d.newTrackCount)} ${newTracks}`, ...artists.map((a) => `  - ${a.name} (first listen, ${plays(a.plays)})`)],
      };
    },
  },
  welcomeBack: {
    component: "artistList",
    shows: "Artists back after a year or more away, with when you last played them",
    insightSlot: true,
    required: false,
    heading: "Welcome back",
    available: (d) => d.returning.length > 0,
    render: ({ d, t }, heading, ins) => {
      const since = new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric", timeZone: d.timeZone });
      const note = (a: RecapArtist & { last_before_ms: number }) => `${plays(a.plays)}, first since ${since.format(a.last_before_ms)}`;
      const notes = (a: ArtistItem) => note(d.returning.find((r) => r.artist_id === a.id)!);
      return {
        html: section(heading, card(lead(ins) + artistList(d.returning.map(artistItem), d.art, notes, t))),
        text: [heading, ...say(ins), ...d.returning.map((a) => `  - ${a.name} (${note(a)})`)],
      };
    },
  },
  throwback: {
    component: "captionedTracks",
    shows: "Your top song in this month 1 and 5 years ago",
    insightSlot: true,
    required: false,
    heading: "Throwback",
    available: (d) => d.throwbacks.length > 0,
    render: ({ d, t, monthName }, heading, ins) => {
      const items = d.throwbacks.map((tb) => ({ caption: `${monthName} ${tb.year}`, track: trackItem(tb.track), note: `Your top song that month, ${plays(tb.track.plays)}` }));
      return {
        html: section(heading, card(lead(ins) + captionedTracks(items, d.art, t))),
        text: [heading, ...say(ins), ...items.map((i) => `  - ${i.caption}: ${i.track.name}${i.track.artists ? ` — ${i.track.artists}` : ""} (${i.note.toLowerCase()})`)],
      };
    },
  },
  week: {
    component: "columns",
    shows: "Plays per day, Monday to Sunday, the busiest day highlighted",
    insightSlot: true,
    required: false,
    heading: "Your week",
    available: () => true,
    insight: ({ d }) => `**${WEEKDAY.format(dateMs(addDays(d.period.start, busiest(d))))}** was your biggest day, with ${plays(d.days[busiest(d)]!)}.`,
    render: ({ d, t }, heading, ins) => ({
      html: section(heading, card(lead(ins) + columns(d.days, { height: 80, highlight: busiest(d), gap: 6 }, t) + axis(["M", "T", "W", "T", "F", "S", "S"]))),
      text: [heading, ...say(ins)],
    }),
  },
  timeOfDay: {
    component: "columns",
    shows: "Plays per hour of the day, the peak hour highlighted",
    insightSlot: true,
    required: false,
    heading: "Time of day",
    available: () => true,
    insight: ({ d }) => `Your peak hour was **${hourLabel(indexOfMax(byHour(d)))}**.`,
    render: ({ d, t }, heading, ins) => {
      const hours = byHour(d);
      return {
        html: section(heading, card(lead(ins) + columns(hours, { height: 64, highlight: indexOfMax(hours) }, t) + axis(["12 AM", "12 PM", "11 PM"]))),
        text: [heading, ...say(ins)],
      };
    },
  },
};

/** Each digest's sections in their default order. */
const ORDER: Record<DigestKind, BaseSectionId[]> = {
  month: ["song", "alsoOnRepeat", "topArtists", "sound", "dayByDay", "whenYouListen", "year", "newToYou", "welcomeBack", "throwback"],
  week: ["song", "alsoOnRepeat", "topArtists", "week", "timeOfDay", "newToYou"],
};

function copyOf(def: SectionDef, c: RenderCtx): { heading: string; insight: string | null } {
  const available = def.available(c.d);
  return { heading: typeof def.heading === "function" ? def.heading(c) : def.heading, insight: available && def.insight ? def.insight(c) : null };
}

/** A section's heading and insight sentence in the default email. */
export function defaultCopy(id: BaseSectionId, d: DigestData): { heading: string; insight: string | null } {
  return copyOf(SECTIONS[id], renderContext(d));
}

/** The catalog the editor chooses from, in default order. */
export function sectionSpecs(kind: DigestKind, d: DigestData): SectionSpec[] {
  const c = renderContext(d);
  return ORDER[kind].map((id) => {
    const def = SECTIONS[id];
    const copy = copyOf(def, c);
    return {
      id,
      component: def.component,
      shows: def.shows,
      insightSlot: def.insightSlot,
      required: def.required,
      available: def.available(d),
      defaultHeading: copy.heading,
      defaultInsight: copy.insight,
    };
  });
}

/** The default email's sections: every one with data, in order, with the default copy. */
export function defaultLayout(kind: DigestKind, d: DigestData): PlanSection[] {
  return sectionSpecs(kind, d)
    .filter((s) => s.available)
    .map((s) => ({ id: s.id, heading: s.defaultHeading, insight: s.defaultInsight }));
}

/**
 * One planned section. A null insight keeps the default sentence (charts) or the highlight's own;
 * insights on sections without a slot are ignored. Sections without data (or a highlight without its
 * object) render nothing.
 */
export function renderSection(c: RenderCtx, s: ResolvedSection): Block | null {
  if (s.id.startsWith("hl:")) return s.highlight ? highlightCard(c, s.highlight, s.heading, s.insight ?? s.highlight.defaultInsight) : null;
  const def = SECTIONS[s.id as BaseSectionId];
  if (!def?.available(c.d)) return null;
  return def.render(c, s.heading, def.insightSlot ? (s.insight ?? copyOf(def, c).insight) : null);
}

/** An extra card the editor found: the big number, the sentence, then the song or artist it's about. */
export function highlightCard(c: RenderCtx, h: Highlight, heading: string, ins: string | null): Block {
  const { d, t } = c;
  const subj = h.subject;
  let subject = "";
  if (subj) {
    const href = subj.type === "track" ? trackUrl(subj.id) : artistUrl(subj.id);
    subject = `<table ${T} style="margin-top:16px"><tr>
<td width="48" valign="middle">${link(href, cover(d.art[subj.id], subj.name, 48, subj.type === "track" ? "8px" : "50%", false, t))}</td>
<td valign="middle" style="padding-left:12px"><div style="${TY.body};font-weight:600">${link(href, esc(subj.name))}</div>${
      subj.artists ? `<div style="${TY.meta};color:${C.soft}">${esc(subj.artists)}</div>` : ""
    }</td></tr></table>`;
  }
  const html = section(
    heading,
    card(
      `<div style="${TY.number};color:${t.accent}">${fmt(h.stat.value)}</div><div style="${TY.body};color:${C.soft};margin-top:4px">${esc(h.stat.unit)}</div>` +
        (ins ? `<div style="${TY.body};color:${C.soft};margin-top:16px">${bold(ins)}</div>` : "") +
        subject,
    ),
  );
  const text = [
    heading,
    `  ${fmt(h.stat.value)} ${h.stat.unit}`,
    ...say(ins),
    ...(subj ? [`  ${subj.name}${subj.artists ? ` — ${subj.artists}` : ""}`] : []),
  ];
  return { html, text };
}
