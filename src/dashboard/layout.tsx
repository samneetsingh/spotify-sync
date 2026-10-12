// Page shell for every dashboard page (also used by the auth and import pages), and time helpers.
//
// Escaping rule: `body` is trusted HTML (render() of a TSX view); everything else is text and gets
// escaped (JSX escapes by default). Classes only, never `style=` attributes: the CSP allows the
// one nonce'd <style>.

import type { Child } from "hono/jsx";
import { localTime as alertTime } from "../alerts";
import type { Session } from "../auth";
import { cspNonce, html } from "../http";
import { PAGE_TOP } from "./tokens";
import { Notice as NoticeView } from "./components/primitives";
import { raw, render } from "./render";
import { CSS } from "./styles";

export type NavKey = "home" | "settings" | "activity";

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
  /** Trusted HTML, usually render(<View />): JSX escapes every Spotify- or user-supplied value. */
  body: string;
  /** A flash message above the heading: ok is role=status, error is role=alert. */
  notice?: Notice;
  /** Reloads the page every N seconds (<meta http-equiv=refresh>), for progress pages without JS. */
  refreshSeconds?: number;
  /** Same-origin module scripts, e.g. ["/import.js"] (the CSP allows script-src 'self' only). */
  scripts?: string[];
  /** HTTP status, default 200. Headers (e.g. Set-Cookie) can be appended to the returned Response. */
  status?: number;
  /**
   * "narrow": a centred single column (the logged-out landing page); "wide": the Home grid, up to
   * 1600px (the header lines up with it). Default: the dashboard column.
   */
  layout?: "default" | "narrow" | "wide";
  /** Keep the <h1> for screen readers and the tab title only (Home, whose hero leads the page). */
  hideTitle?: boolean;
  /** Show the Activity nav item (the `advanced` setting is on). Default: hidden. */
  showActivity?: boolean;
}

const NAV: Array<{ key: NavKey; href: string; label: string }> = [
  { key: "home", href: "/", label: "Home" },
  { key: "settings", href: "/settings", label: "Settings" },
  { key: "activity", href: "/activity", label: "Activity" },
];

export type Tone = "ok" | "warn" | "bad" | "neutral";
export type ButtonVariant = "primary" | "secondary" | "danger";

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

// ---------------------------------------------------------------------------- page

/** The shell's options: PageOptions without the body and the HTTP status. */
export type ShellOptions = Omit<PageOptions, "body" | "status">;

/**
 * The page shell: skip link, header (brand; with a session also the nav), then <main> with the
 * notice, the <h1> and the children. `nonce` goes on the one <style>. Log out lives in Settings
 * (the Account card).
 */
export function Page(props: ShellOptions & { nonce: string; children?: Child }) {
  const { title, session, notice, layout } = props;
  const mainClass = [layout === "narrow" || layout === "wide" ? layout : "", props.hideTitle ? "hide-title" : ""].filter(Boolean).join(" ");
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <meta name="robots" content="noindex" />
        <meta name="color-scheme" content="dark" />
        <meta name="theme-color" content={PAGE_TOP} />
        {props.refreshSeconds ? <meta http-equiv="refresh" content={String(Math.max(1, Math.floor(props.refreshSeconds)))} /> : null}
        <title>{title} · spotify-sync</title>
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
        <style nonce={props.nonce}>{raw(CSS)}</style>
        {(props.scripts ?? []).map((src) => (
          <script type="module" src={src}></script>
        ))}
      </head>
      <body class={session ? "with-nav" : undefined}>
        <a class="skip" href="#main">
          Skip to content
        </a>
        <header class={`top${session ? "" : " bare"}${layout === "wide" ? " wide" : ""}`}>
          <a class="brand" href="/">
            <span class="mark" aria-hidden="true"></span>spotify-sync
          </a>
          {session ? (
            <nav aria-label="Dashboard">
              <ul>
                {NAV.filter((n) => n.key !== "activity" || props.showActivity).map((n) => (
                  <li>
                    <a href={n.href} aria-current={n.key === props.nav ? "page" : undefined}>
                      {n.label}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
          ) : null}
        </header>
        <main id="main" class={mainClass || undefined}>
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
