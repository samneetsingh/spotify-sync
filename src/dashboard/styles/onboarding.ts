// The guided tour (public/tour.js): the page dims except for a rounded spotlight that glides to each
// part of the page, with a card beside it (a bottom sheet on phones). The overlay lets clicks
// through, so the owner can flip settings in the spotlight; only the card takes the pointer.

import { COLOR as K } from "../tokens";

export const ONBOARDING_CSS = `
.tour{position:fixed;inset:0;z-index:50;pointer-events:none;opacity:0;transition:opacity .35s ease}
.tour.is-on{opacity:1}
.tour.is-leaving{opacity:0;transition-duration:.25s}
.tour-spot{position:fixed;border-radius:22px;box-shadow:0 0 0 2px rgba(44,217,255,.55),0 0 0 200vmax rgba(2,6,20,.72);transition:top .45s cubic-bezier(.2,.7,.2,1),left .45s cubic-bezier(.2,.7,.2,1),width .45s cubic-bezier(.2,.7,.2,1),height .45s cubic-bezier(.2,.7,.2,1)}
.tour-card{position:fixed;width:min(360px,calc(100vw - 32px));padding:20px;border:1px solid rgba(255,255,255,.14);border-radius:18px;background:${K.navy};color:${K.text};box-shadow:0 24px 64px rgba(0,0,0,.55);pointer-events:auto;opacity:0;transform:translateY(8px);transition:opacity .3s ease,transform .3s cubic-bezier(.2,.7,.2,1),left .45s cubic-bezier(.2,.7,.2,1),top .45s cubic-bezier(.2,.7,.2,1)}
.tour-card.is-in{opacity:1;transform:none}
.tour-card[data-mode=center]{width:min(420px,calc(100vw - 32px));text-align:center}
.tour-card[data-mode=sheet]{width:calc(100vw - 32px)}
.tour-bar{height:3px;margin:-4px 0 14px;border-radius:2px;background:rgba(255,255,255,.1);overflow:hidden}
.tour-bar span{display:block;height:100%;border-radius:2px;background:linear-gradient(90deg,${K.blue},${K.cyan});transition:width .45s ease}
.tour-count{margin:0 0 4px;font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:${K.soft}}
.tour-card h2{margin:0 0 6px;font-size:20px;line-height:26px}
.tour-card p#tour-text{margin:0;color:${K.soft}}
.tour-link{display:inline-block;margin-top:10px;font-weight:650}
.tour-note{margin:12px 0 0;font-size:14px;font-weight:650}
.tour-note.is-ok{color:${K.ok}}
.tour-note.is-ok::before{content:"✓ "}
.tour-note.is-error{color:${K.bad}}
.tour.is-busy .tour-actions button{opacity:.6;pointer-events:none}
.tour-actions{display:flex;align-items:center;gap:8px;margin-top:18px}
.tour-card[data-mode=center] .tour-actions{justify-content:center}
.tour-skip{margin-right:auto;padding:8px 0;border:0;background:none;color:${K.soft};font:inherit;font-size:14px;font-weight:600;cursor:pointer}
.tour-skip:hover{color:${K.text}}
.tour-card[data-mode=center] .tour-skip{margin-right:8px}
`;
