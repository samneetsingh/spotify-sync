// The dashboard's base stylesheet: the glass look (src/dashboard/tokens.ts) for every shared class.
// styles/index.ts appends the per-page parts after it, so they can override. renderPage inlines it in
// one <style nonce> element; the CSP blocks `style=` attributes, so markup uses these classes only.
// Mobile-first: base rules are the phone layout, min-width blocks upgrade. No web fonts: the system
// sans throughout.
//
// Class guide (shared by every page):
// - Page: `main` is the dashboard column (760px); `main.narrow` a centred glass card (landing, auth
//   problems); `main.wide` the Home and Settings grids (up to 1600px); `main.hide-title` keeps the
//   <h1> for screen readers only. With a session the header is a floating glass bar, and from 1200px
//   a fixed glass sidebar (`body.with-nav` makes room for it).
// - `.vh`: visually hidden, still read by screen readers. `.skip`: the skip link.
// - Text: `.lead` an intro sentence; `.note` a small muted note; `.muted`, `.soft` text colours;
//   `.small` meta size; `.sub` a muted second line under a value (block); `.num` tabular figures;
//   `.h-section` a section heading outside a card.
// - `.card`: a glass panel (lifted fill, hairline edge, soft shadow) with `.card-head` (the h2 plus
//   e.g. a badge) and `.actions` (buttons).
// - `.facts`: label/value rows (<dl>).
// - `.pill pill-{ok,warn,bad,neutral}`: a status badge (text plus a dot; not a link).
// - `.chip chip-{tone}`: a status link (Chip primitive), e.g. Home's sync status to /settings.
// - `.btn btn-{primary,secondary,danger}`, `.btn-small` (32px, with a 40px hit area), `.btn-block`.
// - `.notice notice-{ok,warn,error}`: a flash message or banner, with an icon square.
// - `.rows`: a list of rows with `.main`, `.meta`, `.side` and `.row-actions`; `.error-text` an error.
// - `details`/`summary`: a disclosure; `.tags`: wrapped link tags.
// - Tables: `table` (tabular figures), `th`/`td.num` right-aligned numbers, `.table-wrap` scrolls.
// - Forms: `fieldset` (a glass panel) and `legend`; `.settings-list` wraps `.setting` rows
//   (`.control`, `.desc`, `.setting-status`, `.meta-row`, `.source`, `.confirm`, `.gated`, `.field`,
//   `.field-error`); `.help` help text; inputs, select, checkbox, radio, file, progress; `.savebar` a
//   sticky glass save bar.
// - `.icon`: an inline line icon (components/icons.tsx).

import { iconUrl, type IconName } from "../components/icons";
import { COLOR as K, FONT, GLASS, LINE, LINE_STRONG, PAGE_BACKGROUND, PAGE_TOP, TINT, ty } from "../tokens";

const RING = `outline:2px solid ${K.cyan};outline-offset:2px`;
/** A tint laid flat over the navy fill (badges and notices read the same over any glass). */
const over = (tint: string) => `linear-gradient(${tint},${tint}),${K.navy}`;

/** Nav icon squares: a blue icon on a dark square, a white one on blue for the current page. */
const NAV_ICONS: Array<[href: string, icon: IconName]> = [
  ["/", "home"],
  ["/settings", "settings"],
  ["/activity", "activity"],
];
const navIcons = NAV_ICONS.map(
  ([href, icon]) =>
    `.top nav a[href="${href}"]::before{background:${iconUrl(icon, K.blue)} center / 60% no-repeat,${K.raised}}` +
    `.top nav a[href="${href}"][aria-current=page]::before{background:${iconUrl(icon, K.text)} center / 60% no-repeat,${K.blue}}`,
).join("\n");

