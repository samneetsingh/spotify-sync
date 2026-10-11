// The owner dashboard (tasks/dashboard-plan.md section 5).
// CONTRACT from WP-0. WP-C owns src/dashboard/* and implements handleDashboard and landingPage
// (they throw until then). renderPage and `ui` already work in a plain form so auth (WP-A) and
// import (WP-D) pages can be built and tested now; WP-C replaces their look, keeping the exports,
// options and escaping rules: arguments named `...Html`/`body` are trusted HTML, everything else is
// text and gets escaped. Classes only: the CSP blocks `style=` attributes.

import type { Session } from "../auth";
import { C, FONT, TY, esc } from "../email/layout";
import type { Env } from "../env";
import { cspNonce, html } from "../http";

export type NavKey = "home" | "settings" | "activity" | "import";

export interface Notice {
  kind: "ok" | "error";
  text: string;
}

export interface PageOptions {
  /** The <title> and the page's <h1>; headings in `body` start at <h2>. */
  title: string;
  /** Logged in: the header shows the nav and a "Log out" button. */
  session: Session | null;
  /** The current nav item (aria-current="page"). */
  nav?: NavKey;
  /** Trusted HTML. Escape every Spotify- or user-supplied value (esc, or the ui helpers). */
  body: string;
  /** A flash message above the heading: ok is role=status, error is role=alert. */
  notice?: Notice;
  /** Reloads the page every N seconds (<meta http-equiv=refresh>), for progress pages without JS. */
  refreshSeconds?: number;
  /** Same-origin module scripts, e.g. ["/import.js"] (the CSP allows script-src 'self' only). */
  scripts?: string[];
  /** HTTP status, default 200. Headers (e.g. Set-Cookie) can be appended to the returned Response. */
  status?: number;
}

const NAV: Array<{ key: NavKey; href: string; label: string }> = [
  { key: "home", href: "/", label: "Home" },
  { key: "settings", href: "/settings", label: "Settings" },
  { key: "activity", href: "/activity", label: "Activity" },
  { key: "import", href: "/import", label: "Import" },
];

const CSS = `*{box-sizing:border-box}
body{margin:0;background:${C.page};color:${C.text};font-family:${FONT};${TY.body}}
a{color:${C.green}}
:focus-visible{outline:2px solid ${C.green};outline-offset:2px}
.top{display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between;padding:16px;border-bottom:1px solid ${C.line}}
.brand{color:${C.text};font-weight:800;text-decoration:none}
.top ul{list-style:none;display:flex;flex-wrap:wrap;gap:16px;margin:0;padding:0}
.top nav a{color:${C.soft};text-decoration:none}
.top nav a[aria-current=page]{color:${C.text};font-weight:700}
main{max-width:720px;margin:0 auto;padding:24px 16px 48px}
h1{${TY.number};margin:0 0 24px}
h2{${TY.heading};margin:0 0 12px}
.card{background:${C.card};border-radius:16px;padding:20px;margin:0 0 16px}
.actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:16px}
.facts{display:grid;grid-template-columns:auto 1fr;gap:4px 16px;margin:0}
.facts dt{color:${C.mute}}
.facts dd{margin:0}
.pill{display:inline-block;border-radius:999px;padding:2px 10px;${TY.meta};font-weight:700}
.pill-ok{background:${C.green};color:#000}
.pill-warn{background:${C.amber};color:#000}
.pill-bad{background:${C.red};color:#000}
.pill-neutral{background:${C.raised};color:${C.soft}}
form.inline{display:inline}
.btn{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:0 20px;border-radius:999px;border:1px solid ${C.line};background:${C.raised};color:${C.text};font:inherit;font-weight:700;text-decoration:none;cursor:pointer}
.btn-primary{background:${C.green};border-color:${C.green};color:#000}
.btn-danger{background:transparent;border-color:${C.red};color:${C.red}}
.notice{border-radius:12px;padding:12px 16px;margin:0 0 16px;background:${C.raised}}
.notice-error{border:1px solid ${C.red}}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}`;

export type Tone = "ok" | "warn" | "bad" | "neutral";
export type ButtonVariant = "primary" | "secondary" | "danger";

