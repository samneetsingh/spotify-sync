// The new Home's styles: the 12-column grid, the vinyl hero, stat tiles, charts (columns, range
// switch, heatmap, meters, split bar, streak dots), track and artist rows, empty states, the status
// banner and the settings widget. Owner: builder U. Shared classes (card, chip, switch, btn, notice,
// tables) are in base.ts. Colours are classes, never attributes, so the CSP's no-`style=` rule holds.

import { CHART, COLOR as K, FONT, LINE, LINE_STRONG, SHADOW, TINT, ty } from "../tokens";

const RAISED = `linear-gradient(180deg,${K.raisedTop},${K.raised})`;
const PANEL = `linear-gradient(180deg,${K.panelTop},${K.panelBottom})`;

/** The missing-art tile: a small record with an apricot label on an apricot wash (also behind every cover, so a broken image shows it). */
const MINI_VINYL =
  "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><circle cx='12' cy='12' r='11' fill='#15172a' stroke='#3a3d6b' stroke-width='.8'/>" +
  "<circle cx='12' cy='12' r='8.5' fill='none' stroke='#2a2d52' stroke-width='.7'/><circle cx='12' cy='12' r='6.5' fill='none' stroke='#2a2d52' stroke-width='.7'/>" +
  "<circle cx='12' cy='12' r='4' fill='#ffb454'/><circle cx='12' cy='12' r='1' fill='#15172a'/></svg>";
const MISSING_ART = `url("data:image/svg+xml,${encodeURIComponent(MINI_VINYL)}") center / 56% no-repeat,linear-gradient(145deg,rgba(255,180,84,.30),rgba(255,180,84,.10)) ${K.raised}`;

const heat = CHART.heat.map((c, i) => `.hc.l${i + 1}{background:${c}}`).join("");