export const BASE_CSS = `*,*::before,*::after{box-sizing:border-box}
/* The page background is on html (the canvas), so it reaches every edge: body's box starts below the
   header's top margin (it collapses through body), and on body that left a dark strip at the top. */
html{-webkit-text-size-adjust:100%;min-height:100%;background:${PAGE_BACKGROUND};background-color:${PAGE_TOP};background-attachment:fixed;color-scheme:dark}
body{margin:0;min-height:100vh;color:${K.text};font-family:${FONT.sans};${ty("body")};-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}
a{color:${K.link};text-decoration-thickness:1px;text-underline-offset:3px}
a:hover{color:${K.text}}
:focus-visible{${RING}}
::selection{background:rgba(0,117,255,.45);color:${K.text}}
p{margin:0 0 12px}
h1,h2,.h-section{font-weight:700;letter-spacing:-.01em;text-wrap:balance}
h1{font-size:24px;line-height:32px;margin:0 0 20px}
h2{${ty("title")};margin:0}
.h-section{${ty("section")};margin:0 0 16px}
h3{${ty("body")};font-weight:650;margin:0 0 4px}
code{font-family:${FONT.mono};font-size:13px;padding:1px 6px;border-radius:6px;background:${K.well};color:${K.soft}}
strong,b{font-weight:650}
img{max-width:100%}
.icon{display:block;flex:none}
.vh,main.hide-title>h1{position:absolute!important;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap;border:0}
.skip{position:absolute;left:16px;top:-56px;z-index:5;display:inline-flex;align-items:center;min-height:40px;padding:0 16px;border-radius:12px;background:${K.blueFill};color:${K.text};font-weight:700;text-decoration:none}
.skip:focus{top:8px}
.muted{color:${K.mute}}
.soft{color:${K.soft}}
.small{${ty("meta")}}
.num{font-variant-numeric:tabular-nums}

/* Header: a floating glass bar lined up with main's column (the brand, the nav below it on phones;
   one row from 640px). From 1200px, with a session, a fixed glass sidebar. Log out is in Settings. */
.top{position:relative;z-index:3;display:grid;grid-template-columns:minmax(0,1fr);grid-template-areas:"brand" "nav";align-items:center;gap:4px 12px;margin:12px 16px 0;padding:8px 12px;border-radius:20px;background:${GLASS.card};${GLASS.blur};${GLASS.edge}}
.top.bare{background:none;-webkit-backdrop-filter:none;backdrop-filter:none;border:0;box-shadow:none;padding:8px 0}
.brand{grid-area:brand;display:inline-flex;align-items:center;gap:10px;min-height:40px;color:${K.text};font-size:13px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;text-decoration:none}
.brand:hover{color:${K.text}}
.mark{flex:none;width:30px;height:30px;border-radius:10px;background:${iconUrl("music", K.text)} center / 55% no-repeat,linear-gradient(135deg,${K.blue},${K.cyan})}
.top nav{grid-area:nav;overflow-x:auto;scrollbar-width:none}
.top ul{list-style:none;display:flex;gap:4px;margin:0;padding:0}
.top nav a{display:flex;align-items:center;gap:10px;min-height:40px;padding:0 12px 0 8px;border-radius:12px;color:${K.soft};${ty("meta")};font-weight:650;text-decoration:none;white-space:nowrap}
.top nav a::before{content:"";flex:none;width:26px;height:26px;border-radius:9px}
.top nav a:hover{color:${K.text}}
.top nav a[aria-current=page]{color:${K.text};background:${K.raised}}
${navIcons}

main{max-width:760px;margin:0 auto;padding:20px 16px 48px}
main.narrow{display:flex;flex-direction:column;max-width:440px;margin:24px auto 48px;padding:32px 24px;border-radius:20px;background:${GLASS.card};${GLASS.blur};${GLASS.edge};text-align:center}
main.wide{max-width:1600px}

/* Cards: glass panels */
.card{position:relative;background:${GLASS.card};${GLASS.blur};${GLASS.edge};border-radius:20px;padding:20px;margin:0 0 16px}
.card-head{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px 12px;margin:0 0 16px}
.card>p:last-child,.card>dl:last-child{margin-bottom:0}
.lead{${ty("body")};color:${K.soft}}
.actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:20px}
.note{${ty("meta")};color:${K.mute};margin:12px 0 0}

/* Label/value rows */
.facts{display:grid;grid-template-columns:minmax(0,auto) minmax(0,1fr);gap:10px 20px;margin:0}
.facts dt{${ty("meta")};color:${K.soft};font-weight:650;padding-top:1px}
.facts dd{margin:0;overflow-wrap:anywhere;font-variant-numeric:tabular-nums}
.sub{display:block;${ty("meta")};color:${K.mute}}

/* Status badges and chips: text plus a dot; colour is never the only signal. */
.pill,.chip{display:inline-flex;align-items:center;gap:7px;font-weight:700;white-space:nowrap}
.pill{padding:3px 10px;border-radius:8px;${ty("micro")}}
.pill::before,.chip::before{content:"";flex:none;width:7px;height:7px;border-radius:50%;background:currentColor}
.pill-ok{background:${TINT.ok};color:${K.ok}}
.pill-warn{background:${TINT.warn};color:${K.warn}}
.pill-bad{background:${TINT.bad};color:${K.bad}}
.pill-neutral{background:${TINT.neutral};color:${K.soft}}
.chip{min-height:40px;padding:0 16px 0 14px;border-radius:12px;${ty("meta")};color:${K.text};text-decoration:none;background:rgba(15,21,53,.85);border:1px solid ${LINE};${GLASS.blur}}
.chip:hover{color:${K.text};border-color:rgba(255,255,255,.2)}
.chip-ok::before{background:${K.ok};box-shadow:0 0 0 3px ${TINT.ok},0 0 10px rgba(1,181,116,.6)}
.chip-warn::before{background:${K.warn};box-shadow:0 0 0 3px ${TINT.warn}}
.chip-bad::before{background:${K.bad};box-shadow:0 0 0 3px ${TINT.bad}}
.chip-neutral::before{background:${K.mute}}
.chip-bad{border-color:rgba(238,93,80,.45)}

/* Buttons: 40px (small 32px with a 40px hit area), 12px corners; primary is blue. */
form.inline{display:inline}
.btn{position:relative;display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:40px;padding:0 18px;border-radius:12px;border:1px solid rgba(255,255,255,.2);background:transparent;color:${K.text};font:inherit;${ty("meta")};font-weight:700;text-align:center;text-decoration:none;cursor:pointer;transition:background-color .15s ease,border-color .15s ease}
.btn:hover{color:${K.text};background:rgba(255,255,255,.06);border-color:rgba(255,255,255,.32)}
.btn:active{transform:translateY(1px)}
.btn-primary{border-color:transparent;background:${K.blueFill};box-shadow:0 8px 20px -10px rgba(0,117,255,.8)}
.btn-primary:hover{border-color:transparent;background:#005ed2}
.btn-danger{border-color:rgba(227,26,26,.6);color:${K.bad}}
.btn-danger:hover{background:${K.danger};border-color:${K.danger};color:${K.text}}
.btn-small{min-height:32px;padding:0 12px;border-radius:10px;${ty("micro")};font-weight:700}
.btn-small::after{content:"";position:absolute;inset:-4px 0}
.btn-block{width:100%}

/* Flash messages and banners: an icon square and a tinted fill. */
.notice{position:relative;border-radius:15px;padding:12px 16px 12px 50px;margin:0 0 16px;background:${K.navy};border:1px solid ${LINE}}
.notice::before{content:"i";content:"i" / "";position:absolute;left:14px;top:12px;display:grid;place-items:center;width:24px;height:24px;border-radius:8px;background:${K.mute};color:${K.text};font-size:13px;line-height:1;font-weight:800}
.notice-ok{background:${over(TINT.ok)};border-color:rgba(1,181,116,.35)}
.notice-ok::before{content:"\\2713";content:"\\2713" / "";background:${K.ok}}
.notice-error{background:${over(TINT.bad)};border-color:rgba(238,93,80,.4)}
.notice-error::before{content:"!";content:"!" / "";background:${K.danger}}
.notice-warn{background:${over(TINT.warn)};border-color:rgba(255,181,71,.4)}
.notice-warn::before{content:"!";content:"!" / "";background:${K.warn};color:#1a1204}
.notice ul{margin:8px 0 0;padding-left:20px}
.notice a{color:${K.text}}

/* Lists of rows (activity, problems) */
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
.error-text{display:block;margin-top:8px;padding:10px 12px;border-radius:12px;background:${K.well};border:1px solid ${LINE};color:${K.soft};font-family:${FONT.mono};font-size:13px;line-height:18px;white-space:pre-wrap;overflow-wrap:anywhere}
details{margin-top:16px;border-top:1px solid ${LINE};padding-top:4px}
summary{display:flex;align-items:center;gap:8px;min-height:40px;cursor:pointer;font-weight:650;list-style:none;border-radius:10px}
summary::-webkit-details-marker{display:none}
summary::before{content:"";flex:none;width:7px;height:7px;margin:0 4px;border-right:2px solid ${K.soft};border-bottom:2px solid ${K.soft};transform:rotate(-45deg);transition:transform .15s ease}
details[open]>summary::before{transform:rotate(45deg)}
summary:hover{color:${K.text}}
.tags{display:flex;flex-wrap:wrap;gap:8px;list-style:none;margin:12px 0 0;padding:0}
.tags a{display:inline-flex;align-items:center;min-height:34px;padding:0 12px;border-radius:10px;background:${K.raised};border:1px solid ${LINE};color:${K.text};${ty("meta")};text-decoration:none}
.tags a:hover{border-color:rgba(0,117,255,.6)}

/* Tables: tabular figures, numbers right-aligned (th.num / td.num); wrap wide ones in .table-wrap. */
.table-wrap{max-width:100%;overflow-x:auto;border-radius:15px;background:${K.well};border:1px solid ${LINE}}
table{width:100%;border-collapse:collapse;${ty("meta")};font-variant-numeric:tabular-nums}
caption{padding:0 0 8px;text-align:left;color:${K.soft};font-weight:650}
th,td{padding:10px 14px;text-align:left;vertical-align:top;border-bottom:1px solid ${LINE}}
thead th{color:${K.soft};${ty("micro")};font-weight:700;text-transform:uppercase;letter-spacing:.06em;white-space:nowrap}
tbody th{font-weight:650;color:${K.text}}
tr:last-child>td,tr:last-child>th{border-bottom:0}
th.num,td.num{text-align:right}

/* Forms. Fieldsets are glass panels. Settings rows: checkbox | label, description, status line,
   source, error; the confirmation spans the row. A field row (number, select): label, description,
   input, source, error. From 640px the source and Reset sit right of the label, and everything
   under the label takes the full width. */
fieldset{margin:0 0 16px;padding:20px;border-radius:20px;background:${GLASS.card};${GLASS.blur};${GLASS.edge};min-width:0}
legend{float:left;width:100%;padding:0;margin:0 0 8px;${ty("title")};font-weight:700}
legend+*{clear:both}
label{cursor:pointer}
.help{${ty("meta")};color:${K.soft};margin:4px 0 0}
.setting{display:grid;grid-template-columns:24px minmax(0,1fr);gap:4px 12px;padding:16px 0;border-top:1px solid ${LINE}}
legend+.setting,.settings-list>.setting:first-child{border-top:0}
.setting>*{grid-column:2}
.setting>.control{grid-column:1;grid-row:1/span 2;padding-top:1px}
.setting.field{grid-template-columns:minmax(0,1fr)}
.setting.field>*{grid-column:1}
input[type=checkbox],input[type=radio]{width:20px;height:20px;margin:0;accent-color:${K.blue};cursor:pointer}
.setting input[type=checkbox]{width:20px;height:20px}
.setting>label{font-weight:650}
.setting .desc{${ty("meta")};color:${K.soft};margin:0}
.setting-status{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;margin-top:6px;${ty("meta")};color:${K.soft}}
.setting-status a{color:${K.link};font-weight:650}
.setting-status a:hover{color:${K.text}}
.setting-status details{flex-basis:100%;margin:0;border-top:0;padding-top:0}
.setting-status summary{min-height:32px;color:${K.soft}}
.setting-status .tags{margin-top:6px}
.setting .meta-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:4px}
.source{${ty("micro")};color:${K.mute};font-weight:700}
fieldset>.note{margin-top:4px;padding-top:12px;border-top:1px solid ${LINE}}
input[type=text],input[type=number],input[type=email],input[type=url],input[type=search],select,textarea{width:100%;max-width:320px;min-height:42px;margin-top:8px;padding:0 14px;border-radius:15px;border:1px solid ${LINE_STRONG};background:${K.navy};color:${K.text};font:inherit;${ty("meta")}}
textarea{padding:10px 14px;max-width:100%}
input[type=number]{max-width:140px;font-variant-numeric:tabular-nums}
input:hover,select:hover,textarea:hover{border-color:rgba(226,232,240,.5)}
input:focus-visible,select:focus-visible,textarea:focus-visible{${RING};outline-offset:1px;border-color:${K.blue}}
select{appearance:none;padding-right:40px;background:${iconUrl("chevron", K.soft)} no-repeat right 14px center / 16px,${K.navy}}
[aria-invalid=true]{border-color:${K.bad}!important;outline:1px solid ${K.bad}}
.field-error{${ty("meta")};color:${K.bad};font-weight:650;margin:4px 0 0}
.setting>.confirm{grid-column:1/-1;margin-top:12px;padding:16px;border-radius:15px;background:${over(TINT.warn)};border:1px solid rgba(255,181,71,.45)}
.confirm p{${ty("meta")};color:${K.text};margin:0 0 8px}
.confirm strong{color:${K.warn}}
.confirm label{display:flex;align-items:center;gap:12px;min-height:40px;font-weight:650;cursor:pointer}
.confirm.invalid{border-color:${K.bad};background:${over(TINT.bad)}}
.confirm.invalid strong{color:${K.bad}}
@supports selector(:has(*)){.gated>.confirm{display:none}.gated:has(.toggle:checked)>.confirm,.gated>.confirm.invalid{display:block}}
/* Import upload: a file picker whose button matches .btn, and a slim blue progress bar. */
input[type=file]{display:block;width:100%;max-width:100%;padding:8px 0;color:${K.soft};font:inherit;${ty("meta")};cursor:pointer}
input[type=file]::file-selector-button{min-height:40px;margin-right:12px;padding:0 18px;border-radius:12px;border:1px solid rgba(255,255,255,.2);background:transparent;color:${K.text};font:inherit;font-weight:700;cursor:pointer}
input[type=file]:hover::file-selector-button{background:rgba(255,255,255,.06)}
progress{display:block;width:100%;height:6px;margin-top:16px;border:0;border-radius:999px;background:rgba(255,255,255,.08);color:${K.blue};overflow:hidden;-webkit-appearance:none;appearance:none}
progress::-webkit-progress-bar{background:rgba(255,255,255,.08);border-radius:999px}
progress::-webkit-progress-value{background:linear-gradient(90deg,${K.blue},${K.cyan});border-radius:999px}
progress::-moz-progress-bar{background:linear-gradient(90deg,${K.blue},${K.cyan});border-radius:999px}
[hidden]{display:none!important}
.savebar{position:sticky;bottom:12px;z-index:2;display:flex;flex-wrap:wrap;align-items:center;gap:12px;margin:16px 0 24px;padding:12px 16px;border-radius:20px;background:rgba(28,35,72,.92);${GLASS.blur};${GLASS.edge}}

/* Landing and auth problem pages: main.narrow is the glass card; the mark sits above the h1. */
main.narrow h1{font-size:28px;line-height:34px;margin:0 0 12px}
main.narrow .lead{text-wrap:balance;margin:0 0 28px}
main.narrow .note{margin-top:16px}
main.narrow>.btn{align-self:center}
.landing-mark{order:-1;align-self:center;width:56px;height:56px;margin:0 0 20px;border-radius:16px;background:${iconUrl("music", K.text)} center / 50% no-repeat,linear-gradient(135deg,${K.blue},${K.cyan});box-shadow:0 12px 30px -12px rgba(0,117,255,.9)}

@media (min-width:640px){
.top{grid-template-columns:auto minmax(0,1fr);grid-template-areas:"brand nav";gap:0 16px;width:calc(100% - 48px);max-width:712px;margin:16px auto 0;padding:8px 12px 8px 16px}
.top.wide{width:calc(100% - 64px);max-width:1536px}
.top.bare{padding:8px 0}
.top nav{margin-left:8px;overflow:visible}
h1{font-size:28px;line-height:34px}
main{padding:32px 24px 64px}
main.wide{padding:24px 32px 64px}
main.narrow{margin-top:56px;padding:40px 36px}
.card,fieldset{padding:24px}
.setting{grid-template-columns:24px minmax(0,1fr) auto}
.setting>*{grid-column:2/-1}
.setting>label{grid-column:2}
.setting>.meta-row{grid-column:3;grid-row:1;margin-top:0;justify-content:flex-end}
.setting.field{grid-template-columns:minmax(0,1fr) auto}
.setting.field>*{grid-column:1/-1}
.setting.field>label{grid-column:1}
.setting.field>.meta-row{grid-column:2}
.btn-block{width:auto}
main.narrow h1{font-size:32px;line-height:38px}
}
@media (min-width:1024px){
.top.wide{width:calc(100% - 96px);max-width:1504px}
main.wide{padding:32px 48px 80px}
}
@media (min-width:1200px){
body.with-nav{padding-left:266px}
.top:not(.bare){position:fixed;top:16px;bottom:16px;left:16px;display:flex;flex-direction:column;align-items:stretch;gap:0;width:250px;max-width:none;margin:0;padding:24px 16px 20px}
.top:not(.bare) .brand{justify-content:center;padding-bottom:24px;margin-bottom:20px;background:${GLASS.divider} bottom / 100% 1px no-repeat}
.top:not(.bare) nav{margin:0}
.top:not(.bare) ul{flex-direction:column;gap:4px}
.top:not(.bare) nav a{min-height:54px;padding:0 16px 0 12px;border-radius:15px;gap:14px}
.top:not(.bare) nav a::before{width:32px;height:32px;border-radius:12px}
.top:not(.bare) nav a[aria-current=page]{background:${K.raised};box-shadow:inset 0 1px 0 rgba(255,255,255,.06),0 8px 20px -12px rgba(0,0,0,.7)}
.top.wide:not(.bare){width:250px}
}
@media (pointer:coarse){.btn{min-height:44px}.btn-small{min-height:36px}}
@media (hover:none){.btn:hover{background:transparent;border-color:rgba(255,255,255,.2)}.btn-primary:hover{background:${K.blueFill};border-color:transparent}}
/* Page transitions (cross-document view transitions; browsers without them just navigate): the new
   page fades in over the old one (no dip to black between them). Nothing is morphed (pages differ
   in height, and morphing stretched them); on wide screens the sidebar, the same on every page, sits
   outside the fade and stays put. */
@view-transition{navigation:auto}
::view-transition-old(root),::view-transition-new(root){mix-blend-mode:normal}
::view-transition-old(root){animation:none}
::view-transition-new(root){animation:page-in .45s ease-out both}
::view-transition-group(chrome){animation:none}
@keyframes page-in{from{opacity:0}}
@media (min-width:1200px){body.with-nav .top{view-transition-name:chrome}}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{transition:none!important;animation:none!important;scroll-behavior:auto!important}::view-transition-group(*),::view-transition-old(*),::view-transition-new(*){animation:none!important}}
@media (forced-colors:active){.pill::before,.chip::before,.top nav a::before{forced-color-adjust:none}}`;
