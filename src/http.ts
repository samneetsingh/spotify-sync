// HTTP plumbing for the owner dashboard: HTML responses with the security headers, redirects,
// cookies and the CSRF (Origin) check. Pages themselves are built in src/dashboard.

import { C, FONT, TY, esc } from "./email/layout";

/** A fresh CSP nonce (128 random bits, base64). Use one per response. */
export function cspNonce(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
}

/**
 * Inline styles only through `<style nonce>` (no `style=` attributes), scripts only from our origin
 * (public/import.js), images from us and Spotify's CDN, fonts from us (self-hosted), forms to us and
 * Spotify's login.
 */
export function contentSecurityPolicy(nonce: string): string {
  return [
    "default-src 'none'",
    `style-src 'nonce-${nonce}'`,
    "script-src 'self'",
    "img-src 'self' https://i.scdn.co data:",
    "font-src 'self'",
    "connect-src 'self'",
    "form-action 'self' https://accounts.spotify.com",
    "frame-ancestors 'none'",
    "base-uri 'none'",
  ].join("; ");
}

/**
 * The Referrer-Policy on every response. `same-origin`: no Referer to other sites, so OAuth codes and
 * setup links never leak. Not `no-referrer`: with it, browsers send `Origin: null` on same-origin
 * POSTs and fetches (Fetch spec, "serializing a request origin"), which checkOrigin must refuse.
 */
export const REFERRER_POLICY = "same-origin";

/** Headers on every HTML response. */
export function securityHeaders(nonce: string): Record<string, string> {
  return {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": contentSecurityPolicy(nonce),
    "Referrer-Policy": REFERRER_POLICY,
    "X-Content-Type-Options": "nosniff",
    "X-Robots-Tag": "noindex",
    "Cache-Control": "no-store",
  };
}

/**
 * An HTML response with the security headers (which override any in `headers`; add Set-Cookie
 * there or append it afterwards). `page` must carry `nonce` on its `<style>` element.
 */
export function html(page: string, opts: { nonce: string; status?: number; headers?: HeadersInit }): Response {
  const headers = new Headers(opts.headers);
  for (const [name, value] of Object.entries(securityHeaders(opts.nonce))) headers.set(name, value);
  return new Response(page, { status: opts.status ?? 200, headers });
}

/** A redirect whose headers stay mutable (Response.redirect's are immutable, so no Set-Cookie). */
export function redirect(location: string, status: 302 | 303 = 303, headers?: HeadersInit): Response {
  const h = new Headers(headers);
  h.set("Location", location);
  h.set("Cache-Control", "no-store");
  h.set("Referrer-Policy", REFERRER_POLICY);
  return new Response(null, { status, headers: h });
}

/** "See other": after a POST, and for pages that moved. */
export const redirect303 = (location: string, headers?: HeadersInit): Response => redirect(location, 303, headers);

const PAGE_CSS = `body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:${C.page};color:${C.text};font-family:${FONT}}
main{max-width:420px;padding:40px 24px;text-align:center}
h1{${TY.number};margin:0 0 12px}
p{${TY.body};color:${C.soft};margin:0 0 24px}
a{color:${C.green};${TY.body}}
a:focus-visible{outline:2px solid ${C.green};outline-offset:2px}`;

/**
 * A small standalone page (404, 403, 500, 401) for responses outside the dashboard layout. Text
 * arguments are escaped.
 */
export function statusPage(status: number, title: string, message: string): Response {
  const nonce = cspNonce();
  const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title><link rel="icon" href="/favicon.svg" type="image/svg+xml"><style nonce="${nonce}">${PAGE_CSS}</style></head>
<body><main><h1>${esc(title)}</h1><p>${esc(message)}</p><a href="/">Go to the dashboard</a></main></body></html>`;
  return html(page, { nonce, status });
}

export const notFoundPage = (): Response => statusPage(404, "Page not found", "There's nothing at this address.");

/**
 * For an owner-only route without a session: GET/HEAD go to the login (and come back here), other
 * methods get 401.
 */
export function authRequired(request: Request): Response {
  if (request.method === "GET" || request.method === "HEAD") {
    const url = new URL(request.url);
    return redirect303(`/login?next=${encodeURIComponent(url.pathname + url.search)}`);
  }
  return statusPage(401, "Log in first", "Your session has ended. Log in again and retry.");
}

/**
 * CSRF check for every request that isn't GET or HEAD: `Origin` must equal PUBLIC_URL's origin
 * (which also rejects sibling subdomains that SameSite treats as same-site). Without a usable Origin
 * (absent, or `null` as browsers send under some referrer policies), `Sec-Fetch-Site: same-origin`
 * is accepted; browsers set it and pages can't. Fails closed when PUBLIC_URL is unset or invalid.
 */
export function checkOrigin(request: Request, publicUrl: string | undefined): boolean {
  let expected: string;
  try {
    expected = new URL(publicUrl ?? "").origin;
  } catch {
    return false;
  }
  const origin = request.headers.get("Origin");
  if (origin !== null && origin !== "null") return origin === expected;
  return request.headers.get("Sec-Fetch-Site") === "same-origin";
}

// ---------------------------------------------------------------------------- cookies

/** Local development: PUBLIC_URL is http:// (e.g. http://127.0.0.1:8788), where Secure cookies don't stick. */
export const isDevOrigin = (publicUrl: string | undefined): boolean => (publicUrl ?? "").startsWith("http://");

/** `__Host-<name>` (Secure, Path=/, no Domain); plain `<name>` on an http:// dev origin. */
export const cookieName = (name: string, publicUrl: string | undefined): string => (isDevOrigin(publicUrl) ? name : `__Host-${name}`);

/** RFC 6265 cookie-octets: no whitespace, quotes, commas, semicolons or backslashes. */
const COOKIE_VALUE = /^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]*$/;

/** Cookie name -> value from a Cookie header; the first of duplicate names wins. Values aren't decoded. */
export function parseCookies(header: string | null): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of (header ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at < 0) continue;
    const name = part.slice(0, at).trim();
    if (name && !cookies.has(name)) cookies.set(name, part.slice(at + 1).trim());
  }
  return cookies;
}

/** The value of cookie `name` (prefixed per `cookieName`), or null. */
export function readCookie(request: Request, name: string, publicUrl: string | undefined): string | null {
  return parseCookies(request.headers.get("Cookie")).get(cookieName(name, publicUrl)) ?? null;
}

/**
 * A Set-Cookie value: HttpOnly, SameSite=Lax, Path=/, and Secure except on an http:// dev origin.
 * `value` must already be cookie-safe (e.g. base64url); anything else throws.
 */
export function setCookie(name: string, value: string, publicUrl: string | undefined, opts: { maxAge: number }): string {
  if (!COOKIE_VALUE.test(value)) throw new Error(`Cookie ${name}: value isn't cookie-safe (encode it as base64url)`);
  const attrs = [`${cookieName(name, publicUrl)}=${value}`, "Path=/", `Max-Age=${Math.max(0, Math.floor(opts.maxAge))}`, "HttpOnly", "SameSite=Lax"];
  if (!isDevOrigin(publicUrl)) attrs.push("Secure");
  return attrs.join("; ");
}

/** A Set-Cookie value that deletes cookie `name`. */
export const clearCookie = (name: string, publicUrl: string | undefined): string => setCookie(name, "", publicUrl, { maxAge: 0 });
