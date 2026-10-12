// Home's charts: the year-over-year line chart (summary, legend, focusable points with every year's
// value, smooth monotone curves), the CSS-only range switch, the heatmap's levels, and the meters.
// No `style=` anywhere: geometry is attributes, colour classes.

import { describe, expect, it } from "vitest";
import { BarList, Heatmap, heatLevel, LineChart, Meter, niceScale, RangeSwitch, smoothPath, SplitBar, StreakDots, type LinePoint, type LineSeries } from "../../../src/dashboard/components/charts";
import { render } from "../../../src/dashboard/render";

const XSS = `<script>alert("x")</script>`;
const ESCAPED = "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;";
const noStyle = (html: string) => expect(html).not.toMatch(/\sstyle\s*=/i);

const points: LinePoint[] = [
  { label: "Mon", name: "Mon, Oct 5" },
  { label: "Tue", name: "Tue, Oct 6" },
  { label: "Wed", name: "Wed, Oct 7" },
  { label: "Thu", name: "Thu, Oct 8", highlight: true },
  { label: "Fri", name: "Fri, Oct 9" },
];
const series: LineSeries[] = [
  { label: "2026", values: [12, 0, 40, 3, null], total: "55 plays so far" },
  { label: "2025", values: [20, 18, 25, 30, 22], total: "115 plays" },
];

describe("niceScale", () => {
  it("tops out just above the max, with about four round gridlines inside", () => {
    expect(niceScale(0)).toEqual({ top: 1.08, ticks: [0, 1] });
    expect(niceScale(205)).toEqual({ top: 221.4, ticks: [0, 50, 100, 150, 200] }); // not up to 300
    expect(niceScale(40).ticks).toEqual([0, 10, 20, 30, 40]);
    expect(niceScale(84).ticks).toEqual([0, 20, 40, 60, 80]);
    expect(niceScale(1204).ticks).toEqual([0, 500, 1000]);
    for (const max of [3, 7, 40, 84, 205, 999, 1204]) {
      const { top, ticks } = niceScale(max);
      expect(top).toBeGreaterThan(max);
      expect(ticks.at(-1)!).toBeLessThanOrEqual(top);
      expect(ticks.length).toBeGreaterThanOrEqual(2);
      expect(ticks.length).toBeLessThanOrEqual(5);
    }
  });
});

describe("smoothPath", () => {
  it("passes through every point with cubic segments, and is just a move for one point", () => {
    expect(smoothPath([])).toBe("");
    expect(smoothPath([[10, 20]])).toBe("M10,20");
    const d = smoothPath([[0, 100], [100, 50], [200, 80]]);
    expect(d.startsWith("M0,100C")).toBe(true);
    expect(d.match(/C/g)).toHaveLength(2);
    expect(d).toContain(" 100,50C");
    expect(d.endsWith(" 200,80")).toBe(true);
  });

  it("never overshoots: control points stay within each segment's y range (monotone)", () => {
    const pts: Array<[number, number]> = [[0, 180], [100, 180], [200, 40], [300, 180], [400, 170]];
    const nums = smoothPath(pts).match(/-?[\d.]+,-?[\d.]+/g)!.map((p) => Number(p.split(",")[1]));
    expect(Math.max(...nums)).toBeLessThanOrEqual(180);
    expect(Math.min(...nums)).toBeGreaterThanOrEqual(40);
  });
});

