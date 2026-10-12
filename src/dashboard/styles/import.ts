// Styles for the Import page and the auth problem pages (only what styles/base.ts's shared classes
// don't cover).
//
// - Upload: the file input itself is the drop zone (browsers accept dropped files on it), a dashed
//   well that turns solid mint once files are chosen (`:valid`, the input is required) and dims while
//   public/import.js uploads (it disables the input). `.upload-status` is the aria-live progress text.
// - Review: `.totals`, three number tiles; `.years`, the per-year table (shared table classes, with
//   narrower cells so four columns fit a phone).
// - `.files-read`: the reading progress bar on a progress page.
// - `.problem`: the panel of an auth problem page (main.narrow), a small record above its text.

import { COLOR as K, FONT, LINE, LINE_STRONG, SHADOW, ty } from "../tokens";

const PANEL = `linear-gradient(180deg,${K.panelTop},${K.panelBottom})`;

export const IMPORT_CSS = `
/* Import: upload */
.dropzone{margin-top:20px}
.dropzone>label{display:block;font-weight:650}
.dropzone input[type=file]{margin-top:12px;padding:20px 16px;border:2px dashed rgba(255,180,84,.4);border-radius:12px;background:${K.well};box-shadow:${SHADOW.well};transition:border-color .15s ease}
.dropzone input[type=file]:hover{border-color:${K.accent}}
.dropzone input[type=file]:valid{border-style:solid;border-color:rgba(95,227,176,.6);color:${K.text}}
.dropzone input[type=file]:disabled{opacity:.6;cursor:progress}
.upload-status:empty{margin:0}

/* Import: review */
.totals{display:grid;grid-template-columns:minmax(0,1fr);gap:8px;margin:16px 0 0}
.totals>div{padding:12px 16px;border-radius:12px;background:${K.well};box-shadow:${SHADOW.well}}
.totals dt{${ty("meta")};color:${K.mute}}
.totals dd{margin:4px 0 0;overflow-wrap:anywhere}
.totals .num{display:block;font-family:${FONT.display};font-size:28px;line-height:32px;font-weight:700;letter-spacing:-.01em;color:${K.text}}
.totals .sub{margin-top:4px}
details>.table-wrap{margin:4px 0 8px}
.years th,.years td{padding-left:8px;padding-right:8px}
.years th:first-child{padding-left:12px}
.years :is(th,td):last-child{padding-right:12px}
.years tfoot th,.years tfoot td{border-top:1px solid ${LINE_STRONG};color:${K.text};font-weight:650}

/* Import: progress */
.files-read{margin:16px 0 0}

/* Auth problem pages */
.problem{margin-top:12px;padding:24px 20px;border-radius:20px;background:${PANEL};border:1px solid ${LINE};box-shadow:${SHADOW.panel};color:${K.soft}}
.problem::before{content:"";display:block;width:44px;height:44px;margin:0 auto 16px;border-radius:50%;background:radial-gradient(circle,${K.panelBottom} 0 3px,${K.accent} 3.5px 11px,${K.panelBottom} 11.5px 13px,#2a2d52 13.5px 14.5px,${K.panelBottom} 15px 16.5px,#2a2d52 17px 18px,${K.panelBottom} 18.5px);box-shadow:0 0 0 1px #3a3d6b,0 2px 6px rgba(0,0,0,.5)}
.problem>p:last-child{margin-bottom:0}
.problem .actions{justify-content:center}

@media (min-width:640px){
.totals{grid-template-columns:repeat(3,minmax(0,1fr))}
.problem{padding:32px}
}
`;
