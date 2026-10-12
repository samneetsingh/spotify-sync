// The dashboard's base stylesheet: the "After hours" look (src/dashboard/tokens.ts, tasks/home-design.md)
// for every shared class. styles/index.ts appends the per-page parts after it, so they can override.
// renderPage inlines it in one <style nonce> element; the CSP blocks `style=` attributes, so markup
// uses these classes only. Mobile-first: base rules are the phone layout, min-width blocks upgrade.
//
// Display font: Bricolage Grotesque (SIL OFL 1.1), self-hosted as a variable (opsz 12-96, wght 200-800)
// woff2, Latin subset, in public/fonts with its OFL.txt. Sources:
//   https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,200..800&display=swap
//     (requested with a Chrome User-Agent; the `latin` file is
//     https://fonts.gstatic.com/s/bricolagegrotesque/v9/3y9K6as8bTXq_nANBjzKo3IeZx8z6up5BeSl9D4dj_x9PpZBMlGIInHWVyNJ.woff2)
//   https://github.com/google/fonts/blob/main/ofl/bricolagegrotesque/OFL.txt
//
// Class guide (shared by every page):
// - Page: `main` is the dashboard column (760px); `main.narrow` a centred column (landing);
//   `main.wide` the Home grid (up to 1600px); `main.hide-title` keeps the <h1> for screen readers only.
// - `.vh`: visually hidden, still read by screen readers. `.skip`: the skip link.
// - Text: `.lead` an intro sentence; `.note` a small muted note; `.muted`, `.soft` text colours;
//   `.small` meta size; `.sub` a muted second line under a value (block); `.num` tabular figures;
//   `.h-section` a 24px section heading outside a card.
// - `.card`: a panel (gradient, hairline, shadow) with `.card-head` (the h2 plus e.g. a pill),
//   `.actions` (a row of buttons) and `.card-foot` (a footer link row).
// - `.facts`: label/value rows (<dl>).
// - `.pill pill-{ok,warn,bad,neutral}`: a status label (text plus a dot; not a link).
// - `.chip chip-{tone}`: a status link (Chip primitive), e.g. Home's sync status to /manage.
// - `.switch`: a settings toggle row (Switch primitive): label, state word, track and knob.
// - `.btn btn-{primary,secondary,danger}`, `.btn-small` (36px, with a 44px hit area), `.btn-block`.
// - `.notice notice-{ok,warn,error}`: a flash message or banner, with an icon and a coloured edge.
// - `.rows`: a list of rows with `.main`, `.meta`, `.side` and `.row-actions`; `.error-text` an error.
// - `details`/`summary`: a disclosure; `.tags`: wrapped link chips.
// - Tables: `table` (tabular figures), `th`/`td.num` right-aligned numbers, `.table-wrap` scrolls.
// - Forms: `fieldset` (a panel) and `legend`; `.setting` rows (`.control`, `.desc`, `.meta-row`,
//   `.source`, `.confirm`, `.gated`, `.field`, `.field-error`); `.help` help text; inputs, select,
//   checkbox, radio, file, progress; `.savebar` a sticky save row.
// - Landing: `.disc` and `.disc-label`, the decorative record.

import { COLOR as K, DISPLAY_FONT_URL, FONT, LINE, LINE_STRONG, SHADOW, TINT, ty } from "../tokens";

/** A 3% grain over the page (an SVG noise tile; img-src allows data: URIs). */
const NOISE_SVG =
  "<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='2' stitchTiles='stitch'/>" +
  "<feColorMatrix values='0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 1 0'/></filter><rect width='100%' height='100%' filter='url(#n)' opacity='.03'/></svg>";
const NOISE = `url("data:image/svg+xml,${encodeURIComponent(NOISE_SVG)}")`;

/** The Latin subset's unicode-range, as Google Fonts serves it. */
const LATIN =
  "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD";

const RAISED = `linear-gradient(180deg,${K.raisedTop},${K.raised})`;
const PANEL = `linear-gradient(180deg,${K.panelTop},${K.panelBottom})`;
const RING = `outline:2px solid ${K.accent};outline-offset:2px`;

