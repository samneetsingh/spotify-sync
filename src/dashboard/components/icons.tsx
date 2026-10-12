// Line icons (24px grid, 2px round strokes), drawn with currentColor. The TSX uses <Icon>; the CSS
// uses iconUrl() for icons it draws itself (nav squares, the brand mark, the missing-art tile), since
// the CSP allows data: images but no style= attributes. Decorative only: the text next to an icon
// carries the meaning.

import { raw } from "../render";

const PATHS = {
  home: `<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9.5"/>`,
  settings: `<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h10M18 18h2"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="16" cy="18" r="2"/>`,
  activity: `<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>`,
  play: `<path d="M7 4.5v15a1 1 0 0 0 1.5.86l12.6-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5Z"/>`,
  clock: `<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>`,
  music: `<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>`,
  user: `<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>`,
  chevron: `<path d="m6 9 6 6 6-6"/>`,
} as const;

export type IconName = keyof typeof PATHS;

/** An inline icon in the current text colour. */
export function Icon({ name, class: cls = "icon", size = 24 }: { name: IconName; class?: string; size?: number }) {
  return (
    <svg class={cls} viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
      {raw(PATHS[name])}
    </svg>
  );
}

/** The icon as a CSS url() (a data: SVG) in `color`, for backgrounds. */
export function iconUrl(name: IconName, color: string): string {
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='${color}' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'>${PATHS[name].replaceAll('"', "'")}</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}
