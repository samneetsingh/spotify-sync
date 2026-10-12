// Styles for Manage, Settings, Activity and the landing page. The shared classes
// (cards, rows, facts, pills, buttons, forms, the disc) are in base.ts; only page-specific rules here.

import { COLOR as K, TINT } from "../tokens";

export const PAGES_CSS = `
/* Settings: a row someone linked to (Home's widget sends Liked Songs to /settings#s-liked) is marked. */
.setting{scroll-margin-top:24px}
.setting:target{margin:0 -12px;padding-left:12px;padding-right:12px;border-radius:12px;background:${TINT.warn};box-shadow:inset 3px 0 0 ${K.accent}}

/* Landing: grooves and a warm glow behind the record, which settles with one slow turn (no motion
   when the visitor prefers reduced motion: base.ts turns animations off). */
main.narrow .disc{animation:disc-settle 2.4s cubic-bezier(.16,.8,.24,1) both}
main.narrow .disc::before{content:"";position:absolute;inset:-32px;border-radius:50%;background:repeating-radial-gradient(circle,rgba(255,255,255,.025) 0 1px,transparent 1px 5px),radial-gradient(closest-side,rgba(255,180,84,.16),rgba(255,180,84,.04) 70%,transparent);pointer-events:none}
@keyframes disc-settle{from{transform:rotate(-120deg);opacity:0}to{transform:none;opacity:1}}
`;