export const BASE_CSS = `@font-face{font-family:"Bricolage Grotesque";font-style:normal;font-weight:200 800;font-stretch:100%;font-display:swap;src:url(${DISPLAY_FONT_URL}) format("woff2");unicode-range:${LATIN}}
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;background:${K.ink};color-scheme:dark}
body{margin:0;min-height:100vh;background:${NOISE},radial-gradient(1200px 600px at 20% -10%,rgba(255,180,84,.06),transparent 70%) no-repeat,${K.ink};color:${K.text};font-family:${FONT.body};${ty("body")};-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}
a{color:${K.accent};text-decoration-thickness:1px;text-underline-offset:3px}
a:hover{text-decoration-thickness:2px}
:focus-visible{${RING}}
::selection{background:rgba(255,180,84,.35);color:${K.text}}
p{margin:0 0 12px}
h1,h2,.h-section{font-family:${FONT.display};font-weight:700;letter-spacing:-.01em;text-wrap:balance}
h1{font-size:30px;line-height:36px;letter-spacing:-.02em;margin:0 0 24px}
h2{${ty("title")};font-weight:650;margin:0}
.h-section{${ty("section")};margin:0 0 16px}
h3{${ty("body")};font-weight:650;margin:0 0 4px}
code{font-family:${FONT.mono};font-size:14px;padding:1px 6px;border-radius:6px;background:${K.well};color:${K.soft}}
strong,b{font-weight:650}
img{max-width:100%}
.vh,main.hide-title>h1{position:absolute!important;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap;border:0}
.skip{position:absolute;left:16px;top:-56px;z-index:3;display:inline-flex;align-items:center;min-height:44px;padding:0 16px;border-radius:999px;background:${K.accent};color:${K.onAccent};font-weight:700;text-decoration:none}
.skip:focus{top:8px}
.muted{color:${K.mute}}
.soft{color:${K.soft}}
.small{${ty("meta")}}
.num{font-variant-numeric:tabular-nums}

/* Header: brand and log out on one row, the nav below it on phones; one row on wide screens.
   Its edges line up with main's column (main.wide's on Home). */
.top{position:relative;z-index:1;display:grid;grid-template-columns:1fr auto;grid-template-areas:"brand out" "nav nav";align-items:center;gap:0 16px;padding:8px 16px 0;border-bottom:1px solid ${LINE};background:rgba(15,16,32,.55)}
.top.bare{padding-bottom:8px;border-bottom-color:transparent;background:transparent}
.brand{grid-area:brand;display:inline-flex;align-items:center;gap:10px;min-height:44px;color:${K.text};font-family:${FONT.display};font-size:18px;font-weight:700;letter-spacing:-.01em;text-decoration:none}
.brand:hover .mark{transform:rotate(25deg)}
.mark{flex:none;width:22px;height:22px;border-radius:50%;background:radial-gradient(circle,${K.panelBottom} 0 1.5px,${K.accent} 2px 6px,${K.panelBottom} 6.5px 7.5px,#2a2d52 8px 8.5px,${K.panelBottom} 9px 9.5px,#2a2d52 10px 10.5px,${K.panelBottom} 11px);box-shadow:0 0 0 1px #3a3d6b,0 2px 6px rgba(0,0,0,.5);transition:transform .4s ease}
.out{grid-area:out}
.top nav{grid-area:nav;margin:0 -16px;overflow-x:auto;scrollbar-width:none}
.top ul{list-style:none;display:flex;gap:4px;margin:0;padding:0 8px}
.top nav a{position:relative;display:flex;align-items:center;min-height:44px;padding:0 12px;color:${K.soft};font-weight:600;text-decoration:none;white-space:nowrap}
.top nav a:hover{color:${K.text}}
.top nav a[aria-current=page]{color:${K.text}}
.top nav a[aria-current=page]::after{content:"";position:absolute;left:12px;right:12px;bottom:0;height:3px;border-radius:3px 3px 0 0;background:${K.accent};box-shadow:0 0 12px rgba(255,180,84,.5)}

main{max-width:760px;margin:0 auto;padding:24px 16px 48px}
main.narrow{display:flex;flex-direction:column;max-width:440px;padding-top:40px;text-align:center}
main.wide{max-width:1600px}

/* Cards (panels) */
.card{position:relative;background:${PANEL};border:1px solid ${LINE};border-radius:20px;padding:20px;margin:0 0 16px;box-shadow:${SHADOW.panel}}
.card-head{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px 12px;margin:0 0 16px}
.card>p:last-child,.card>dl:last-child{margin-bottom:0}
.card-foot{display:flex;flex-wrap:wrap;gap:4px 16px;margin-top:16px;padding-top:12px;border-top:1px solid ${LINE};${ty("meta")}}
.card-foot a{display:inline-flex;align-items:center;min-height:44px;font-weight:600}
.lead{${ty("body")};color:${K.soft}}
.actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:20px}
.note{${ty("meta")};color:${K.mute};margin:12px 0 0}

/* Label/value rows */
.facts{display:grid;grid-template-columns:minmax(0,auto) minmax(0,1fr);gap:10px 16px;margin:0}
.facts dt{${ty("meta")};color:${K.mute};padding-top:2px}
.facts dd{margin:0;overflow-wrap:anywhere;font-variant-numeric:tabular-nums}
.sub{display:block;${ty("meta")};color:${K.mute}}

/* Status pills and chips: text plus a dot; colour is never the only signal. */
.pill,.chip{display:inline-flex;align-items:center;gap:8px;border-radius:999px;font-weight:650;white-space:nowrap}
.pill{padding:2px 10px;${ty("meta")}}
.pill::before,.chip::before{content:"";flex:none;width:8px;height:8px;border-radius:50%;background:currentColor}
.pill-ok{background:${TINT.ok};color:${K.ok}}
.pill-warn{background:${TINT.warn};color:${K.accent}}
.pill-bad{background:${TINT.bad};color:${K.bad}}
.pill-neutral{background:${TINT.neutral};color:${K.soft}}
.pill-neutral::before{background:${K.mute}}
.chip{min-height:44px;padding:0 16px 0 14px;${ty("meta")};color:${K.text};text-decoration:none;background:${RAISED};border:1px solid ${LINE_STRONG};box-shadow:${SHADOW.raised}}
.chip:hover{border-color:rgba(255,255,255,.22)}
.chip-ok::before{background:${K.ok};box-shadow:0 0 0 3px ${TINT.ok},0 0 10px rgba(95,227,176,.6)}
.chip-warn::before{background:${K.accent};box-shadow:0 0 0 3px ${TINT.warn}}
.chip-bad::before{background:${K.bad};box-shadow:0 0 0 3px ${TINT.bad}}
.chip-neutral::before{background:${K.mute}}
.chip-bad{border-color:rgba(255,123,136,.4)}

/* Settings switch: the whole row is the button; the knob's side and the state word say on or off. */
.switch{display:flex;align-items:center;gap:12px;width:100%;min-height:44px;margin:0;padding:6px 0;border:0;background:none;color:${K.text};font:inherit;text-align:left;cursor:pointer}
.switch-label{flex:1 1 auto;min-width:0}
.switch-state{flex:none;${ty("micro")};font-weight:650;color:${K.mute};min-width:22px;text-align:right}
.switch::after{content:"";flex:none;width:44px;height:26px;border-radius:999px;background:radial-gradient(circle at 13px 50%,${K.soft} 0 8px,transparent 8.5px),${K.well};box-shadow:${SHADOW.well},0 0 0 1px ${LINE_STRONG}}
.switch[aria-checked=true]::after{background:radial-gradient(circle at 31px 50%,${K.onAccent} 0 8px,transparent 8.5px),linear-gradient(180deg,#ffc06c,${K.accent});box-shadow:inset 0 1px 0 rgba(255,255,255,.35),0 0 14px -4px rgba(255,180,84,.6)}
.switch[aria-checked=true] .switch-state{color:${K.accent}}
.switch:hover::after{box-shadow:${SHADOW.well},0 0 0 1px rgba(255,255,255,.28)}
.switch:disabled{cursor:not-allowed;opacity:.55}

/* Buttons: pills at least 44px tall (small ones get a 44px hit area). */
form.inline{display:inline}
.btn{position:relative;display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:44px;padding:0 20px;border-radius:999px;border:1px solid ${LINE_STRONG};background:${RAISED};color:${K.text};font:inherit;font-weight:650;line-height:20px;text-align:center;text-decoration:none;cursor:pointer;box-shadow:${SHADOW.raised}}
.btn:hover{border-color:rgba(255,255,255,.24);background:linear-gradient(180deg,#32365a,#292c52)}
.btn:active{transform:translateY(1px);box-shadow:inset 0 1px 2px rgba(0,0,0,.4)}
.btn-primary{border-color:transparent;background:linear-gradient(180deg,#ffc06c,${K.accent});color:${K.onAccent};box-shadow:inset 0 1px 0 rgba(255,255,255,.35),0 2px 6px rgba(0,0,0,.4),0 0 24px -8px rgba(255,180,84,.55)}
.btn-primary:hover{border-color:transparent;background:linear-gradient(180deg,#ffcb85,#ffbd66)}
.btn-danger{background:transparent;border-color:rgba(255,123,136,.6);color:${K.bad};box-shadow:none}
.btn-danger:hover{background:${TINT.bad};border-color:${K.bad}}
.btn-small{min-height:36px;padding:0 14px;${ty("meta")};font-weight:650}
.btn-small::after{content:"";position:absolute;inset:-4px 0}
.btn-block{width:100%}

/* Flash messages and banners: an icon and a coloured edge with the text. */
.notice{position:relative;border-radius:12px;padding:12px 16px 12px 48px;margin:0 0 16px;background:${K.raised};border:1px solid ${LINE};box-shadow:inset 3px 0 0 ${K.mute}}
.notice::before{content:"i";content:"i" / "";position:absolute;left:16px;top:14px;display:grid;place-items:center;width:20px;height:20px;border-radius:50%;background:${K.mute};color:${K.ink};font-size:13px;line-height:1;font-weight:800}
.notice-ok{background:linear-gradient(90deg,${TINT.ok},transparent 60%),${K.raised};box-shadow:inset 3px 0 0 ${K.ok}}
.notice-ok::before{content:"\\2713";content:"\\2713" / "";background:${K.ok}}
.notice-error{background:linear-gradient(90deg,${TINT.bad},transparent 60%),${K.raised};box-shadow:inset 3px 0 0 ${K.bad}}
.notice-error::before{content:"!";content:"!" / "";background:${K.bad}}
.notice-warn{background:linear-gradient(90deg,${TINT.warn},transparent 60%),${K.raised};box-shadow:inset 3px 0 0 ${K.accent}}
.notice-warn::before{content:"!";content:"!" / "";background:${K.accent}}
.notice ul{margin:8px 0 0;padding-left:20px}
.notice a{color:${K.text}}

/* Lists of rows (activity, playlists, problems) */
.rows{list-style:none;margin:0;padding:0}
.rows>li{display:flex;align-items:baseline;justify-content:space-between;gap:4px 12px;padding:12px 0;border-top:1px solid ${LINE}}
.rows>li:first-child{border-top:0;padding-top:0}
.rows>li:last-child{padding-bottom:0}
.rows .main{flex:1 1 0;min-width:0;overflow-wrap:anywhere}
.rows .meta,.meta{${ty("meta")};color:${K.mute}}
.rows .side{flex:none;display:flex;align-items:center;gap:8px}
.rows .row-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}
.rows h3 a{color:${K.text};text-decoration:none}
.rows h3 a:hover{text-decoration:underline}
.rows h3 a::after{content:" \\2197";content:" \\2197" / "";color:${K.mute};font-weight:400}
.error-text{display:block;margin-top:8px;padding:8px 12px;border-radius:8px;background:${K.well};box-shadow:${SHADOW.well};color:${K.soft};font-family:${FONT.mono};font-size:13px;line-height:18px;white-space:pre-wrap;overflow-wrap:anywhere}
details{margin-top:16px;border-top:1px solid ${LINE};padding-top:4px}
summary{display:flex;align-items:center;gap:8px;min-height:44px;cursor:pointer;font-weight:650;list-style:none;border-radius:8px}
summary::-webkit-details-marker{display:none}
summary::before{content:"";flex:none;width:8px;height:8px;margin:0 4px;border-right:2px solid ${K.soft};border-bottom:2px solid ${K.soft};transform:rotate(-45deg);transition:transform .15s ease}
details[open]>summary::before{transform:rotate(45deg)}
summary:hover{color:${K.text}}
.tags{display:flex;flex-wrap:wrap;gap:8px;list-style:none;margin:12px 0 0;padding:0}
.tags a{display:inline-flex;align-items:center;min-height:36px;padding:0 14px;border-radius:999px;background:${RAISED};border:1px solid ${LINE};color:${K.text};${ty("meta")};text-decoration:none}
.tags a:hover{border-color:rgba(255,255,255,.24)}

/* Tables: tabular figures, numbers right-aligned (th.num / td.num); wrap wide ones in .table-wrap. */
.table-wrap{max-width:100%;overflow-x:auto;border-radius:12px;background:${K.well};box-shadow:${SHADOW.well}}
table{width:100%;border-collapse:collapse;${ty("meta")};font-variant-numeric:tabular-nums}
caption{padding:0 0 8px;text-align:left;color:${K.soft};font-weight:650}
th,td{padding:8px 12px;text-align:left;vertical-align:top;border-bottom:1px solid ${LINE}}
thead th{color:${K.mute};font-weight:650;white-space:nowrap}
tbody th{font-weight:600;color:${K.soft}}
tr:last-child>td,tr:last-child>th{border-bottom:0}
th.num,td.num{text-align:right}

/* Forms. Settings rows: checkbox | label, description, source, error; the confirmation spans the
   row. A field row (number, select): label, description, input, source, error. */
fieldset{border:1px solid ${LINE};margin:0 0 16px;padding:20px;background:${PANEL};border-radius:20px;box-shadow:${SHADOW.panel};min-width:0}
legend{float:left;width:100%;padding:0;margin:0 0 4px;font-family:${FONT.display};${ty("title")};font-weight:650}
legend+*{clear:both}
label{cursor:pointer}
.help{${ty("meta")};color:${K.soft};margin:4px 0 0}
.setting{display:grid;grid-template-columns:24px minmax(0,1fr);gap:4px 12px;padding:16px 0;border-top:1px solid ${LINE}}
legend+.setting{border-top:0}
.setting>*{grid-column:2}
.setting>.control{grid-column:1;grid-row:1/span 2;padding-top:1px}
.setting.field{grid-template-columns:minmax(0,1fr)}
.setting.field>*{grid-column:1}
input[type=checkbox],input[type=radio]{width:20px;height:20px;margin:0;accent-color:${K.accent};cursor:pointer}
.setting input[type=checkbox]{width:22px;height:22px}
.setting>label{font-weight:650}
.setting .desc{${ty("meta")};color:${K.soft};margin:0}
.setting .meta-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:4px}
.source{${ty("micro")};color:${K.mute};font-weight:650}
.source-dashboard{color:${K.accent}}
input[type=text],input[type=number],input[type=email],input[type=url],input[type=search],select,textarea{width:100%;max-width:320px;min-height:44px;margin-top:8px;padding:0 12px;border-radius:12px;border:1px solid ${LINE_STRONG};background:${K.well};box-shadow:${SHADOW.well};color:${K.text};font:inherit}
textarea{padding:10px 12px;max-width:100%}
input[type=number]{max-width:140px;font-variant-numeric:tabular-nums}
input:hover,select:hover,textarea:hover{border-color:rgba(255,255,255,.24)}
input:focus-visible,select:focus-visible,textarea:focus-visible{${RING};outline-offset:1px}
select{appearance:none;padding-right:36px;background:linear-gradient(45deg,transparent 50%,${K.soft} 50%) no-repeat calc(100% - 18px) 50% / 6px 6px,linear-gradient(-45deg,transparent 50%,${K.soft} 50%) no-repeat calc(100% - 12px) 50% / 6px 6px,${K.well}}
[aria-invalid=true]{border-color:${K.bad}!important;outline:1px solid ${K.bad}}
.field-error{${ty("meta")};color:${K.bad};font-weight:650;margin:4px 0 0}
.setting>.confirm{grid-column:1/-1;margin-top:12px;padding:16px;border-radius:12px;background:${TINT.warn};border:1px solid rgba(255,180,84,.55)}
.confirm p{${ty("meta")};color:${K.text};margin:0 0 8px}
.confirm strong{color:${K.accent}}
.confirm label{display:flex;align-items:center;gap:12px;min-height:44px;font-weight:650;cursor:pointer}
.confirm.invalid{border-color:${K.bad};background:${TINT.bad}}
.confirm.invalid strong{color:${K.bad}}
@supports selector(:has(*)){.gated>.confirm{display:none}.gated:has(.toggle:checked)>.confirm,.gated>.confirm.invalid{display:block}}
/* Import upload: a file picker whose button matches .btn, and a slim apricot progress bar. */
input[type=file]{display:block;width:100%;max-width:100%;padding:8px 0;color:${K.soft};font:inherit;${ty("meta")};cursor:pointer}
input[type=file]::file-selector-button{min-height:44px;margin-right:12px;padding:0 20px;border-radius:999px;border:1px solid ${LINE_STRONG};background:${RAISED};color:${K.text};font:inherit;font-weight:650;cursor:pointer}
input[type=file]:hover::file-selector-button{border-color:rgba(255,255,255,.24)}
progress{display:block;width:100%;height:8px;margin-top:16px;border:0;border-radius:999px;background:${K.well};color:${K.accent};overflow:hidden;-webkit-appearance:none;appearance:none}
progress::-webkit-progress-bar{background:${K.well};border-radius:999px}
progress::-webkit-progress-value{background:${K.accent};border-radius:999px}
progress::-moz-progress-bar{background:${K.accent};border-radius:999px}
[hidden]{display:none!important}
.savebar{position:sticky;bottom:0;z-index:1;display:flex;flex-wrap:wrap;align-items:center;gap:12px;margin:0 -16px 32px;padding:12px 16px;background:rgba(15,16,32,.92);border-top:1px solid ${LINE};backdrop-filter:blur(8px)}

/* Landing page: main.narrow is a flex column, so the disc (decorative) shows above the h1. */
.disc{order:-1;position:relative;width:200px;height:200px;margin:0 auto 24px}
.disc img{position:relative;display:block;width:200px;height:200px}
.disc-label{position:absolute;left:62.5px;top:55px;width:75px;height:75px;border-radius:50%;background:radial-gradient(circle,${K.panelBottom} 0 4px,transparent 4.5px),linear-gradient(150deg,#ffc977 0%,${K.accent} 55%,#e8953a 100%)}
main.narrow h1{font-size:36px;line-height:40px;margin:0 0 12px}
main.narrow .lead{text-wrap:balance;margin:0 0 32px}
main.narrow .note{margin-top:16px}
main.narrow>.btn{align-self:center}

@media (min-width:640px){
.top{grid-template-columns:auto 1fr auto;grid-template-areas:"brand nav out";padding:0 max(24px,calc((100% - 712px) / 2));min-height:64px}
.top.wide{padding:0 max(32px,calc((100% - 1536px) / 2))}
.top.bare{padding-bottom:0}
.top nav{margin:0 0 0 16px;overflow:visible}
.top ul{padding:0}
.top nav a{min-height:64px}
h1{font-size:36px;line-height:40px}
main{padding:40px 24px 64px}
main.wide{padding:24px 32px 64px}
.card,fieldset{padding:24px}
.setting{grid-template-columns:24px minmax(0,1fr) auto}
.setting>.meta-row{grid-column:3;grid-row:1;margin-top:0;justify-content:flex-end}
.setting>.confirm{grid-column:2/-1}
.setting.field{grid-template-columns:minmax(0,1fr) auto}
.setting.field>.meta-row{grid-column:2}
.btn-block{width:auto}
.savebar{margin-left:0;margin-right:0;padding-left:0;padding-right:0;background:transparent;backdrop-filter:none}
main.narrow{padding-top:80px}
main.narrow h1{font-size:44px;line-height:48px}
.disc,.disc img{width:216px;height:216px}
.disc-label{left:67.5px;top:59.5px;width:81px;height:81px}
}
@media (min-width:1024px){
.top.wide{padding:0 max(48px,calc((100% - 1504px) / 2))}
main.wide{padding:32px 48px 80px}
}
@media (hover:none){.btn:hover{border-color:${LINE_STRONG}}}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{transition:none!important;animation:none!important;scroll-behavior:auto!important}}
@media (forced-colors:active){.switch::after{forced-color-adjust:none;border:1px solid CanvasText}.pill::before,.chip::before{forced-color-adjust:none}}`;
