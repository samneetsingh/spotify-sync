// Home's charts, rendered on the server: no client JS and no `style=` attributes (the CSP blocks them),
// so SVG geometry goes in attributes and colour in classes (styles/home.ts). Every chart has an
// aria-label summary sentence and a "Show the numbers" table, and never uses colour alone: values are
// in the tooltips, the labels and the table; the highlighted bar also has a bold axis label.
//
// ColumnChart uses no viewBox: x positions and widths are percentages of the chart's width and y is in
// pixels, so text never scales and the 4px rounded bar ends stay round at every width. Tooltips are
// CSS-only (:hover / :focus-visible on the focusable bar) in a band above the plot.

import type { Child } from "hono/jsx";
import { fmt } from "../../email/layout";
import { axisNumber, hourName, playsText, WEEKDAYS, WEEKDAYS_SHORT } from "./format";

/** A number for an SVG percentage attribute. */
const pct = (n: number) => `${Math.round(n * 1000) / 1000}%`;

// ---------------------------------------------------------------------------- numbers table

export interface NumbersProps {
  /** Column headers; numeric columns are right-aligned. */
  head: Array<{ label: string; numeric?: boolean }>;
  /** Rows of cells; the first cell is the row's header. */
  rows: Array<Array<string | number>>;
  caption?: string;
}

