// Home's charts: summaries and tables (never colour alone), focusable bars, the CSS-only range switch,
// the heatmap's levels, and the meters. No `style=` anywhere: geometry is attributes, colour classes.

import { describe, expect, it } from "vitest";
import { BarList, ColumnChart, Heatmap, heatLevel, Meter, niceTicks, RangeSwitch, SplitBar, StreakDots, type Column } from "../../../src/dashboard/components/charts";
import { render } from "../../../src/dashboard/render";

const XSS = `<script>alert("x")</script>`;
const ESCAPED = "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;";
const noStyle = (html: string) => expect(html).not.toMatch(/\sstyle\s*=/i);

const week: Column[] = [
  { label: "Mon", name: "Mon, Oct 5", value: 12 },
  { label: "Tue", name: "Tue, Oct 6", value: 0 },
  { label: "Wed", name: "Wed, Oct 7", value: 40 },
  { label: "Thu", name: "Thu, Oct 8", value: 3, highlight: true, note: "so far" },
  { label: "Fri", name: "Fri, Oct 9", value: 0, future: true },
];

describe("niceTicks", () => {
  it("reaches the max in at most 3 round steps", () => {
    expect(niceTicks(0)).toEqual([0, 1]);
    expect(niceTicks(1)).toEqual([0, 1]);
    expect(niceTicks(7)).toEqual([0, 5, 10]);
    expect(niceTicks(40)).toEqual([0, 20, 40]);
    expect(niceTicks(84)).toEqual([0, 50, 100]);
    expect(niceTicks(1204)).toEqual([0, 500, 1000, 1500]);
  });
});

describe("ColumnChart", () => {
  const out = render(<ColumnChart columns={week} summary="This week: 55 plays so far." labelHeader="Day" />);

  it("labels the chart and every past bar, and keeps future days out of the tab order", () => {
    expect(out).toContain(`<div class="cc" role="group" aria-label="This week: 55 plays so far.">`);
    const bars = [...out.matchAll(/<g class="col[^"]*" tabindex="0" role="img" aria-label="([^"]+)">/g)].map((m) => m[1]);
    expect(bars).toEqual(["Mon, Oct 5: 12 plays", "Tue, Oct 6: 0 plays", "Wed, Oct 7: 40 plays", "Thu, Oct 8: 3 plays so far"]);
    expect(out).toContain(`<rect class="col-future"`);
    expect(out).toMatch(/<g class="col is-now" tabindex="0"/);
    expect(out).toContain(`<text class="tick is-now"`);
  });

  it("draws a zero as a baseline tick, not a blank", () => {
    expect(out.match(/class="col-zero"/g)).toHaveLength(1);
  });

  it("has a CSS-only tooltip per bar and a numbers table", () => {
    expect(out.match(/<g class="tip" aria-hidden="true">/g)).toHaveLength(4);
    expect(out).toContain(`<details class="numbers"><summary>Show the numbers</summary>`);
    expect(out).toContain(`<th scope="col">Day</th><th scope="col" class="num">Plays</th>`);
    expect(out).toContain(`<tr><th scope="row">Thu, Oct 8</th><td class="num">3 (so far)</td></tr>`);
    expect(out).toContain(`<tr><th scope="row">Fri, Oct 9</th><td class="num">Upcoming</td></tr>`);
    noStyle(out);
  });

  it("positions x in percent and y in pixels (no viewBox, so text never scales)", () => {
    expect(out).not.toContain("viewBox");
    expect(out).toMatch(/<rect class="col-bar" x="[\d.]+%" y="[\d.]+" width="[\d.]+%"/);
  });

  it("escapes names and labels", () => {
    const x = render(<ColumnChart columns={[{ label: XSS, name: XSS, value: 1 }]} summary={XSS} labelHeader={XSS} />);
    expect(x).not.toContain("<script>");
    expect(x).toContain(`aria-label="${ESCAPED}: 1 play"`);
  });

  it("renders an all-zero chart with its axis and labels", () => {
    const zero = render(<ColumnChart columns={week.map((c) => ({ ...c, value: 0 }))} summary="This week: no plays yet." labelHeader="Day" />);
    expect(zero.match(/class="col-zero"/g)).toHaveLength(4);
    expect(zero).toContain(`<text class="tick"`);
    expect(zero).toContain(`<line class="base"`);
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

  it("has a summary, a legend in words and a 7-row numbers table", () => {
    expect(out).toContain(`<div class="hm" role="img" aria-label="38 plays in the last 4 weeks.">`);
    expect(out).toContain("<span>Fewer plays</span>");
    expect(out).toContain(`<details class="numbers">`);
    expect(out.match(/<tr><th scope="row">/g)).toHaveLength(7);
    expect(out).toContain(`<tr><th scope="row">Wednesday</th>`);
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
