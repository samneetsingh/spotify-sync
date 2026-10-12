// Home's charts, rendered on the server: no client JS and no `style=` attributes (the CSP blocks them),
// so SVG geometry goes in attributes and colour in classes (styles/home.ts). Every chart has an
// aria-label summary sentence and never uses colour alone: values are in the tooltips, the legend
// and the labels.
//
// LineChart: x positions are percentages of the chart's width and y is in pixels, so text never
// scales. The curves themselves are in a stretched viewBox (0..1000 wide, preserveAspectRatio=none)
// with non-scaling strokes, so they keep an even width at every chart width. Tooltips are CSS-only
// (:hover / :focus-visible on a focusable target per point, near its lines) and list every year's
// value and its dots (this year's latest point always has one). The legend
// (oldest year first) is a row of checkboxes: hovering a year brings its line forward and unticking
// hides it, through :has() in styles/home.ts; without :has() every line simply stays.

import type { Child } from "hono/jsx";
import { fmt } from "../../email/layout";
import { CHART } from "../tokens";
import { axisNumber, hourName, playsText, WEEKDAYS, WEEKDAYS_SHORT } from "./format";

/** A number for an SVG percentage attribute. */
const pct = (n: number) => `${Math.round(n * 1000) / 1000}%`;

/**
 * The page's shared SVG paint servers, rendered once per page: `#g-area`, the fill under this year's
 * line (styles/home.ts). Zero-sized but not display:none, which would stop browsers painting with it.
 */
export function ChartDefs() {
  return (
    <svg class="defs" width="0" height="0" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="g-area" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color={CHART.years[0]} stop-opacity="0.32" />
          <stop offset="1" stop-color={CHART.years[0]} stop-opacity="0" />
        </linearGradient>
      </defs>
    </svg>
  );
}

// ---------------------------------------------------------------------------- line chart

export interface LinePoint {
  /** The axis label, e.g. "Mon", "13" or "Oct". */
  label: string;
  /** The tooltip's title and the point's label, e.g. "Mon, Oct 6" or "October". */
  name: string;
  /** Today, or this month: a bold axis label. */
  highlight?: boolean;
  /** Show the axis label (default true); e.g. only every 7th day of a month. */
  tick?: boolean;
  /** Hide the axis label on phones (every other month of a year). */
  tickWide?: boolean;
}

export interface LineSeries {
  /** The legend's and tooltip's name, e.g. "2026". */
  label: string;
  /** One value per point; null = nothing to show yet (later this week, month or year). */
  values: Array<number | null>;
  /** The legend's total, e.g. "412 plays so far". */
  total: string;
}

export interface LineChartProps {
  /** Unique on the page: the legend's checkbox ids are `<id>-y<k>`. */
  id: string;
  points: LinePoint[];
  /** The first is this year's (bright, filled underneath); the others are drawn thinner behind it. At most CHART.years.length. */
  series: LineSeries[];
  /** The summary sentence (the chart's aria-label). */
  summary: string;
  /** After this year's value at a highlighted point, e.g. "so far". */
  note?: string;
  /** The chart's height in px (the plot, then the axis labels). */
  height?: number;
}

/** Chart geometry in px: the plot starts this far down (tooltips float over its top); the axis labels sit under it. */
const PLOT_TOP = 24;
const TIP_W = 172;
/** How far above and below a point's lines its hover target reaches, in px. */
const HIT = 20;
const ROW_H = 18;
/** The curves' viewBox width (the viewBox is stretched to the chart's width). */
const VB_W = 1000;

/**
 * The y scale: its top sits just above `max` (8% headroom, so the busiest point nearly fills the
 * plot), with round gridlines inside it: 0, step, 2*step... at most five, step being 1, 2, 2.5 or
 * 5 x 10^k (at least 1).
 */