describe("LineChart", () => {
  const out = render(<LineChart id="t" points={points} series={series} note="so far" summary="This week so far: 55 plays. The same week in 2025: 115." />);

  it("labels the chart, and each point with every year's value; points with no value aren't focusable", () => {
    expect(out).toContain(`<div class="lc" role="group" aria-label="This week so far: 55 plays. The same week in 2025: 115.">`);
    const labels = [...out.matchAll(/<g class="pt" tabindex="0" role="img" aria-label="([^"]+)">/g)].map((m) => m[1]);
    expect(labels).toEqual([
      "Mon, Oct 5: 2025 20 plays, 2026 12 plays", // oldest year first, like the legend
      "Tue, Oct 6: 2025 18 plays, 2026 0 plays",
      "Wed, Oct 7: 2025 25 plays, 2026 40 plays",
      "Thu, Oct 8: 2025 30 plays, 2026 3 plays so far",
      "Fri, Oct 9: 2025 22 plays", // this year's Friday is still to come
    ]);
    expect(out).toContain(`<text class="tick is-now"`);
  });

  it("only takes the hover near a point's lines, not the whole column", () => {
    // Wednesday: 2025 25 and 2026 40 of a 43.2 top, on a 24-208 px plot -> lines between y 37.6 and 101.5.
    expect(out).toContain(`<rect class="pt-hit" x="40%" y="17.6" width="20%" height="103.9"></rect>`);
    // Tuesday's 0 sits on the baseline: the target stops 6 px below it.
    expect(out).toMatch(/<rect class="pt-hit" x="20%" y="[\d.]+" width="20%" height="[\d.]+"><\/rect>/);
  });

  it("draws one curve per year (this year's in front, filled underneath) and a dot at this year's latest point", () => {
    expect(out.match(/<path class="ln ln-0"/g)).toHaveLength(1);
    expect(out.match(/<path class="ln ln-1"/g)).toHaveLength(1);
    expect(out.indexOf(`class="ln ln-1"`)).toBeLessThan(out.indexOf(`class="ln ln-0"`));
    expect(out.match(/<path class="area"/g)).toHaveLength(1);
    expect(out).toContain(`vector-effect="non-scaling-stroke"`);
    expect(out).toMatch(/<svg class="lc-lines" width="100%" height="240" viewBox="0 0 1000 240" preserveAspectRatio="none"/);
    expect(out).toMatch(/<circle class="dot-now" cx="70%"/); // Thursday, the 4th of 5 points
    // Each point's dots and guide line (hidden until hover by CSS), then its tooltip.
    expect(out).toMatch(/<line class="tip tip-guide" x1="50%"[^>]*><\/line><circle class="dot dot-1" cx="50%" cy="[\d.]+" r="3" aria-hidden="true"><\/circle><circle class="dot dot-0" cx="50%" cy="[\d.]+" r="3.5" aria-hidden="true"><\/circle><g class="tip"/);
  });

  it("has a legend of year toggles (oldest first) with each year's total, a CSS-only tooltip per point, and no numbers table", () => {
    expect(out).toContain(`<fieldset class="lc-legend"><legend class="vh">Years shown</legend><input class="vh yr yr-1" type="checkbox" id="t-y1" checked=""/>`);
    expect(out).toContain(`<label class="lg lg-0" for="t-y0"><span class="sw sw-0" aria-hidden="true"></span><span class="lg-label">2026</span> <span class="lg-total">55 plays so far</span></label>`);
    expect(out.indexOf(`id="t-y1"`)).toBeLessThan(out.indexOf(`id="t-y0"`));
    expect(out.match(/<g class="tip" aria-hidden="true">/g)).toHaveLength(5);
    expect(out).toContain(`<g class="row row-1"><circle class="dot dot-1" cx="-168" cy="34" r="4"></circle><text class="tip-row" x="-158" y="38">2025</text><text class="tip-value" x="-24" y="38" text-anchor="end">30</text></g>`);
    expect(out).toContain(`<text class="tip-value" x="-24" y="56" text-anchor="end">3 so far</text>`); // Thursday's 2025 row, tooltip left of the point
    expect(out).not.toMatch(/<details|<table/);
    noStyle(out);
  });

  it("escapes names, labels and totals", () => {
    const x = render(<LineChart id="x" points={[{ label: XSS, name: XSS }]} series={[{ label: XSS, values: [1], total: XSS }]} summary={XSS} />);
    expect(x).not.toContain("<script>");
    expect(x).toContain(`aria-label="${ESCAPED}: ${ESCAPED} 1 play"`);
  });

  it("renders an all-zero chart with its axis, labels and a flat line", () => {
    const zero = render(<LineChart id="z" points={points} series={[{ label: "2026", values: [0, 0, 0, null, null], total: "0 plays" }]} summary="This week: no plays yet." />);
    expect(zero).toContain(`<text class="tick"`);
    expect(zero).toContain(`<line class="base"`);
    expect(zero).toContain(`<path class="ln ln-0" d="M100,208C`);
  });
});

describe("RangeSwitch", () => {
  it("is a radio group in a fieldset with a legend; the first option is checked; one panel per option", () => {
    const out = render(
      <RangeSwitch
        name="days"
        legend="Show listening by"
        head={<h2>Listening</h2>}
        options={[
          { id: "week", label: "Week", content: <p>w</p> },
          { id: "month", label: "Month", content: <p>m</p> },
          { id: "year", label: "Year", content: <p>y</p> },
        ]}
      />,
    );
    expect(out).toMatch(/^<div class="range"><h2>Listening<\/h2><fieldset class="seg"><legend class="vh">Show listening by<\/legend>/);
    expect(out).toContain(`<input class="vh" type="radio" name="days" id="days-week" value="week" checked=""/><label for="days-week">Week</label>`);
    expect(out).toContain(`<input class="vh" type="radio" name="days" id="days-month" value="month"/><label for="days-month">Month</label>`);
    expect(out.match(/<div class="range-panel"/g)).toHaveLength(3);
    expect(out.match(/checked/g)).toHaveLength(1);
  });
});