/** Building blocks for dashboard markup. Text arguments are escaped; `...Html` arguments are trusted. */
export const ui = {
  esc,
  /** A card: <section class="card"> with an <h2> title, the body, and an optional row of actions. */
  card(title: string, bodyHtml: string, opts: { id?: string; actionsHtml?: string } = {}): string {
    const id = opts.id ? ` id="${esc(opts.id)}"` : "";
    const actions = opts.actionsHtml ? `<div class="actions">${opts.actionsHtml}</div>` : "";
    return `<section class="card"${id}><h2>${esc(title)}</h2>${bodyHtml}${actions}</section>`;
  },
  /** Label/value rows (<dl class="facts">). */
  facts(rows: Array<[label: string, value: string]>): string {
    return `<dl class="facts">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>`;
  },
  /** A status pill. Its text carries the meaning; colour is never the only signal. */
  pill(tone: Tone, text: string): string {
    return `<span class="pill pill-${tone}">${esc(text)}</span>`;
  },
  /** A one-button POST form (state changes never happen on GET; the router checks Origin). */
  postButton(action: string, label: string, opts: { fields?: Record<string, string>; variant?: ButtonVariant } = {}): string {
    const fields = Object.entries(opts.fields ?? {})
      .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
      .join("");
    return `<form class="inline" method="post" action="${esc(action)}">${fields}<button type="submit" class="btn btn-${opts.variant ?? "secondary"}">${esc(label)}</button></form>`;
  },
  /** A link that looks like a button. */
  linkButton(href: string, label: string, variant: ButtonVariant = "secondary"): string {
    return `<a class="btn btn-${variant}" href="${esc(href)}">${esc(label)}</a>`;
  },
  /** A flash message: role=status (ok) or role=alert (error). */
  notice(n: Notice): string {
    return `<div class="notice notice-${n.kind}" role="${n.kind === "ok" ? "status" : "alert"}">${esc(n.text)}</div>`;
  },
};

/** A full dashboard page with the security headers and a per-response CSP nonce. */
export function renderPage(opts: PageOptions): Response {
  const nonce = cspNonce();
  const refresh = opts.refreshSeconds ? `<meta http-equiv="refresh" content="${Math.max(1, Math.floor(opts.refreshSeconds))}">` : "";
  const scripts = (opts.scripts ?? []).map((src) => `<script type="module" src="${esc(src)}"></script>`).join("");
  const nav = opts.session
    ? `<nav aria-label="Dashboard"><ul>${NAV.map((n) => `<li><a href="${n.href}"${n.key === opts.nav ? ' aria-current="page"' : ""}>${n.label}</a></li>`).join("")}</ul></nav>${ui.postButton("/logout", "Log out")}`
    : "";
  const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">${refresh}<title>${esc(opts.title)} · spotify-sync</title><style nonce="${nonce}">${CSS}</style>${scripts}</head>
<body><header class="top"><a class="brand" href="/">spotify-sync</a>${nav}</header>
<main id="main">${opts.notice ? ui.notice(opts.notice) : ""}<h1>${esc(opts.title)}</h1>
${opts.body}
</main></body></html>`;
  return html(page, { nonce, status: opts.status });
}

/** Paths handleDashboard answers. */
const DASHBOARD_PATHS = new Set(["/", "/settings", "/activity"]);

const notImplemented = (what: string) => new Error(`not implemented: ${what} (WP-C)`);

/**
 * GET / (landing without a session, home with one), GET/POST /settings, GET /activity and
 * POST /actions/*; null for any other path. Owner pages without a session: authRequired(request)
 * from src/http.ts. The router has already checked Origin on non-GET requests.
 */
export async function handleDashboard(request: Request, env: Env, ctx: ExecutionContext, session: Session | null): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  if (DASHBOARD_PATHS.has(pathname) || pathname.startsWith("/actions/")) throw notImplemented(`${request.method} ${pathname}`);
  return null;
}

/** The logged-out home page: "Log in with Spotify", "Almost ready" (unclaimed) or "still being set up". */
export async function landingPage(env: Env, db: D1Database): Promise<Response> {
  throw notImplemented("landingPage");
}
