// Styles for Settings and Activity (only what styles/base.ts's shared classes don't cover; the
// settings grid is in styles/settings.ts).

import { COLOR as K, TINT } from "../tokens";

export const PAGES_CSS = `
/* Settings: a row someone linked to (/settings#s-<key>) is marked. */
.setting{scroll-margin-top:24px}
.setting:target{margin:0 -12px;padding-left:12px;padding-right:12px;border-radius:15px;background:${TINT.blue};box-shadow:inset 3px 0 0 ${K.blue}}
`;