/** The "Show the numbers" disclosure every chart carries: a real table of the plotted values. */
export function Numbers({ head, rows, caption }: NumbersProps) {
  const num = (i: number) => (head[i]?.numeric ? "num" : undefined);
  return (
    <details class="numbers">
      <summary>Show the numbers</summary>
      <div class="table-wrap">
        <table>
          {caption ? <caption class="vh">{caption}</caption> : null}
          <thead>
            <tr>
              {head.map((h, i) => (
                <th scope="col" class={num(i)}>
                  {h.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr>
                {r.map((cell, i) =>
                  i === 0 ? (
                    <th scope="row">{cell}</th>
                  ) : (
                    <td class={num(i)}>{typeof cell === "number" ? fmt(cell) : cell}</td>
                  ),
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

// ---------------------------------------------------------------------------- column chart

export interface Column {
  /** The axis label, e.g. "Mon", "8" or "Oct". */
  label: string;
  /** The full name for the tooltip, the bar's label and the table, e.g. "Mon, Oct 6". */
  name: string;
  value: number;
  /** Today, or the current month: an apricot bar and a bold axis label. */
  highlight?: boolean;
  /** Hasn't happened yet: a hollow stub, not focusable. */
  future?: boolean;
  /** Show the axis label (default true); e.g. only every 7th day of a month. */
  tick?: boolean;
  /** Hide the axis label on phones (every other month of a year). */
  tickWide?: boolean;
  /** After the value in the tooltip and the label, e.g. "so far". */
  note?: string;
}

export interface ColumnChartProps {
  columns: Column[];
  /** The summary sentence (the chart's aria-label). */
  summary: string;
  /** The first column's header in the numbers table, e.g. "Day" or "Month". */
  labelHeader: string;
}

/** Chart geometry in px: a tooltip band, the plot, the axis labels. */
const H = 212;
const PLOT_TOP = 52;
const BASE = 180;
const LABEL_Y = 202;
const TIP_W = 148;
const TIP_H = 42;

/** Round gridline steps: 0, step, 2*step... reaching `max` in at most 3 steps (1, 2 or 5 x 10^k). */
export function niceTicks(max: number): number[] {
  const m = Math.max(1, max);
  const raw = m / 3;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = Math.max(1, [1, 2, 5, 10].map((s) => s * pow).find((s) => s >= raw)!);
  const top = Math.ceil(m / step) * step;
  return Array.from({ length: top / step + 1 }, (_, i) => i * step);
}

const valueText = (c: Column) => (c.future ? "upcoming" : `${playsText(c.value)}${c.note ? ` ${c.note}` : ""}`);

/** Plays per day or month: focusable bars with CSS tooltips, gridlines, today highlighted, future days hollow. */
export function ColumnChart({ columns, summary, labelHeader }: ColumnChartProps) {
  const ticks = niceTicks(Math.max(0, ...columns.map((c) => c.value)));
  const top = ticks.at(-1)!;
  const y = (v: number) => BASE - (v / top) * (BASE - PLOT_TOP);
  const n = Math.max(1, columns.length);
  const slot = 100 / n;
  const barW = slot * (n > 20 ? 0.62 : 0.5);
  return (
    <figure class="chart chart-cols">
      <div class="cc" role="group" aria-label={summary}>
        <svg class="cc-y" width="44" height={H} aria-hidden="true">
          {ticks.map((t) => (
            <text x="36" y={y(t) + 4} text-anchor="end">
              {axisNumber(t)}
            </text>
          ))}
        </svg>
        <svg class="cc-plot" width="100%" height={H}>
          <g aria-hidden="true">
            {ticks.map((t) => (
              <line class={t === 0 ? "base" : "grid"} x1="0" x2="100%" y1={y(t)} y2={y(t)} />
            ))}
            {columns.map((c, i) =>
              c.tick === false ? null : (
                <text class={`tick${c.highlight ? " is-now" : ""}${c.tickWide ? " tick-wide" : ""}`} x={pct((i + 0.5) * slot)} y={LABEL_Y} text-anchor="middle">
                  {c.label}
                </text>
              ),
            )}
          </g>
          {columns.map((c, i) => {
            const x = pct(i * slot + (slot - barW) / 2);
            const w = pct(barW);
            if (c.future) return <rect class="col-future" x={x} y={BASE - 10} width={w} height="10" rx="3" aria-hidden="true" />;
            const barTop = c.value > 0 ? Math.min(y(c.value), BASE - 3) : BASE - 2;
            const center = (i + 0.5) * slot;
            const tipX = center < 16 ? -16 : center > 84 ? -(TIP_W - 16) : -TIP_W / 2;
            return (
              <g class={`col${c.highlight ? " is-now" : ""}`} tabindex={0} role="img" aria-label={`${c.name}: ${valueText(c)}`}>
                <rect class="col-hit" x={pct(i * slot)} y={PLOT_TOP - 8} width={pct(slot)} height={BASE - PLOT_TOP + 14} rx="6" />
                {c.value > 0 ? (
                  <>
                    <rect class="col-bar" x={x} y={barTop} width={w} height={BASE - barTop} rx="4" />
                    {BASE - barTop > 4 ? <rect class="col-bar" x={x} y={BASE - 4} width={w} height="4" /> : null}
                  </>
                ) : (
                  <rect class="col-zero" x={x} y={BASE - 2} width={w} height="2" />
                )}
                <g class="tip" aria-hidden="true">
                  <line class="tip-guide" x1={pct(center)} x2={pct(center)} y1={TIP_H + 4} y2={barTop - 4} />
                  <svg x={pct(center)} y="0" width="1" height="1" overflow="visible">
                    <rect class="tip-box" x={tipX} y="0" width={TIP_W} height={TIP_H} rx="10" />
                    <text class="tip-name" x={tipX + 12} y="17">
                      {c.name}
                    </text>
                    <text class="tip-value" x={tipX + 12} y="34">
                      {valueText(c)}
                    </text>
                  </svg>
                </g>
              </g>
            );
          })}
        </svg>
      </div>
      <Numbers
        caption={summary}
        head={[{ label: labelHeader }, { label: "Plays", numeric: true }]}
        rows={columns.map((c) => [c.name, c.future ? "Upcoming" : `${fmt(c.value)}${c.note ? ` (${c.note})` : ""}`])}
      />
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

/** When you listen: a 7 x 24 grid in 5 levels plus empty, a title on each cell, a legend and the table. */
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
      <Numbers
        caption={summary}
        head={[{ label: "Day" }, ...Array.from({ length: 24 }, (_, h) => ({ label: hourName(h), numeric: true })), { label: "Total", numeric: true }]}
        rows={grid.map((row, d) => [WEEKDAYS[d]!, ...row, row.reduce((a, b) => a + b, 0)])}
      />
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