export const HOME_CSS = `
/* Grid: one column on phones, 6 from 640px, 12 from 1024px (page padding 16 / 32 / 48 in base). */
.home{display:grid;grid-template-columns:minmax(0,1fr);gap:16px}
.home .card{margin:0;min-width:0}
.home-status{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px}
.home-sofar{display:grid;gap:16px;min-width:0}
.head-meta{${ty("meta")};color:${K.mute}}
.sub-title{${ty("meta")};font-weight:650;color:${K.mute};margin:20px 0 8px}
.card-head+.sub-title,.card-head+.switch-group{margin-top:0}
.big{display:flex;align-items:baseline;flex-wrap:wrap;gap:4px 10px;margin:0}
.big-value{font-family:${FONT.display};${ty("number")};font-weight:700;letter-spacing:-.02em}
.big-unit{${ty("title")};color:${K.soft}}

/* Status banner: slim, red, says what's wrong and what to do. */
.banner{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;padding:8px 8px 8px 14px;border-radius:14px;background:linear-gradient(90deg,rgba(255,123,136,.2),rgba(255,123,136,.08));border:1px solid rgba(255,123,136,.4)}
.banner-icon{flex:none;display:grid;place-items:center;width:22px;height:22px;border-radius:50%;background:${K.bad};color:${K.ink};font-size:14px;font-weight:800;line-height:1}
.banner-text{flex:1 1 220px;margin:0;color:${K.text}}
.banner-action{display:inline-flex;align-items:center;min-height:44px;padding:0 18px;border-radius:999px;background:${K.bad};color:#2a0a0e;font-weight:700;text-decoration:none;white-space:nowrap}
.banner-action:hover{background:#ff94a0}

/* Hero: the song of the week on the record, over faint grooves. */
.hero{display:grid;justify-items:center;gap:20px;padding:28px 20px;text-align:center;overflow:hidden;background:radial-gradient(520px 360px at 50% 18%,rgba(255,180,84,.09),transparent 70%),${PANEL}}
.vinyl{position:relative;width:min(240px,68vw);aspect-ratio:1}
.vinyl::before{content:"";position:absolute;inset:-55%;border-radius:50%;background:repeating-radial-gradient(circle at 50% 46.3%,rgba(255,255,255,.025) 0 1px,transparent 1.5px 7px);-webkit-mask-image:radial-gradient(closest-side,#000 55%,transparent);mask-image:radial-gradient(closest-side,#000 55%,transparent);pointer-events:none}
.vinyl-spin{position:absolute;inset:0}
.vinyl-cover{position:absolute;left:30.093%;top:26.389%;width:39.815%;height:39.815%;object-fit:cover;background:radial-gradient(circle,${K.panelBottom} 0 5%,transparent 5.5%),radial-gradient(circle at 35% 30%,#ffd08f,${K.accent} 45%,#e0892f);animation:vinyl-settle 2.8s cubic-bezier(.15,.7,.2,1) .1s both}
.vinyl-blank{display:block;border-radius:50%}
.vinyl-disc{position:absolute;inset:0;width:100%;height:100%}
@keyframes vinyl-settle{from{transform:rotate(-320deg)}to{transform:rotate(0)}}
.hero-text{display:grid;justify-items:center;gap:8px;min-width:0;max-width:100%}
.hero-head{display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:8px}
.hero-label{${ty("meta")};font-family:${FONT.body};font-weight:650;letter-spacing:0;color:${K.accent}}
.hero-when{${ty("micro")};padding:2px 10px;border-radius:999px;background:${TINT.neutral};color:${K.soft};font-weight:650}
.hero-track{margin:0;font-family:${FONT.display};${ty("heroPhone")};font-weight:700;letter-spacing:-.025em;text-wrap:balance;overflow-wrap:anywhere}
.hero-track a{color:${K.text};text-decoration:none}
.hero-track a:hover{text-decoration:underline;text-decoration-thickness:2px;text-underline-offset:6px}
.hero-artist{margin:0;${ty("title")};color:${K.soft};text-wrap:balance;overflow-wrap:anywhere}
.hero.is-empty .hero-artist{${ty("body")}}
.hero-plays{display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:8px 10px;margin:8px 0 0;${ty("meta")}}
.plays-badge{display:inline-flex;align-items:center;min-height:28px;padding:0 12px;border-radius:999px;background:${K.accent};color:${K.onAccent};font-weight:700;box-shadow:0 0 18px -4px rgba(255,180,84,.55)}
.hero-actions{margin-top:12px}

/* Stat tiles: inset wells, the value above its label, the delta under both. */
.tiles{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin:0}
.tile{display:flex;flex-direction:column;min-width:0;padding:14px 14px 12px;border-radius:12px;background:${K.well};box-shadow:${SHADOW.well}}
.tile dt{order:2;${ty("meta")};color:${K.soft}}
.tile-value{order:1;margin:0;font-family:${FONT.display};${ty("number")};font-weight:650;letter-spacing:-.02em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tile-delta{order:3;margin:6px 0 0}
.delta{display:inline-flex;align-items:center;gap:2px;${ty("micro")};font-weight:700;font-variant-numeric:tabular-nums}
.delta-up{color:${K.ok}}
.delta-down{color:${K.bad}}
.delta-same{color:${K.mute}}
.sofar .note{margin-top:12px}

/* Range switch: a segmented radio group; :has() shows the checked option's panel. */
.range{display:grid;grid-template-columns:minmax(0,1fr);align-items:center;gap:12px}
.range>.range-panel{grid-column:1/-1;min-width:0}
fieldset.seg{display:inline-flex;justify-self:start;gap:2px;margin:0;padding:3px;border:0;border-radius:999px;background:${K.well};box-shadow:${SHADOW.well}}
.seg label{display:inline-flex;align-items:center;min-height:38px;padding:0 16px;border-radius:999px;color:${K.soft};${ty("meta")};font-weight:650;cursor:pointer;user-select:none}
.seg label:hover{color:${K.text}}
.seg input:checked+label{background:${RAISED};color:${K.text};box-shadow:${SHADOW.raised}}
.seg input:focus-visible+label{outline:2px solid ${K.accent};outline-offset:1px}
@supports selector(:has(*)){
.range>.range-panel{display:none}
.range:has(>.seg>input:nth-of-type(1):checked)>.range-panel:nth-of-type(1),.range:has(>.seg>input:nth-of-type(2):checked)>.range-panel:nth-of-type(2),.range:has(>.seg>input:nth-of-type(3):checked)>.range-panel:nth-of-type(3),.range:has(>.seg>input:nth-of-type(4):checked)>.range-panel:nth-of-type(4){display:block}
}

/* Charts */
.chart{margin:0;min-width:0}
details.numbers{margin-top:4px;border-top:0;padding-top:0}
details.numbers>summary{display:inline-flex;min-height:44px;${ty("meta")};font-weight:600;color:${K.soft}}
details.numbers .table-wrap{margin-top:4px;max-height:340px;overflow:auto}
details.numbers th,details.numbers td{padding:6px 10px;white-space:nowrap}

/* Column chart: a y-axis column, then the plot (x in %, y in px); tooltips in the band above it. */
.cc{display:grid;grid-template-columns:44px minmax(0,1fr);margin-top:4px}
.cc svg{display:block;overflow:visible}
.cc-y text{fill:${K.mute};font-size:12px;font-variant-numeric:tabular-nums}
.cc-plot .grid{stroke:${LINE_STRONG};stroke-dasharray:2 5}
.cc-plot .base{stroke:rgba(255,255,255,.22)}
.tick{fill:${K.mute};font-size:12px;font-variant-numeric:tabular-nums}
.tick.is-now{fill:${K.text};font-weight:700}
.col{outline:none}
.col-hit{fill:transparent}
.col-bar{fill:${CHART.bar}}
.col.is-now .col-bar{fill:${CHART.highlight}}
.col-zero{fill:rgba(185,186,211,.3)}
.col-future{fill:none;stroke:rgba(143,145,179,.55);stroke-width:1;stroke-dasharray:3 2}
.col:hover .col-bar{fill:#7579c9}
.col.is-now:hover .col-bar{fill:#ffc477}
.col:focus-visible .col-hit{fill:rgba(255,180,84,.07);stroke:${K.accent};stroke-width:2}
.tip{opacity:0;pointer-events:none;transition:opacity .12s ease}
.col:hover .tip,.col:focus-visible .tip{opacity:1}
.tip-box{fill:#2c2f55;stroke:${LINE_STRONG};filter:drop-shadow(0 6px 12px rgba(0,0,0,.45))}
.tip-name{fill:${K.soft};font-size:12px}
.tip-value{fill:${K.text};font-size:14px;font-weight:700;font-variant-numeric:tabular-nums}
.tip-guide{stroke:rgba(255,180,84,.55);stroke-dasharray:2 3}
@media (max-width:479px){.tick-wide{display:none}}

/* Heatmap: 7 x 24, Monday first; levels low to high, never colour alone (titles, the table). */
.hm{display:grid;grid-template-columns:30px repeat(24,minmax(0,1fr));gap:2px;margin-top:4px}
.hc{display:block;aspect-ratio:1;border-radius:3px;background:${CHART.heatEmpty}}
${heat}
.hm>.hc:hover{outline:2px solid ${K.text};outline-offset:-1px}
.hm-day{align-self:center;${ty("micro")};color:${K.mute}}
.hm-corner{grid-column:1}
.hm-hour{grid-column:span 6;padding-top:6px;${ty("micro")};color:${K.mute};white-space:nowrap}
.hm-legend{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:12px;${ty("micro")};color:${K.mute}}
.hm-legend .hc{width:12px;height:12px;aspect-ratio:auto}
.hm-none{display:inline-flex;align-items:center;gap:6px;margin-left:10px}
.hm-legend .hc.l0{box-shadow:inset 0 0 0 1px rgba(255,255,255,.18)}

/* Meters and bar lists */
.meter{display:block;height:6px;overflow:visible}
.meter-track{fill:rgba(255,255,255,.07)}
.meter-fill{fill:${K.accent}}
.meter-second .meter-fill{fill:${K.second}}
.meter-bar .meter-fill{fill:${CHART.bar}}
.bars{list-style:none;display:grid;gap:14px;margin:0;padding:0}
.bars>li{display:flex;align-items:center;gap:12px;min-width:0}
.bar-text{flex:1;min-width:0;display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:baseline;gap:6px 12px}
.bar-label{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bar-label a{color:${K.text};text-decoration:none}
.bar-label a:hover{text-decoration:underline}
.bar-value{${ty("micro")};color:${K.soft};font-variant-numeric:tabular-nums;white-space:nowrap}
.bar-text>.meter{grid-column:1/-1}

/* Covers, avatars, the missing-art tile */
.cover,.avatar{display:block;flex:none;object-fit:cover;border-radius:8px;background:${MISSING_ART};box-shadow:0 0 0 1px ${LINE}}
.avatar,.cover.round{border-radius:50%}
.cover-40{width:40px;height:40px}
.cover-48{width:48px;height:48px}
.cover-56{width:56px;height:56px}
.cover-72{width:72px;height:72px}
.avatar-blank{display:grid;place-items:center;background:${RAISED};color:${K.soft};font-family:${FONT.display};font-weight:700;box-shadow:${SHADOW.raised}}
.avatar-blank.cover-56{font-size:22px}

/* Track rows: rank, cover, title / artists / meter with the count. */
.tracks{list-style:none;display:grid;gap:4px;margin:0;padding:0}
.track{display:grid;grid-template-columns:18px 48px minmax(0,1fr);align-items:center;gap:12px;padding:6px 0}
.track-rank{font-family:${FONT.display};font-weight:700;color:${K.mute};text-align:center}
.track:first-child .track-rank{color:${K.accent}}
.track-text{min-width:0}
.track-name{display:block;color:${K.text};font-weight:650;text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.track-name:hover{text-decoration:underline}
.track-artist{display:block;${ty("meta")};color:${K.soft};overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.track-meter{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:10px;margin-top:6px}
.track-plays{${ty("micro")};color:${K.soft};white-space:nowrap}

/* Streak dots (filled with a check when played, a ring when not, dashed when still to come) and the best day. */
.home-streak .big{margin-top:-4px}
.streak-text{${ty("meta")};margin:4px 0 0}
.dots{list-style:none;display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:6px;margin:20px 0 0;padding:0}
.dot{position:relative;display:grid;justify-items:center;gap:6px}
.dot-mark{position:relative;z-index:1;display:grid;place-items:center;width:28px;height:28px;border-radius:50%;border:2px solid rgba(185,186,211,.35);background:${K.well}}
.dot.is-on .dot-mark{border-color:${K.accent};background:${K.accent};box-shadow:0 0 12px -2px rgba(255,180,84,.5)}
.dot.is-on .dot-mark::after{content:"";width:10px;height:5px;margin-top:-3px;border-left:2px solid ${K.onAccent};border-bottom:2px solid ${K.onAccent};transform:rotate(-45deg)}
.dot.is-on+.dot.is-on::before{content:"";position:absolute;top:13px;right:50%;width:calc(100% + 6px);height:2px;background:${K.accent}}
.dot.is-future .dot-mark{border-style:dashed;border-color:rgba(143,145,179,.35);background:transparent}
.dot-day{${ty("micro")};color:${K.mute}}
.dot.is-today .dot-day{color:${K.text};font-weight:700}
.best{margin-top:20px;padding-top:16px;border-top:1px solid ${LINE}}
.best h3{${ty("meta")};color:${K.mute};font-weight:650;margin:0 0 4px}
.best p{margin:0}
.best-day{display:block;font-family:${FONT.display};${ty("title")};font-weight:650}
.best-plays{${ty("meta")};color:${K.soft}}

/* New to you: the split bar and the new artists. */
.split{margin:16px 0 0}
.split-bar{display:block;overflow:visible}
.split-track{fill:rgba(255,255,255,.07)}
.split-accent{fill:${K.accent}}
.split-second{fill:${K.second}}
.split-gap{fill:${K.panelBottom}}
.split-legend{list-style:none;display:grid;gap:6px;margin:12px 0 0;padding:0}
.split-legend li{display:flex;align-items:center;gap:8px;${ty("meta")}}
.key{flex:none;width:10px;height:10px;border-radius:3px}
.key-accent{background:${K.accent}}
.key-second{background:${K.second}}
.split-label{flex:1;color:${K.soft}}
.split-value{font-variant-numeric:tabular-nums}
.people{list-style:none;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin:0;padding:0}
.people li{display:grid;justify-items:center;gap:6px;min-width:0;text-align:center}
.people a{max-width:100%;color:${K.text};${ty("meta")};font-weight:650;text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.people a:hover{text-decoration:underline}
.people .muted{${ty("micro")}}

/* Throwbacks */
.throwbacks{list-style:none;display:grid;gap:14px;margin:0;padding:0}
.throwbacks li{display:flex;align-items:center;gap:14px;min-width:0}
.tb-text{min-width:0}
.tb-when{display:block;${ty("micro")};color:${K.accent};font-weight:650}
.tb-name{display:block;color:${K.text};font-weight:650;text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tb-name:hover{text-decoration:underline}
.tb-meta{display:block;${ty("meta")};color:${K.soft};overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* Emails */
.digest-subject{margin:0 0 2px;font-family:${FONT.display};${ty("title")};font-weight:650;overflow-wrap:anywhere}
.digest-last .meta{margin:0}

/* Settings widget (the toggle redirects to /#settings) */
.home-settings{scroll-margin-top:16px}
.switch-group{${ty("meta")};font-weight:650;color:${K.mute};margin:16px 0 0}
.switches{list-style:none;margin:0;padding:0}
.switches>li{border-bottom:1px solid ${LINE}}
.switches>li:last-child{border-bottom:0}
.switches form{display:block}
.switch-link{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:44px;padding:6px 0}
.switch-link a{display:inline-flex;align-items:center;min-height:44px;${ty("meta")};font-weight:650;text-align:right}

/* Empty states: what's missing and what happens next. */
.empty{display:grid;justify-items:start;gap:4px;padding:20px;border-radius:12px;background:${K.well};box-shadow:${SHADOW.well}}
.empty-icon{width:32px;height:32px;margin-bottom:6px}
.empty-title{margin:0;font-weight:650}
.empty-text{margin:0;${ty("meta")};color:${K.soft}}
.empty-action{margin-top:12px}
.mini-vinyl .mv-disc{fill:${K.panelBottom};stroke:#3a3d6b;stroke-width:.8}
.mini-vinyl .mv-groove{fill:none;stroke:#2a2d52;stroke-width:.7}
.mini-vinyl .mv-label{fill:${K.accent}}
.mini-vinyl .mv-hole{fill:${K.panelBottom}}

@media (min-width:640px){
.home{grid-template-columns:repeat(6,minmax(0,1fr));gap:20px}
.home>*{grid-column:1/-1}
.home>.home-streak,.home>.home-tracks,.home>.home-artists,.home>.home-sound,.home>.home-new,.home>.home-throwback,.home>.home-digests,.home>.home-settings{grid-column:span 3}
.home-sofar{grid-template-columns:repeat(2,minmax(0,1fr));gap:20px}
.hero{grid-template-columns:auto minmax(0,1fr);justify-items:start;align-items:center;gap:32px;padding:32px;text-align:left;background:radial-gradient(560px 420px at 18% 40%,rgba(255,180,84,.09),transparent 70%),${PANEL}}
.vinyl{width:clamp(220px,26vw,380px)}
.hero-text,.hero-head,.hero-plays{justify-items:start;justify-content:flex-start}
.hero-track{${ty("hero")}}
.range{grid-template-columns:minmax(0,1fr) auto}
fieldset.seg{justify-self:end}
}
@media (min-width:1024px){
.home{grid-template-columns:repeat(12,minmax(0,1fr))}
.home>.hero{grid-column:span 7}
.home>.home-sofar{grid-column:span 5;grid-template-columns:minmax(0,1fr)}
.home>.home-days{grid-column:span 8}
.home>.home-streak{grid-column:span 4}
.home>.home-tracks{grid-column:span 5}
.home>.home-artists{grid-column:span 4}
.home>.home-sound{grid-column:span 3}
.home>.home-hours{grid-column:span 7}
.home>.home-new{grid-column:span 5}
.home>.home-throwback,.home>.home-digests,.home>.home-settings{grid-column:span 4}
.home.is-new>.hero{grid-column:1/-1}
.home.is-new>.home-digests,.home.is-new>.home-settings{grid-column:span 6}
.sofar .tiles{grid-template-columns:repeat(4,minmax(0,1fr))}
}
`;
