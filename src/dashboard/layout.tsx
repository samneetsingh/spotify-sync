// Page shell and markup helpers for every dashboard page (also used by auth and import pages).
//
// Escaping rule: arguments named `...Html` and `body` are trusted HTML; everything else is text and
// gets escaped (JSX escapes by default). Classes only, never `style=` attributes: the CSP allows the
// one nonce'd <style>.

import type { Child } from "hono/jsx";
import { localTime as alertTime } from "../alerts";
import type { Session } from "../auth";
import { esc } from "../email/layout";
import { cspNonce, html } from "../http";
import { Notice as NoticeView, PostButton } from "./components/primitives";
import { raw, render } from "./render";
import { CSS } from "./styles";

export type NavKey = "home" | "manage" | "settings" | "activity" | "import";

export interface Notice {
  /** ok: role=status; error: role=alert; warn: role=status with an amber edge (e.g. settings problems). */
  kind: "ok" | "error" | "warn";
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
  /** "narrow": a centred single column (the logged-out landing page). Default: the dashboard column. */
  layout?: "default" | "narrow";
  /** Show the Import nav item (default true; the dashboard hides it when the import bindings are missing). */
  importEnabled?: boolean;
}

const NAV: Array<{ key: NavKey; href: string; label: string }> = [
  { key: "home", href: "/", label: "Home" },
  { key: "manage", href: "/manage", label: "Manage" },
  { key: "settings", href: "/settings", label: "Settings" },
  { key: "activity", href: "/activity", label: "Activity" },
  { key: "import", href: "/import", label: "Import" },
];

export type Tone = "ok" | "warn" | "bad" | "neutral";
export type ButtonVariant = "primary" | "secondary" | "danger";

/** Building blocks for dashboard markup. Text arguments are escaped; `...Html` arguments are trusted. */
export const ui = {
  esc,
  /**
   * A card: <section class="card"> with an <h2> title, the body, and an optional row of actions.
   * `headHtml` goes next to the title (e.g. a status pill).
   */
  card(title: string, bodyHtml: string, opts: { id?: string; actionsHtml?: string; headHtml?: string } = {}): string {
    const id = opts.id ? ` id="${esc(opts.id)}"` : "";
    const labelled = opts.id ? ` aria-labelledby="${esc(opts.id)}-title"` : "";
    const h2 = `<h2${opts.id ? ` id="${esc(opts.id)}-title"` : ""}>${esc(title)}</h2>`;
    const head = opts.headHtml ? `<div class="card-head">${h2}${opts.headHtml}</div>` : `<div class="card-head">${h2}</div>`;
    const actions = opts.actionsHtml ? `<div class="actions">${opts.actionsHtml}</div>` : "";
    return `<section class="card"${id}${labelled}>${head}${bodyHtml}${actions}</section>`;
  },
  /** Label/value rows (<dl class="facts">). */
  facts(rows: Array<[label: string, value: string]>): string {
    return ui.factsHtml(rows.map(([k, v]) => [k, esc(v)]));
  },
  /** Label/value rows whose values are trusted HTML (links, pills, a muted second line). */
  factsHtml(rows: Array<[label: string, valueHtml: string]>): string {
    return `<dl class="facts">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join("")}</dl>`;
  },
  /** A status pill. Its text carries the meaning; colour is never the only signal. */
  pill(tone: Tone, text: string): string {
    return `<span class="pill pill-${tone}">${esc(text)}</span>`;
  },
  /** A one-button POST form (state changes never happen on GET; the router checks Origin). */
  postButton(
    action: string,
    label: string,
    opts: { fields?: Record<string, string>; variant?: ButtonVariant; small?: boolean; ariaLabel?: string } = {},
  ): string {
    const fields = Object.entries(opts.fields ?? {})
      .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
      .join("");
    const cls = `btn btn-${opts.variant ?? "secondary"}${opts.small ? " btn-small" : ""}`;
    const aria = opts.ariaLabel ? ` aria-label="${esc(opts.ariaLabel)}"` : "";
    return `<form class="inline" method="post" action="${esc(action)}">${fields}<button type="submit" class="${cls}"${aria}>${esc(label)}</button></form>`;
  },
  /** A link that looks like a button. */
  linkButton(href: string, label: string, variant: ButtonVariant = "secondary"): string {
    return `<a class="btn btn-${variant}" href="${esc(href)}">${esc(label)}</a>`;
  },
  /** A link to Spotify (or any absolute URL we built); opens in the same tab. */
  link(href: string, label: string): string {
    return `<a href="${esc(href)}">${esc(label)}</a>`;
  },
  /** A flash message: role=status (ok, warn) or role=alert (error). */
  notice(n: Notice): string {
    return `<div class="notice notice-${n.kind}" role="${n.kind === "error" ? "alert" : "status"}">${esc(n.text)}</div>`;
  },
};

