// Home's styles: the 12-column grid, the hero (the song of the week's cover on a glass card with a
// blue glow), the stat tiles (glass mini cards with a blue icon square), charts (columns, range
// switch, heatmap, meters, split bar, streak dots), track and artist rows, empty states and the status
// banner. Shared classes (card, chip, btn, notice, tables) are in base.ts. Colours are classes, never
// attributes, so the CSP's no-`style=` rule holds.

import { iconUrl } from "../components/icons";
import { CHART, COLOR as K, GLASS, LINE_STRONG, TINT, ty } from "../tokens";

/** The missing-art tile: a music note on a navy tile (also behind every cover, so a broken image shows it). */
const MISSING_ART = `${iconUrl("music", K.mute)} center / 44% no-repeat,linear-gradient(135deg,${K.raised},${K.navy})`;

const heat = CHART.heat.map((c, i) => `.hc.l${i + 1}{background:${c}}`).join("");

export const HOME_CSS = `
/* Grid: one column on phones, 6 from 640px, 12 from 1024px (page padding 16 / 32 / 48 in base). */
.home{display:grid;grid-template-columns:minmax(0,1fr);gap:16px}
.home .card{margin:0;min-width:0}
.home-status{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px}
.home-sofar{display:grid;gap:16px;min-width:0}
.head-meta{${ty("meta")};color:${K.soft};font-weight:650}
.sub-title{${ty("micro")};font-weight:700;color:${K.soft};text-transform:uppercase;letter-spacing:.08em;margin:20px 0 10px}
.card-head+.sub-title{margin-top:0}
.big{display:flex;align-items:baseline;flex-wrap:wrap;gap:4px 10px;margin:0}
.big-value{font-size:34px;line-height:40px;font-weight:700;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.big-unit{${ty("body")};color:${K.soft};font-weight:650}
.defs{position:absolute;width:0;height:0;overflow:hidden}

/* Status banner: slim, red, says what's wrong and what to do. */
.banner{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;padding:10px 10px 10px 14px;border-radius:15px;background:linear-gradient(${TINT.bad},${TINT.bad}),${K.navy};border:1px solid rgba(238,93,80,.45)}
.banner-icon{flex:none;display:grid;place-items:center;width:26px;height:26px;border-radius:8px;background:${K.danger};color:${K.text};font-size:14px;font-weight:800;line-height:1}
.banner-text{flex:1 1 220px;margin:0;color:${K.text}}
.banner-action{display:inline-flex;align-items:center;min-height:40px;padding:0 16px;border-radius:12px;background:${K.danger};color:${K.text};${ty("meta")};font-weight:700;text-decoration:none;white-space:nowrap}
.banner-action:hover{color:${K.text};background:#c71515}

/* Hero: the song of the week, its square cover on a glass card with a blue glow. */
.hero{display:grid;justify-items:center;gap:20px;padding:24px 20px;text-align:center;overflow:hidden;background:radial-gradient(520px 380px at 0% 0%,rgba(0,117,255,.28),transparent 65%),radial-gradient(420px 300px at 100% 100%,rgba(44,217,255,.1),transparent 70%),${GLASS.card}}
.hero-cover{position:relative;width:min(220px,62vw);aspect-ratio:1;border-radius:16px;overflow:hidden;background:${MISSING_ART};box-shadow:0 24px 48px -20px rgba(0,0,0,.8),0 0 0 1px rgba(255,255,255,.1)}
.hero-cover img{display:block;width:100%;height:100%;object-fit:cover}
.hero-text{display:grid;justify-items:center;gap:6px;min-width:0;max-width:100%}
.hero-head{display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:8px}
.hero-label{${ty("micro")};font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:${K.soft}}
.hero-when{${ty("micro")};padding:3px 10px;border-radius:8px;background:${TINT.neutral};color:${K.soft};font-weight:700}
.hero-track{margin:4px 0 0;${ty("heroPhone")};font-weight:700;letter-spacing:-.02em;text-wrap:balance;overflow-wrap:anywhere}
.hero-track a{color:${K.text};text-decoration:none}
.hero-track a:hover{text-decoration:underline;text-decoration-thickness:2px;text-underline-offset:6px}
.hero-artist{margin:0;${ty("title")};color:${K.soft};text-wrap:balance;overflow-wrap:anywhere}
.hero.is-empty .hero-artist{${ty("body")}}
.hero-plays{display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:8px 10px;margin:10px 0 0;${ty("meta")}}
.plays-badge{display:inline-flex;align-items:center;min-height:28px;padding:0 10px;border-radius:8px;background:${K.blueFill};color:${K.text};font-weight:700}
.hero-actions{margin-top:12px}

/* This week and month: the card is just a heading; each figure is a glass tile with an icon square. */
.home .sofar{padding:0;background:none;-webkit-backdrop-filter:none;backdrop-filter:none;border:0;box-shadow:none;border-radius:0}
.sofar .card-head{margin:0 0 12px}
.tiles{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin:0}
.tile{display:grid;grid-template-columns:minmax(0,1fr) auto;grid-template-areas:"label icon" "value icon" "delta icon";align-items:center;column-gap:12px;min-width:0;padding:14px 14px 14px 16px;border-radius:20px;background:${GLASS.card};${GLASS.blur};${GLASS.edge}}
.tile dt{grid-area:label;${ty("micro")};font-weight:700;color:${K.soft};white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tile-value{grid-area:value;margin:2px 0 0;${ty("number")};font-weight:700;letter-spacing:-.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tile-delta{grid-area:delta;margin:2px 0 0}
.tile-icon{grid-area:icon;display:grid;place-items:center;width:40px;height:40px;margin:0;border-radius:12px;background:${K.blue};color:${K.text};box-shadow:0 8px 18px -8px rgba(0,117,255,.9)}
.tile-icon .icon{width:20px;height:20px}
.delta{display:inline-flex;align-items:center;gap:2px;${ty("micro")};font-weight:700;font-variant-numeric:tabular-nums}
.delta-up{color:${K.ok}}
.delta-down{color:${K.bad}}
.delta-same{color:${K.mute}}
.sofar .note{margin-top:10px}

/* Range switch: a segmented radio group; :has() shows the checked option's panel. */
.range{display:grid;grid-template-columns:minmax(0,1fr);align-items:center;gap:12px}
.range>.range-panel{grid-column:1/-1;min-width:0}
fieldset.seg{display:inline-flex;justify-self:start;gap:2px;margin:0;padding:4px;border:1px solid ${LINE_STRONG};border-radius:12px;background:${K.navy};box-shadow:none;-webkit-backdrop-filter:none;backdrop-filter:none}
.seg label{display:inline-flex;align-items:center;min-height:32px;padding:0 14px;border-radius:9px;color:${K.soft};${ty("micro")};font-weight:700;cursor:pointer;user-select:none}
.seg label:hover{color:${K.text}}
.seg input:checked+label{background:${K.blueFill};color:${K.text}}
.seg input:focus-visible+label{outline:2px solid ${K.cyan};outline-offset:1px}
@supports selector(:has(*)){
.range>.range-panel{display:none}
.range:has(>.seg>input:nth-of-type(1):checked)>.range-panel:nth-of-type(1),.range:has(>.seg>input:nth-of-type(2):checked)>.range-panel:nth-of-type(2),.range:has(>.seg>input:nth-of-type(3):checked)>.range-panel:nth-of-type(3),.range:has(>.seg>input:nth-of-type(4):checked)>.range-panel:nth-of-type(4){display:block}
}

/* Charts */
.chart{margin:0;min-width:0}

/* Line chart: a y-axis column, then the plot: the grid and labels, the curves (a stretched viewBox,
   non-scaling strokes) and the points layer (a focusable column per point with its tooltip), stacked
   in one grid cell. This year's line is cyan with a fill underneath (#g-area, ChartDefs); earlier
   years are thinner behind it. The curves draw in from the left whenever a panel appears. */
.lc{display:grid;grid-template-columns:44px minmax(0,1fr);margin-top:4px}
.lc svg{display:block;overflow:visible}
.lc-plot{display:grid;min-width:0}
.lc-plot>svg{grid-area:1/1}
/* The curves' draw-in clip makes their layer paint (and hit-test) above the points layer, so only
   the points layer takes the pointer, and it stays on top. */
.lc-grid,.lc-lines{pointer-events:none}
.lc-points{position:relative}
.cc-y text{fill:${K.soft};font-size:12px;font-weight:600;font-variant-numeric:tabular-nums}
.lc-grid .grid{stroke:rgba(255,255,255,.08);stroke-dasharray:4 4}
.lc-grid .base{stroke:rgba(255,255,255,.16)}
.tick{fill:${K.soft};font-size:12px;font-weight:600;font-variant-numeric:tabular-nums}
.tick.is-now{fill:${K.text};font-weight:800}
.lc-lines{animation:lc-draw 1.4s cubic-bezier(.3,.7,.2,1) both}
.area{fill:url(#g-area) rgba(44,217,255,.12);stroke:none}
.ln{fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.ln-0{stroke-width:3.25}.ln-1{opacity:.9}.ln-2{opacity:.75}.ln-3{opacity:.6}.ln-4{opacity:.5}
${CHART.years.map((c, k) => `.ln-${k}{stroke:${c}}.dot-${k}{fill:${c}}.sw-${k}{background:${c}}`).join("")}
.dot-now{fill:${K.text};stroke:${CHART.years[0]};stroke-width:3}
.pt{outline:none}
.pt-hit{fill:transparent}
.pt:focus-visible .pt-hit{fill:rgba(0,117,255,.1);stroke:${K.cyan};stroke-width:2}
.pt{cursor:crosshair}
.dot{stroke:${K.text};stroke-width:2;opacity:0;transition:opacity .12s ease}
.pt:hover .dot,.pt:focus-visible .dot{opacity:1}
.tip{opacity:0;pointer-events:none;transition:opacity .12s ease}
.pt:hover .tip,.pt:focus-visible .tip{opacity:1}
.tip-box{fill:${K.navy};stroke:rgba(255,255,255,.14);filter:drop-shadow(0 8px 16px rgba(0,0,0,.5))}
.tip-name{fill:${K.soft};font-size:12px;font-weight:600}
.tip-row{fill:${K.soft};font-size:13px;font-weight:600;font-variant-numeric:tabular-nums}
.tip-value{fill:${K.text};font-size:13px;font-weight:700;font-variant-numeric:tabular-nums}
.tip-guide{stroke:rgba(44,217,255,.5);stroke-dasharray:2 3}
fieldset.lc-legend{display:flex;flex-wrap:wrap;gap:6px;margin:14px 0 0 44px;padding:0;border:0;border-radius:0;background:none;box-shadow:none;-webkit-backdrop-filter:none;backdrop-filter:none;${ty("micro")}}
.lg{display:inline-flex;align-items:center;gap:7px;min-height:32px;padding:0 10px;border:1px solid rgba(255,255,255,.1);border-radius:8px;cursor:pointer;user-select:none;transition:opacity .15s ease,border-color .15s ease}
.lg:hover{border-color:rgba(255,255,255,.28)}
.yr:focus-visible+.lg{outline:2px solid ${K.cyan};outline-offset:1px}
.yr:not(:checked)+.lg{opacity:.45}
.yr:not(:checked)+.lg .sw{background:none;box-shadow:inset 0 0 0 1.5px currentColor}
.sw{display:inline-block;width:14px;height:4px;border-radius:2px}
.lg-label{font-weight:700;color:${K.text}}
.lg-total{color:${K.soft};font-variant-numeric:tabular-nums}
/* Legend: hovering a year dims the other lines; unticking one hides its line, its dots and its tooltip row. */
.ln,.area{transition:opacity .2s ease}
${CHART.years
  .map(
    (_, k) =>
      `.chart-lines:has(.lg-${k}:hover) .ln:not(.ln-${k}),.chart-lines:has(.lg-${k}:hover) .area${k ? "" : ":not(*)"}{opacity:.12}` +
      `.chart-lines:has(.yr-${k}:not(:checked)) :is(.ln-${k},.dot-${k},.row-${k}${k ? "" : ",.area,.dot-now"}){display:none}`,
  )
  .join("\n")}
@keyframes lc-draw{from{clip-path:inset(0 100% 0 0)}to{clip-path:inset(0 0 0 0)}}
/* Switching Week / Month / Year: the new panel fades and rises in. */
.range-panel{animation:panel-in .6s cubic-bezier(.2,.7,.2,1) both}
@keyframes panel-in{from{opacity:0;transform:translateY(6px)}}
@media (max-width:479px){.tick-wide{display:none}}

/* Heatmap: 7 x 24, Monday first; dim navy for a few plays, then muted amber, orange and red at the
   peak; never colour alone (each cell's title, the summary). Empty cells sit darker than the card. */
.hm{display:grid;grid-template-columns:30px repeat(24,minmax(0,1fr));gap:3px;margin-top:4px}
.hc{display:block;aspect-ratio:1;border-radius:3px;background:${CHART.heatEmpty}}
${heat}
.hm>.hc:hover{outline:2px solid ${K.text};outline-offset:-1px}
.hm-day{align-self:center;${ty("micro")};font-weight:600;color:${K.soft}}
.hm-corner{grid-column:1}
.hm-hour{grid-column:span 6;padding-top:6px;${ty("micro")};font-weight:600;color:${K.soft};white-space:nowrap}
.hm-legend{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:14px;${ty("micro")};font-weight:600;color:${K.soft}}
.hm-legend .hc{width:12px;height:12px;aspect-ratio:auto}
.hm-none{display:inline-flex;align-items:center;gap:6px;margin-left:10px}
.hm-legend .hc.l0{box-shadow:inset 0 0 0 1px rgba(255,255,255,.22)}

/* Meters and bar lists */
.meter{display:block;height:6px;overflow:visible}
.meter-track{fill:rgba(255,255,255,.08)}
.meter-fill{fill:${K.blue}}
.meter-second .meter-fill{fill:${K.cyan}}
.meter-bar .meter-fill{fill:${K.blue}}
.bars{list-style:none;display:grid;gap:14px;margin:0;padding:0}
.bars>li{display:flex;align-items:center;gap:12px;min-width:0}
.bar-text{flex:1;min-width:0;display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:baseline;gap:6px 12px}
.bar-label{font-weight:650;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bar-label a{color:${K.text};text-decoration:none}
.bar-label a:hover{text-decoration:underline}
.bar-value{${ty("micro")};font-weight:600;color:${K.soft};font-variant-numeric:tabular-nums;white-space:nowrap}
.bar-text>.meter{grid-column:1/-1}

/* Covers, avatars, the missing-art tile */
.cover,.avatar{display:block;flex:none;object-fit:cover;border-radius:12px;background:${MISSING_ART};box-shadow:0 0 0 1px rgba(255,255,255,.06)}
.avatar,.cover.round{border-radius:50%}
.cover-40{width:40px;height:40px}
.cover-48{width:48px;height:48px}
.cover-56{width:56px;height:56px}
.cover-72{width:72px;height:72px}
.avatar-blank{display:grid;place-items:center;background:linear-gradient(135deg,${K.raised},${K.navy});color:${K.soft};font-weight:700}
.avatar-blank.cover-56{font-size:22px}

/* Track rows: rank, cover, title / artists / meter with the count. */
.tracks{list-style:none;display:grid;gap:4px;margin:0;padding:0}
.track{display:grid;grid-template-columns:18px 48px minmax(0,1fr);align-items:center;gap:12px;padding:6px 0}
.track-rank{font-weight:700;color:${K.mute};text-align:center}
.track:first-child .track-rank{color:${K.text}}
.track-text{min-width:0}
.track-name{display:block;color:${K.text};font-weight:650;text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.track-name:hover{color:${K.text};text-decoration:underline}
.track-artist{display:block;${ty("meta")};color:${K.soft};overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.track-meter{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:10px;margin-top:6px}
.track-plays{${ty("micro")};font-weight:600;color:${K.soft};white-space:nowrap}

/* Streak dots (filled with a check when played, a ring when not, dashed when still to come) and the best day. */
.home-streak .big{margin-top:-4px}
.streak-text{${ty("meta")};margin:4px 0 0}
.dots{list-style:none;display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:6px;margin:20px 0 0;padding:0}
.dot{position:relative;display:grid;justify-items:center;gap:6px}
.dot-mark{position:relative;z-index:1;display:grid;place-items:center;width:28px;height:28px;border-radius:50%;border:2px solid rgba(255,255,255,.14);background:${K.navy}}
.dot.is-on .dot-mark{border-color:${K.blue};background:${K.blue};box-shadow:0 6px 14px -6px rgba(0,117,255,.9)}
.dot.is-on .dot-mark::after{content:"";width:10px;height:5px;margin-top:-3px;border-left:2px solid ${K.text};border-bottom:2px solid ${K.text};transform:rotate(-45deg)}
.dot.is-on+.dot.is-on::before{content:"";position:absolute;top:13px;right:50%;width:calc(100% + 6px);height:2px;background:${K.blue}}
.dot.is-future .dot-mark{border-style:dashed;border-color:rgba(160,174,192,.35);background:transparent}
.dot-day{${ty("micro")};font-weight:600;color:${K.soft}}
.dot.is-today .dot-day{color:${K.text};font-weight:800}
.best{margin-top:20px;padding-top:16px;background:${GLASS.divider} top / 100% 1px no-repeat}
.best h3{${ty("micro")};color:${K.soft};font-weight:700;text-transform:uppercase;letter-spacing:.08em;margin:0 0 6px}
.best p{margin:0}
.best-day{display:block;${ty("title")};font-weight:700}
.best-plays{${ty("meta")};color:${K.soft}}

/* New to you: the split bar and the new artists. */
.split{margin:16px 0 0}
.split-bar{display:block;overflow:visible}
.split-track{fill:rgba(255,255,255,.08)}
.split-accent{fill:${K.blue}}
.split-second{fill:${K.cyan}}
.split-gap{fill:#080d2a}
.split-legend{list-style:none;display:grid;gap:6px;margin:12px 0 0;padding:0}
.split-legend li{display:flex;align-items:center;gap:8px;${ty("meta")}}
.key{flex:none;width:10px;height:10px;border-radius:3px}
.key-accent{background:${K.blue}}
.key-second{background:${K.cyan}}
.split-label{flex:1;color:${K.soft}}
.split-value{font-variant-numeric:tabular-nums}
.people{list-style:none;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin:0;padding:0}
.people li{display:grid;justify-items:center;gap:6px;min-width:0;text-align:center}
.people a{max-width:100%;color:${K.text};${ty("meta")};font-weight:650;text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.people a:hover{color:${K.text};text-decoration:underline}
.people .muted{${ty("micro")}}

/* Throwbacks */
.throwbacks{list-style:none;display:grid;gap:14px;margin:0;padding:0}
.throwbacks li{display:flex;align-items:center;gap:14px;min-width:0}
.tb-text{min-width:0}
.tb-when{display:block;${ty("micro")};color:${K.cyan};font-weight:700;text-transform:uppercase;letter-spacing:.08em}
.tb-name{display:block;color:${K.text};font-weight:650;text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tb-name:hover{color:${K.text};text-decoration:underline}
.tb-meta{display:block;${ty("meta")};color:${K.soft};overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* Empty states: what's missing and what happens next. */
.empty{display:grid;justify-items:start;gap:4px;padding:18px;border-radius:15px;background:${K.well};border:1px dashed rgba(255,255,255,.12)}
.empty-icon{display:grid;place-items:center;width:36px;height:36px;margin-bottom:8px;border-radius:12px;background:${TINT.blue};color:${K.blue}}
.empty-icon .icon{width:18px;height:18px}
.empty-title{margin:0;font-weight:700}
.empty-text{margin:0;${ty("meta")};color:${K.soft}}
.empty-action{margin-top:12px}

@media (min-width:640px){
.home{grid-template-columns:repeat(6,minmax(0,1fr));gap:20px;grid-auto-flow:row dense}
.home>*{grid-column:1/-1}
.home>.home-streak,.home>.home-tracks,.home>.home-artists,.home>.home-sound,.home>.home-new,.home>.home-throwback{grid-column:span 3}
.home-sofar{grid-template-columns:repeat(2,minmax(0,1fr));gap:20px}
.hero{grid-template-columns:auto minmax(0,1fr);justify-items:start;align-items:center;gap:32px;padding:28px;text-align:left}
.hero-cover{width:clamp(180px,22vw,280px)}
.hero-text,.hero-head,.hero-plays{justify-items:start;justify-content:flex-start}
.hero-track{${ty("hero")}}
.tile-icon{width:45px;height:45px}
.tile-icon .icon{width:22px;height:22px}
.range{grid-template-columns:minmax(0,1fr) auto}
fieldset.seg{justify-self:end}
}
@media (min-width:1024px){
.home{grid-template-columns:repeat(12,minmax(0,1fr));gap:24px;grid-auto-flow:row}
.home>.hero{grid-column:span 7}
.home>.home-sofar{grid-column:span 5;grid-template-columns:minmax(0,1fr);gap:24px}
.home>.home-days{grid-column:span 8}
.home>.home-streak{grid-column:span 4}
.home>.home-tracks{grid-column:span 5}
.home>.home-artists{grid-column:span 4}
.home>.home-sound{grid-column:span 3}
.home>.home-hours{grid-column:span 7}
.home>.home-new{grid-column:span 5}
.home>.home-days{grid-row:span 2}
.home>.home-throwback{grid-column:span 4}
.home.is-new>.hero{grid-column:1/-1}
}
`;