export function niceScale(max: number): { top: number; ticks: number[] } {
  const top = Math.max(1, max) * 1.08;
  const raw = top / 4;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = Math.max(1, [1, 2, 2.5, 5, 10].map((s) => s * pow).find((s) => Math.floor(top / s) <= 4)!);
  return { top, ticks: Array.from({ length: Math.floor(top / step) + 1 }, (_, i) => i * step) };
}

const r1 = (n: number) => Math.round(n * 10) / 10;

/**
 * A smooth path through the points (x ascending): cubic segments with monotone tangents
 * (Fritsch-Carlson, as d3's curveMonotoneX), so the curve never overshoots a peak or dips below zero
 * between points.
 */
export function smoothPath(pts: Array<[x: number, y: number]>): string {
  const n = pts.length;
  if (!n) return "";
  const x = pts.map((p) => p[0]);
  const y = pts.map((p) => p[1]);
  let d = `M${r1(x[0]!)},${r1(y[0]!)}`;
  if (n === 1) return d;
  const dx = x.slice(1).map((v, i) => v - x[i]!);
  const m = dx.map((h, i) => (y[i + 1]! - y[i]!) / h);
  const t = x.map((_, i) => {
    if (i === 0) return m[0]!;
    if (i === n - 1) return m[n - 2]!;
    const [a, b] = [m[i - 1]!, m[i]!];
    if (a * b <= 0) return 0;
    const w1 = 2 * dx[i]! + dx[i - 1]!;
    const w2 = dx[i]! + 2 * dx[i - 1]!;
    return (w1 + w2) / (w1 / a + w2 / b);
  });
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i]! / 3;
    d += `C${r1(x[i]! + h)},${r1(y[i]! + h * t[i]!)} ${r1(x[i + 1]! - h)},${r1(y[i + 1]! - h * t[i + 1]!)} ${r1(x[i + 1]!)},${r1(y[i + 1]!)}`;
  }
  return d;
}

/** The runs of consecutive non-null values, as [index, value] pairs. */
function runs(values: Array<number | null>): Array<Array<[number, number]>> {
  const out: Array<Array<[number, number]>> = [];
  let run: Array<[number, number]> = [];
  values.forEach((v, i) => {
    if (v === null) {
      if (run.length) out.push(run);
      run = [];
    } else run.push([i, v]);
  });
  if (run.length) out.push(run);
  return out;
}