describe("Heatmap", () => {
  const grid = Array.from({ length: 7 }, (_, d) => Array.from({ length: 24 }, (_, h) => (d === 2 && h === 21 ? 10 : h === 8 ? 2 : 0)));
  const out = render(<Heatmap grid={grid} summary="38 plays in the last 4 weeks." />);

  it("levels cells by fifths of the busiest, 0 for none", () => {
    expect([0, 1, 2, 3, 5, 10].map((n) => heatLevel(n, 10))).toEqual([0, 1, 1, 2, 3, 5]);
    expect(out.match(/class="hc l\d"/g)!.length).toBe(7 * 24 + 6); // the cells and the legend
    expect(out).toContain(`<span class="hc l5" title="Wednesday, 9 PM–10 PM: 10 plays"></span>`);
    expect(out).toContain(`<span class="hc l0" title="Monday, 12 AM–1 AM: 0 plays"></span>`);
  });

  it("has a summary and a legend in words, and no numbers table", () => {
    expect(out).toContain(`<div class="hm" role="img" aria-label="38 plays in the last 4 weeks.">`);
    expect(out).toContain("<span>Fewer plays</span>");
    expect(out).not.toMatch(/<details|<table/);
    noStyle(out);
  });
});

describe("meters", () => {
  it("Meter: an SVG with a percentage width, empty at 0", () => {
    expect(render(<Meter value={1} max={4} />)).toContain(`<rect class="meter-fill" width="25%" height="6" rx="3"></rect>`);
    expect(render(<Meter value={0} max={4} />)).not.toContain("meter-fill");
    expect(render(<Meter value={3} max={0} />)).not.toContain("meter-fill");
  });

  it("BarList: prints each count next to its bar, links and escapes labels", () => {
    const out = render(<BarList label="Top genres" items={[{ label: XSS, value: 3, href: "https://open.spotify.com/artist/a" }, { label: "pop", value: 1 }]} />);
    expect(out).toContain(`<ol class="bars" aria-label="Top genres">`);
    expect(out).toContain(`<a href="https://open.spotify.com/artist/a">${ESCAPED}</a>`);
    expect(out).toContain(`<span class="bar-value">3 plays</span>`);
    expect(out).toContain(`<span class="bar-value">1 play</span>`);
    noStyle(out);
  });

  it("SplitBar: both parts with counts and shares in the legend", () => {
    const out = render(
      <SplitBar
        summary="25% new."
        parts={[
          { label: "New to you", value: 25, tone: "accent" },
          { label: "Heard before", value: 75, tone: "second" },
        ]}
      />,
    );
    expect(out).toContain(`<figure class="split" aria-label="25% new.">`);
    expect(out).toContain(`<rect class="split-accent" x="0" width="25%"`);
    expect(out).toContain(`<rect class="split-second" x="25%" width="75%"`);
    expect(out).toContain(`25 plays <span class="muted">(25%)</span>`);
    expect(out).toContain(`75 plays <span class="muted">(75%)</span>`);
    const empty = render(<SplitBar summary="none" parts={[{ label: "a", value: 0, tone: "accent" }, { label: "b", value: 0, tone: "second" }]} />);
    expect(empty).not.toMatch(/split-(accent|second|gap)"/);
    expect(empty).toContain("(0%)");
  });

  it("StreakDots: says each day's state in text, not just colour", () => {
    const out = render(
      <StreakDots
        label="This week"
        days={[
          { initial: "M", name: "Mon, Oct 5", played: true, future: false, today: false },
          { initial: "T", name: "Tue, Oct 6", played: false, future: false, today: true },
          { initial: "W", name: "Wed, Oct 7", played: false, future: true, today: false },
        ]}
      />,
    );
    expect(out).toContain(`<ol class="dots" aria-label="This week">`);
    expect(out).toContain(`<li class="dot is-on" title="Mon, Oct 5: played">`);
    expect(out).toContain(`<li class="dot is-off is-today" title="Tue, Oct 6: no plays">`);
    expect(out).toContain(`<span class="vh">Wed, Oct 7: upcoming</span>`);
  });
});
