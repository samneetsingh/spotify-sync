// The settings page's dashboard layout: problems (and the Spotify card while it needs the owner) on
// top, the everyday settings in a grid (Playlists two columns wide with its settings in two columns,
// Emails beside it), then a row of the rarer cards (General, Spotify, Account), then the save bar
// (shown by public/settings-form.js once something changed). Account's parts (History import,
// sign-in) are separated by a hairline. The cards' and fieldsets' own look is in base.ts.

import { COLOR as K, LINE } from "../tokens";

export const SETTINGS_CSS = `
.dash{display:grid;gap:20px;margin:0 0 20px}
.dash>.card,.dash>fieldset{margin:0;min-width:0}
.savebar[hidden]{display:none}
.card-part+.card-part{margin-top:20px;padding-top:20px;border-top:1px solid rgba(255,255,255,.09)}
.part-head{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.part-head h3{margin:0}
.settings-list>.setting:first-child{border-top:0}
/* A status line's button (a digest's "Send me a preview") goes on its own line under the text, unwrapped. */
.status-action{flex:1 0 100%}
.setting-status .btn{white-space:nowrap}
/* The artist playlists modal (a popover in the top layer, centred, over a dimmed page). Browsers
   without popovers show the list inline instead. Only the list scrolls, so its scrollbar stays clear
   of the rounded corners and the title and Close stay in view. (display is set only while open:
   the UA hides a closed popover with display:none.) */
.modal{width:min(640px,calc(100% - 32px));max-height:min(80vh,760px);margin:auto;padding:24px;overflow:hidden;border:1px solid rgba(255,255,255,.12);border-radius:20px;background:${K.navy};color:${K.text};box-shadow:0 24px 64px rgba(0,0,0,.6)}
.modal:popover-open{display:flex;flex-direction:column}
.modal::backdrop{background:rgba(3,12,29,.72);-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px)}
/* Opening and closing both animate: the modal fades and rises in, then fades and drops out, the
   backdrop fading with it (display and the top layer stay until the transition ends). Browsers
   without popovers skip this block and show the list inline; without @starting-style it just snaps. */
@supports selector(:popover-open){
.modal{opacity:0;transform:translateY(8px) scale(.98);transition:opacity .25s ease,transform .25s cubic-bezier(.2,.7,.2,1),overlay .25s allow-discrete,display .25s allow-discrete}
.modal:popover-open{opacity:1;transform:none}
.modal::backdrop{opacity:0;transition:opacity .25s ease,overlay .25s allow-discrete,display .25s allow-discrete}
.modal:popover-open::backdrop{opacity:1}
@starting-style{.modal:popover-open{opacity:0;transform:translateY(8px) scale(.98)}.modal:popover-open::backdrop{opacity:0}}
}
.modal-head{display:flex;align-items:center;justify-content:space-between;gap:12px}
.modal-head h3{margin:0}
.modal .note{margin-top:4px}
/* While it's open the page behind doesn't scroll, and the list's scrolling doesn't chain to it. */
html:has(.modal:popover-open){overflow:hidden}
.modal-list{list-style:none;display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:8px;flex:1 1 auto;min-height:0;overflow:auto;overscroll-behavior:contain;margin:16px -12px 0 -2px;padding:2px 12px 2px 2px}
.modal-list a{display:block;padding:10px 12px;border:1px solid ${LINE};border-radius:12px;background:rgba(255,255,255,.04);color:${K.text};font-weight:600;text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.modal-list a:hover,.modal-list a:focus-visible{border-color:${K.blue};background:rgba(0,117,255,.12)}
@media (min-width:900px){
.dash-top,.dash-more{grid-template-columns:repeat(auto-fit,minmax(300px,1fr))}
}
@media (min-width:1024px){
.dash-form{grid-template-columns:repeat(3,minmax(0,1fr));align-items:start}
.dash-form>.group-playlists{grid-column:span 2}
.group-playlists .settings-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));column-gap:32px}
.group-playlists .settings-list>.setting:nth-child(2){border-top:0}
}
`;