/** Plays per day or month, one smooth line per year: this year's bright and filled, earlier years thinner behind it. */
export function LineChart({ id, points, series, summary, note, height = 240 }: LineChartProps) {
  const H = height;
  const BASE = H - 32;
  const LABEL_Y = H - 10;
  const { top, ticks } = niceScale(Math.max(0, ...series.flatMap((s) => s.values.map((v) => v ?? 0))));
  const y = (v: number) => BASE - (v / top) * (BASE - PLOT_TOP);
  const n = Math.max(1, points.length);
  const slot = 100 / n;
  const center = (i: number) => (i + 0.5) * slot;
  const vx = (i: number) => (center(i) / 100) * VB_W;
  const valueText = (k: number, v: number, p: LinePoint) => `${playsText(v)}${k === 0 && p.highlight && note ? ` ${note}` : ""}`;
  const now = runs(series[0]?.values ?? []).at(-1)?.at(-1);
  const tipH = 30 + series.length * ROW_H;
  return (
    <figure class="chart chart-lines">
      <div class="lc" role="group" aria-label={summary}>
        <svg class="cc-y" width="44" height={H} aria-hidden="true">
          {ticks.map((t) => (
            <text x="36" y={y(t) + 4} text-anchor="end">
              {axisNumber(t)}
            </text>
          ))}
        </svg>
        <div class="lc-plot">
          <svg class="lc-grid" width="100%" height={H} aria-hidden="true">
            {ticks.map((t) => (
              <line class={t === 0 ? "base" : "grid"} x1="0" x2="100%" y1={y(t)} y2={y(t)} />
            ))}
            {points.map((p, i) =>
              p.tick === false ? null : (
                <text class={`tick${p.highlight ? " is-now" : ""}${p.tickWide ? " tick-wide" : ""}`} x={pct(center(i))} y={LABEL_Y} text-anchor="middle">
                  {p.label}
                </text>
              ),
            )}
          </svg>
          <svg class="lc-lines" width="100%" height={H} viewBox={`0 0 ${VB_W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
            {runs(series[0]?.values ?? []).map((run) => {
              const pts = run.map(([i, v]): [number, number] => [vx(i), y(v)]);
              return run.length > 1 ? <path class="area" d={`${smoothPath(pts)}L${r1(pts.at(-1)![0])},${BASE}L${r1(pts[0]![0])},${BASE}Z`} /> : null;
            })}
            {series
              .map((s, k) => ({ s, k }))
              .reverse()
              .flatMap(({ s, k }) =>
                runs(s.values).map((run) => <path class={`ln ln-${k}`} d={smoothPath(run.map(([i, v]) => [vx(i), y(v)]))} vector-effect="non-scaling-stroke" />),
              )}
          </svg>
          <svg class="lc-points" width="100%" height={H}>
            {now ? <circle class="dot-now" cx={pct(center(now[0]))} cy={r1(y(now[1]))} r="4.5" aria-hidden="true" /> : null}
            {points.map((p, i) => {
              // Oldest year first, like the legend.
              const rows = series.flatMap((s, k) => (s.values[i] === null || s.values[i] === undefined ? [] : [{ k, label: s.label, v: s.values[i]! }])).reverse();
              if (!rows.length) return null;
              const c = center(i);
              const tipX = c < 50 ? 12 : -(TIP_W + 12);
              // The hover target: this point's column, but only near its lines (HIT px above the
              // highest and below the lowest), not the whole height of the plot.
              const vals = rows.map((r) => r.v);
              const hitTop = r1(Math.max(PLOT_TOP - 8, y(Math.max(...vals)) - HIT));
              const hitBottom = r1(Math.min(BASE + 6, y(Math.min(...vals)) + HIT));
              return (
                <g class="pt" tabindex={0} role="img" aria-label={`${p.name}: ${rows.map((r) => `${r.label} ${valueText(r.k, r.v, p)}`).join(", ")}`}>
                  <rect class="pt-hit" x={pct(i * slot)} y={hitTop} width={pct(slot)} height={r1(hitBottom - hitTop)} />
                  <line class="tip tip-guide" x1={pct(c)} x2={pct(c)} y1={PLOT_TOP - 4} y2={BASE} aria-hidden="true" />
                  {rows.map((r) => (
                    <circle class={`dot dot-${r.k}`} cx={pct(c)} cy={r1(y(r.v))} r={r.k === 0 ? "3.5" : "3"} aria-hidden="true" />
                  ))}
                  <g class="tip" aria-hidden="true">
                    <svg x={pct(c)} y="0" width="1" height="1" overflow="visible">
                      <rect class="tip-box" x={tipX} y="0" width={TIP_W} height={tipH} rx="10" />
                      <text class="tip-name" x={tipX + 12} y="19">
                        {p.name}
                      </text>
                      {rows.map((r, j) => (
                        <g class={`row row-${r.k}`}>
                          <circle class={`dot dot-${r.k}`} cx={tipX + 16} cy={34 + j * ROW_H} r="4" />
                          <text class="tip-row" x={tipX + 26} y={38 + j * ROW_H}>
                            {r.label}
                          </text>
                          <text class="tip-value" x={tipX + TIP_W - 12} y={38 + j * ROW_H} text-anchor="end">
                            {`${fmt(r.v)}${r.k === 0 && p.highlight && note ? ` ${note}` : ""}`}
                          </text>
                        </g>
                      ))}
                    </svg>
                  </g>
                </g>
              );
            })}
          </svg>
        </div>
      </div>
      <fieldset class="lc-legend">
        <legend class="vh">Years shown</legend>
        {series
          .map((s, k) => ({ s, k }))
          .reverse()
          .map(({ s, k }) => (
            <>
              <input class={`vh yr yr-${k}`} type="checkbox" id={`${id}-y${k}`} checked />
              <label class={`lg lg-${k}`} for={`${id}-y${k}`}>
                <span class={`sw sw-${k}`} aria-hidden="true"></span>
                <span class="lg-label">{s.label}</span> <span class="lg-total">{s.total}</span>
              </label>
            </>
          ))}
      </fieldset>
    </figure>
  );
}

// ---------------------------------------------------------------------------- range switch

export interface RangeOption {
  /** Unique within the page, e.g. "week". */
  id: string;
  label: string;
  content: Child;
}

export interface RangeSwitchProps {
  /** The radio group's name; the inputs' ids are `<name>-<id>`. */
  name: string;
  /** The group's legend (visually hidden), e.g. "Show listening by". */
  legend: string;
  /** Shown in the row before the switch, e.g. the panel's <h2>. */
  head?: Child;
  /** Up to 4 options; the first is selected. */
  options: RangeOption[];
}

/**
 * A segmented Week / Month / Year switch without JS: radio inputs, and CSS `:has()` shows the panel
 * whose input is checked (by position). Browsers without `:has()` show every panel, stacked.
 */
export function RangeSwitch({ name, legend, head, options }: RangeSwitchProps) {
  return (
    <div class="range">
      {head}
      <fieldset class="seg">
        <legend class="vh">{legend}</legend>
        {options.map((o, i) => (
          <>
            <input class="vh" type="radio" name={name} id={`${name}-${o.id}`} value={o.id} checked={i === 0} />
            <label for={`${name}-${o.id}`}>{o.label}</label>
          </>
        ))}
      </fieldset>
      {options.map((o) => (
        <div class="range-panel" id={`${name}-${o.id}-panel`}>
          {o.content}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------- heatmap

/** The heat level of a cell: 0 (no plays) or 1-5 by fifths of the busiest cell. */
export const heatLevel = (n: number, max: number) => (n > 0 ? Math.min(5, Math.max(1, Math.ceil((n / Math.max(1, max)) * 5))) : 0);

export interface HeatmapProps {
  /** 7 rows (Monday first) x 24 local hours. */
  grid: number[][];
  summary: string;
}

/** When you listen: a 7 x 24 grid in 5 levels plus empty, a title on each cell and a legend. */
export function Heatmap({ grid, summary }: HeatmapProps) {
  const max = Math.max(0, ...grid.flat());
  const cellTitle = (d: number, h: number, n: number) => `${WEEKDAYS[d]}, ${hourName(h)}–${hourName((h + 1) % 24)}: ${playsText(n)}`;
  return (
    <figure class="chart chart-heat">
      <div class="hm" role="img" aria-label={summary}>
        {grid.map((row, d) => (
          <>
            <span class="hm-day">{WEEKDAYS_SHORT[d]}</span>
            {row.map((n, h) => (
              <span class={`hc l${heatLevel(n, max)}`} title={cellTitle(d, h, n)}></span>
            ))}
          </>
        ))}
        <span class="hm-corner"></span>
        {["12 AM", "6 AM", "12 PM", "6 PM"].map((l) => (
          <span class="hm-hour">{l}</span>
        ))}
      </div>
      <div class="hm-legend" aria-hidden="true">
        <span>Fewer plays</span>
        {[1, 2, 3, 4, 5].map((l) => (
          <span class={`hc l${l}`}></span>
        ))}
        <span>More</span>
        <span class="hm-none">
          <span class="hc l0"></span> None
        </span>
      </div>
    </figure>
  );
}

// ---------------------------------------------------------------------------- meters and lists

/** A thin horizontal meter (decorative: the value is always printed next to it). */
export function Meter({ value, max, tone = "accent" }: { value: number; max: number; tone?: "accent" | "second" | "bar" }) {
  const frac = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
  return (
    <svg class={`meter meter-${tone}`} width="100%" height="6" aria-hidden="true">
      <rect class="meter-track" width="100%" height="6" rx="3" />
      {frac > 0 ? <rect class="meter-fill" width={pct(Math.max(2, frac * 100))} height="6" rx="3" /> : null}
    </svg>
  );
}

export interface BarItem {
  label: string;
  value: number;
  /** A link for the label (an absolute URL we built). */
  href?: string;
  /** Before the label, e.g. an ArtistAvatar. */
  media?: Child;
}

/** Ranked bars with the exact count printed on each row (top artists, genres). */
export function BarList({ items, label, tone = "accent" }: { items: BarItem[]; label: string; tone?: "accent" | "second" | "bar" }) {
  const max = Math.max(1, ...items.map((i) => i.value));
  return (
    <ol class="bars" aria-label={label}>
      {items.map((i) => (
        <li class={i.media ? "has-media" : undefined}>
          {i.media}
          <div class="bar-text">
            <span class="bar-label">{i.href ? <a href={i.href}>{i.label}</a> : i.label}</span>
            <span class="bar-value">{playsText(i.value)}</span>
            <Meter value={i.value} max={max} tone={tone} />
          </div>
        </li>
      ))}
    </ol>
  );
}

export interface SplitPart {
  label: string;
  value: number;
  tone: "accent" | "second";
}

/** A two-part proportion bar (new vs repeat plays) with a legend that prints both counts and shares. */
export function SplitBar({ parts, summary }: { parts: [SplitPart, SplitPart]; summary: string }) {
  const total = parts[0].value + parts[1].value;
  const share = (v: number) => (total ? Math.round((v / total) * 100) : 0);
  const first = total ? (parts[0].value / total) * 100 : 0;
  return (
    <figure class="split" aria-label={summary}>
      <svg class="split-bar" width="100%" height="12" aria-hidden="true">
        <rect class="split-track" width="100%" height="12" rx="6" />
        {total && parts[0].value ? <rect class={`split-${parts[0].tone}`} x="0" width={pct(first)} height="12" rx="6" /> : null}
        {total && parts[1].value ? <rect class={`split-${parts[1].tone}`} x={pct(first)} width={pct(100 - first)} height="12" rx="6" /> : null}
        {parts[0].value && parts[1].value ? <rect class="split-gap" x={pct(first)} width="3" height="12" transform="translate(-1.5 0)" /> : null}
      </svg>
      <ul class="split-legend">
        {parts.map((p) => (
          <li>
            <span class={`key key-${p.tone}`}></span>
            <span class="split-label">{p.label}</span>
            <span class="split-value">
              {playsText(p.value)} <span class="muted">({share(p.value)}%)</span>
            </span>
          </li>
        ))}
      </ul>
    </figure>
  );
}

export interface StreakDay {
  /** "M", "T"... */
  initial: string;
  /** "Mon, Oct 6". */
  name: string;
  played: boolean;
  future: boolean;
  today: boolean;
}

/** A week of days as dots: filled with a check when played, a ring when not, dashed when still to come. */
export function StreakDots({ days, label }: { days: StreakDay[]; label: string }) {
  return (
    <ol class="dots" aria-label={label}>
      {days.map((d) => {
        const state = d.future ? "upcoming" : d.played ? "played" : "no plays";
        return (
          <li class={`dot ${d.future ? "is-future" : d.played ? "is-on" : "is-off"}${d.today ? " is-today" : ""}`} title={`${d.name}: ${state}`}>
            <span class="dot-mark" aria-hidden="true"></span>
            <span class="dot-day" aria-hidden="true">
              {d.initial}
            </span>
            <span class="vh">
              {d.name}: {state}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