// ---------------------------------------------------------------------------- times

/** "just now", "12 min ago", "3 h ago", "2 days ago" (future times: "in 5 min"). */
export function ago(ms: number, now: number): string {
  const diff = now - ms;
  const abs = Math.abs(diff);
  const say = (n: number, unit: string) => (diff >= 0 ? `${n} ${unit} ago` : `in ${n} ${unit}`);
  if (abs < 60_000) return diff >= 0 ? "just now" : "in a moment";
  if (abs < 3_600_000) return say(Math.round(abs / 60_000), "min");
  if (abs < 48 * 3_600_000) return say(Math.round(abs / 3_600_000), "h");
  const days = Math.round(abs / 86_400_000);
  return say(days, days === 1 ? "day" : "days");
}

/** "Sat, Oct 11, 3:20 PM PDT" in `timeZone` (UTC if that zone is invalid). */
export const localTime = alertTime;

/** A relative time with the local time under it (trusted HTML, for ui.factsHtml and rows). */
export const whenHtml = (ms: number, now: number, timeZone: string): string =>
  `${esc(ago(ms, now))}<span class="sub">${esc(localTime(ms, timeZone))}</span>`;

// ---------------------------------------------------------------------------- page

/** The shell's options: PageOptions without the body and the HTTP status. */
export type ShellOptions = Omit<PageOptions, "body" | "status">;

/**
 * The page shell: skip link, header (brand; with a session also the nav and "Log out"), then <main>
 * with the notice, the <h1> and the children. `nonce` goes on the one <style>.
 */
export function Page(props: ShellOptions & { nonce: string; children?: Child }) {
  const { title, session, notice } = props;
  const items = NAV.filter((n) => n.key !== "import" || props.importEnabled !== false);
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <meta name="robots" content="noindex" />
        <meta name="color-scheme" content="dark" />
        {props.refreshSeconds ? <meta http-equiv="refresh" content={String(Math.max(1, Math.floor(props.refreshSeconds)))} /> : null}
        <title>{title} · spotify-sync</title>
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
        <style nonce={props.nonce}>{raw(CSS)}</style>
        {(props.scripts ?? []).map((src) => (
          <script type="module" src={src}></script>
        ))}
      </head>
      <body>
        <a class="skip" href="#main">
          Skip to content
        </a>
        <header class={session ? "top" : "top bare"}>
          <a class="brand" href="/">
            <span class="mark" aria-hidden="true"></span>spotify-sync
          </a>
          {session ? (
            <>
              <nav aria-label="Dashboard">
                <ul>
                  {items.map((n) => (
                    <li>
                      <a href={n.href} aria-current={n.key === props.nav ? "page" : undefined}>
                        {n.label}
                      </a>
                    </li>
                  ))}
                </ul>
              </nav>
              <div class="out">
                <PostButton action="/logout" label="Log out" small />
              </div>
            </>
          ) : null}
        </header>
        <main id="main" class={props.layout === "narrow" ? "narrow" : undefined}>
          {notice ? <NoticeView {...notice} /> : null}
          <h1>{title}</h1>
          {props.children}
        </main>
      </body>
    </html>
  );
}

/** A full dashboard page with the security headers and a per-response CSP nonce. */
export function renderPage(opts: PageOptions): Response {
  const nonce = cspNonce();
  const { body, status, ...shell } = opts;
  const page = render(
    <Page {...shell} nonce={nonce}>
      {raw(body)}
    </Page>,
  );
  return html(`<!doctype html>${page}`, { nonce, status });
}
