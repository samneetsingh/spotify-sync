// Styles for the Import page and the auth problem pages (only what styles/base.ts's shared classes
// don't cover).
//
// - Upload: the file input itself is the drop zone (browsers accept dropped files on it), a dashed
//   blue well that turns solid green once files are chosen (`:valid`, the input is required) and dims
//   while public/import.js uploads (it disables the input). `.upload-status` is the aria-live progress text.
// - Review: `.totals`, three number tiles; `.years`, the per-year table (shared table classes, with
//   narrower cells so four columns fit a phone).
// - `.files-read`: the reading progress bar on a progress page.
// - `.problem`: the text of an auth problem page, inside main.narrow's glass card.

import { COLOR as K, LINE, LINE_STRONG, ty } from "../tokens";

export const IMPORT_CSS = `
/* Import: upload */
.dropzone{margin-top:20px}
.dropzone>label{display:block;font-weight:650}
.dropzone input[type=file]{margin-top:12px;padding:20px 16px;border:2px dashed rgba(0,117,255,.5);border-radius:15px;background:rgba(15,21,53,.6);transition:border-color .15s ease}
.dropzone input[type=file]:hover{border-color:${K.blue}}
.dropzone input[type=file]:valid{border-style:solid;border-color:rgba(1,181,116,.7);color:${K.text}}
.dropzone input[type=file]:disabled{opacity:.6;cursor:progress}
.upload-status:empty{margin:0}

/* Import: review */
.totals{display:grid;grid-template-columns:minmax(0,1fr);gap:10px;margin:16px 0 0}
.totals>div{padding:14px 16px;border-radius:15px;background:${K.well};border:1px solid ${LINE}}
.totals dt{${ty("micro")};font-weight:700;color:${K.soft};text-transform:uppercase;letter-spacing:.06em}
.totals dd{margin:4px 0 0;overflow-wrap:anywhere}
.totals .num{display:block;font-size:28px;line-height:34px;font-weight:700;letter-spacing:-.01em;color:${K.text}}
.totals .sub{margin-top:4px}
details>.table-wrap{margin:4px 0 8px}
.years th,.years td{padding-left:8px;padding-right:8px}
.years th:first-child{padding-left:14px}
.years :is(th,td):last-child{padding-right:14px}
.years tfoot th,.years tfoot td{border-top:1px solid ${LINE_STRONG};color:${K.text};font-weight:650}

/* Import: progress */
.files-read{margin:16px 0 0}

/* Auth problem pages: the text sits in main.narrow's glass card. */
.problem{margin-top:4px;color:${K.soft}}
.problem>p:last-child{margin-bottom:0}
.problem .actions{justify-content:center}

@media (min-width:640px){
.totals{grid-template-columns:repeat(3,minmax(0,1fr))}
}
`;
