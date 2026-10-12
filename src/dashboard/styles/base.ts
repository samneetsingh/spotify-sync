// The dashboard's base stylesheet (styles/index.ts appends the other parts), built from the email
// design tokens (src/email/layout.ts) so pages and emails share colours, type and spacing. renderPage
// inlines it in a <style nonce> element: the CSP blocks `style=` attributes, so markup uses these
// classes only.
//
// Mobile-first: the base rules are the phone layout; one min-width:640px block upgrades wide screens.
// Spacing scale 4/8/12/16/20/24/32/40, the email type scale (TY), 44px touch targets, a 2px green
// focus ring, and no motion when the visitor prefers reduced motion.

import { C, FONT, MONO, TY } from "../../email/layout";

/** Translucent tints of the accent colours (pill and notice backgrounds). */
const tint = {
  green: "rgba(30,215,96,.14)",
  amber: "rgba(245,165,36,.14)",
  red: "rgba(255,92,108,.14)",
};

export const BASE_CSS = `*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:${C.page};color:${C.text};font-family:${FONT};${TY.body};-webkit-font-smoothing:antialiased}
a{color:${C.green};text-underline-offset:3px}
a:hover{text-decoration-thickness:2px}
:focus-visible{outline:2px solid ${C.green};outline-offset:2px}
p{margin:0 0 12px}
h1{${TY.number};margin:0 0 24px}
h2{${TY.heading};margin:0}
h3{${TY.body};font-weight:700;margin:0 0 4px}
code{font-family:${MONO};font-size:14px}
.skip{position:absolute;left:16px;top:-48px;z-index:2;padding:8px 16px;border-radius:8px;background:${C.green};color:#000;font-weight:700;text-decoration:none}
.skip:focus{top:8px}
.muted{color:${C.mute}}
.soft{color:${C.soft}}
.small{${TY.meta}}

/* Header: brand and log out on one row, the nav below it on phones; one row on wide screens. */
.top{display:grid;grid-template-columns:1fr auto;grid-template-areas:"brand out" "nav nav";align-items:center;gap:0 16px;padding:12px 16px 0;border-bottom:1px solid ${C.line}}
.top.bare{padding-bottom:12px}
.brand{grid-area:brand;display:inline-flex;align-items:center;gap:8px;min-height:44px;color:${C.text};font-weight:800;text-decoration:none;letter-spacing:-0.2px}
.mark{width:20px;height:20px;border-radius:50%;background:radial-gradient(circle,${C.green} 0 3px,#111 3.5px 6px,#2a2a2a 6.5px 7px,#111 7.5px 100%);box-shadow:0 0 0 1px ${C.line}}
.out{grid-area:out}
.top nav{grid-area:nav;margin:4px -16px 0;overflow-x:auto}
.top ul{list-style:none;display:flex;gap:4px;margin:0;padding:0 8px}
.top nav a{display:flex;align-items:center;min-height:44px;padding:0 12px;border-bottom:2px solid transparent;color:${C.soft};font-weight:600;text-decoration:none;white-space:nowrap}
.top nav a:hover{color:${C.text}}
.top nav a[aria-current=page]{color:${C.text};border-bottom-color:${C.green}}

main{max-width:760px;margin:0 auto;padding:24px 16px 48px}
main.narrow{display:flex;flex-direction:column;max-width:440px;padding-top:40px;text-align:center}

/* Cards */
.card{background:${C.card};border-radius:16px;padding:20px;margin:0 0 16px}
.card-head{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px 12px;margin:0 0 16px}
.card>p:last-child,.card>dl:last-child{margin-bottom:0}
.lead{${TY.body};color:${C.soft}}
.actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:20px}
.note{${TY.meta};color:${C.mute};margin:12px 0 0}

/* Label/value rows */
.facts{display:grid;grid-template-columns:minmax(0,auto) minmax(0,1fr);gap:8px 16px;margin:0}
.facts dt{${TY.meta};color:${C.mute};padding-top:1px}
.facts dd{margin:0;overflow-wrap:anywhere}
.sub{display:block;${TY.meta};color:${C.mute}}

/* Status pills: text plus a dot; colour is never the only signal. */
.pill{display:inline-flex;align-items:center;gap:6px;border-radius:999px;padding:2px 10px;${TY.meta};font-weight:700;white-space:nowrap}
.pill::before{content:"";width:8px;height:8px;border-radius:50%;background:currentColor}
.pill-ok{background:${tint.green};color:${C.green}}
.pill-warn{background:${tint.amber};color:${C.amber}}
.pill-bad{background:${tint.red};color:${C.red}}
.pill-neutral{background:${C.raised};color:${C.soft}}
.pill-neutral::before{background:${C.mute}}

/* Buttons: pills at least 44px tall */
form.inline{display:inline}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:44px;padding:0 20px;border-radius:999px;border:1px solid ${C.line};background:${C.raised};color:${C.text};font:inherit;font-weight:700;line-height:20px;text-align:center;text-decoration:none;cursor:pointer}
.btn:hover{border-color:${C.mute}}
.btn-primary{background:${C.green};border-color:${C.green};color:#000}
.btn-primary:hover{background:#3be477;border-color:#3be477}
.btn-danger{background:transparent;border-color:${C.red};color:${C.red}}
.btn-danger:hover{background:${tint.red};border-color:${C.red}}
.btn-small{min-height:36px;padding:0 14px;${TY.meta};font-weight:700}
.btn-block{width:100%}

/* Flash messages and banners */
.notice{border-radius:12px;padding:12px 16px;margin:0 0 16px;background:${C.raised};border-left:4px solid ${C.mute}}
.notice-ok{border-left-color:${C.green}}
.notice-error{border-left-color:${C.red}}
.notice-warn{border-left-color:${C.amber}}
.notice ul{margin:8px 0 0;padding-left:20px}
.notice a{color:${C.text}}

/* Lists of rows (activity, playlists, problems) */
.rows{list-style:none;margin:0;padding:0}
.rows>li{display:flex;align-items:baseline;justify-content:space-between;gap:4px 12px;padding:12px 0;border-top:1px solid ${C.line}}
.rows>li:first-child{border-top:0;padding-top:0}
.rows>li:last-child{padding-bottom:0}
.rows .main{flex:1 1 0;min-width:0;overflow-wrap:anywhere}
.rows .meta{${TY.meta};color:${C.mute}}
.rows .side{flex:none;display:flex;align-items:center;gap:8px}
.rows .row-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}
.rows h3 a{color:${C.text};text-decoration:none}
.rows h3 a:hover{text-decoration:underline}
.rows h3 a::after{content:" \\2197";content:" \\2197" / "";color:${C.mute};font-weight:400}
.error-text{display:block;margin-top:8px;padding:8px 12px;border-radius:8px;background:${C.page};color:${C.soft};font-family:${MONO};font-size:13px;line-height:18px;white-space:pre-wrap;overflow-wrap:anywhere}
details{margin-top:16px;border-top:1px solid ${C.line};padding-top:12px}
summary{display:flex;align-items:center;gap:8px;min-height:44px;cursor:pointer;font-weight:700;list-style:none}
summary::-webkit-details-marker{display:none}
summary::before{content:"\\25B8";content:"\\25B8" / "";color:${C.soft};width:16px;font-size:18px}
details[open]>summary::before{content:"\\25BE";content:"\\25BE" / ""}
.tags{display:flex;flex-wrap:wrap;gap:8px;list-style:none;margin:12px 0 0;padding:0}
.tags a{display:inline-flex;align-items:center;min-height:36px;padding:0 14px;border-radius:999px;background:${C.raised};color:${C.text};${TY.meta};text-decoration:none}
.tags a:hover{background:${C.line}}

/* Settings form. A boolean row: checkbox | label, description, source, error; the confirmation
   spans the row. A field row (number, select): label, description, input, source, error. */
fieldset{border:0;margin:0 0 16px;padding:20px;background:${C.card};border-radius:16px;min-width:0}
legend{float:left;width:100%;padding:0;margin:0 0 4px;${TY.heading}}
legend+*{clear:both}
.setting{display:grid;grid-template-columns:24px minmax(0,1fr);gap:4px 12px;padding:16px 0;border-top:1px solid ${C.line}}
legend+.setting{border-top:0}
.setting>*{grid-column:2}
.setting>.control{grid-column:1;grid-row:1/span 2;padding-top:1px}
.setting.field{grid-template-columns:minmax(0,1fr)}
.setting.field>*{grid-column:1}
.setting input[type=checkbox]{width:22px;height:22px;margin:0;accent-color:${C.green};cursor:pointer}
.setting>label{font-weight:700;cursor:pointer}
.setting .desc{${TY.meta};color:${C.soft};margin:0}
.setting .meta-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:4px}
.source{${TY.micro};color:${C.mute};text-transform:uppercase;letter-spacing:.6px;font-weight:700}
.source-dashboard{color:${C.green}}
input[type=number],select{width:100%;max-width:320px;min-height:44px;margin-top:8px;padding:0 12px;border-radius:12px;border:1px solid ${C.line};background:${C.raised};color:${C.text};font:inherit}
input[type=number]{max-width:140px}
input[type=number]:hover,select:hover{border-color:${C.mute}}
[aria-invalid=true]{border-color:${C.red}!important;outline:1px solid ${C.red}}
.field-error{${TY.meta};color:${C.red};font-weight:700;margin:4px 0 0}
.setting>.confirm{grid-column:1/-1;margin-top:12px;padding:16px;border-radius:12px;background:${tint.amber};border:1px solid ${C.amber}}
.confirm p{${TY.meta};color:${C.text};margin:0 0 8px}
.confirm strong{color:${C.amber}}
.confirm label{display:flex;align-items:center;gap:12px;min-height:44px;font-weight:700;cursor:pointer}
.confirm.invalid{border-color:${C.red};background:${tint.red}}
.confirm.invalid strong{color:${C.red}}
@supports selector(:has(*)){.gated>.confirm{display:none}.gated:has(.toggle:checked)>.confirm,.gated>.confirm.invalid{display:block}}
/* Import upload: a file picker whose button matches .btn, and a slim green progress bar. */
input[type=file]{display:block;width:100%;max-width:100%;padding:8px 0;color:${C.soft};font:inherit;${TY.meta};cursor:pointer}
input[type=file]::file-selector-button{min-height:44px;margin-right:12px;padding:0 20px;border-radius:999px;border:1px solid ${C.line};background:${C.raised};color:${C.text};font:inherit;font-weight:700;cursor:pointer}
input[type=file]:hover::file-selector-button{border-color:${C.mute}}
progress{display:block;width:100%;height:8px;margin-top:16px;border:0;border-radius:999px;background:${C.raised};color:${C.green};overflow:hidden;-webkit-appearance:none;appearance:none}
progress::-webkit-progress-bar{background:${C.raised};border-radius:999px}
progress::-webkit-progress-value{background:${C.green};border-radius:999px}
progress::-moz-progress-bar{background:${C.green};border-radius:999px}
[hidden]{display:none!important}
.savebar{position:sticky;bottom:0;z-index:1;display:flex;flex-wrap:wrap;align-items:center;gap:12px;margin:0 -16px 32px;padding:12px 16px;background:${C.page};border-top:1px solid ${C.line}}

/* Landing page: main.narrow is a flex column, so the disc (decorative) shows above the h1. */
.disc{order:-1;position:relative;width:200px;height:200px;margin:0 auto 24px}
.disc img{position:relative;display:block;width:200px;height:200px}
.disc-label{position:absolute;left:62.5px;top:55px;width:75px;height:75px;border-radius:50%;background:linear-gradient(150deg,#1ed760 0%,#19bd55 55%,#14a64b 100%)}
main.narrow h1{${TY.display};margin:0 0 12px;text-wrap:balance}
main.narrow .lead{text-wrap:balance}
main.narrow .lead{margin:0 0 32px}
main.narrow .note{margin-top:16px}
main.narrow>.btn{align-self:center}

@media (min-width:640px){
.top{grid-template-columns:auto 1fr auto;grid-template-areas:"brand nav out";padding:0 max(24px,calc((100% - 712px) / 2));min-height:64px}
.top.bare{padding-bottom:0}
.top nav{margin:0;overflow:visible}
.top ul{padding:0}
.top nav a{min-height:64px}
main{padding:40px 24px 64px}
.card,fieldset{padding:24px}
.setting{grid-template-columns:24px minmax(0,1fr) auto}
.setting>.meta-row{grid-column:3;grid-row:1;margin-top:0;justify-content:flex-end}
.setting>.confirm{grid-column:2/-1}
.setting.field{grid-template-columns:minmax(0,1fr) auto}
.setting.field>.meta-row{grid-column:2}
.btn-block{width:auto}
.savebar{margin-left:0;margin-right:0;padding-left:0;padding-right:0}
main.narrow{padding-top:80px}
.disc,.disc img{width:216px;height:216px}
.disc-label{left:67.5px;top:59.5px;width:81px;height:81px}
}
@media (hover:none){.btn:hover{border-color:${C.line}}}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important;scroll-behavior:auto!important}}`;
