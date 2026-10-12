// Server-side rendering of the dashboard's TSX views (hono/jsx) to HTML strings.
//
// JSX escapes every text child and attribute value. `raw()` marks a trusted string that goes in as
// is: the CSS, or HTML the `ui` helpers already escaped. Never pass Spotify or user text to raw().

import { raw } from "hono/html";
import type { JSX } from "hono/jsx/jsx-runtime";

export { raw };

/** The HTML for a JSX element. Components must be synchronous: a Promise anywhere in the tree throws. */
export function render(node: JSX.Element): string {
  const out: unknown = node instanceof Promise ? node : node.toString();
  if (out instanceof Promise) {
    out.catch(() => {}); // the throw below reports it; don't leave an unhandled rejection behind
    throw new Error("render: a component returned a Promise; dashboard components must be synchronous");
  }
  return String(out);
}
