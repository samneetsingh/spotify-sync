import { describe, expect, it } from "vitest";
import {
  authRequired,
  checkOrigin,
  clearCookie,
  cookieName,
  cspNonce,
  html,
  notFoundPage,
  parseCookies,
  readCookie,
  redirect303,
  setCookie,
  statusPage,
} from "../src/http";

const PROD = "https://sync.test";
const DEV = "http://127.0.0.1:8788";

describe("html responses", () => {
  it("sets the security headers with the page's nonce and keeps extra headers", () => {
    const res = html("<p>hi</p>", { nonce: "abc123", status: 201, headers: { "Set-Cookie": "a=b", "Cache-Control": "public" } });
    expect(res.status).toBe(201);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("Content-Security-Policy")).toBe(
      "default-src 'none'; style-src 'nonce-abc123'; script-src 'self'; img-src 'self' https://i.scdn.co data:; connect-src 'self'; form-action 'self' https://accounts.spotify.com; frame-ancestors 'none'; base-uri 'none'",
    );
    expect(res.headers.get("Referrer-Policy")).toBe("same-origin");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Cache-Control")).toBe("no-store"); // security headers win
    expect(res.headers.get("Set-Cookie")).toBe("a=b");
  });

  it("makes a fresh nonce per call", () => {
    expect(cspNonce()).not.toBe(cspNonce());
    expect(cspNonce()).toMatch(/^[A-Za-z0-9+/]{22}==$/);
  });

  it("renders status pages with escaped text, a matching style nonce and no style attributes", async () => {
    const res = statusPage(403, "<b>Nope</b>", `"quoted" & <script>`);
    const body = await res.text();
    expect(res.status).toBe(403);
    const nonce = res.headers.get("Content-Security-Policy")!.match(/'nonce-([^']+)'/)![1];
    expect(body).toContain(`<style nonce="${nonce}">`);
    expect(body).toContain("&lt;b&gt;Nope&lt;/b&gt;");
    expect(body).toContain("&quot;quoted&quot; &amp; &lt;script&gt;");
    expect(body).not.toMatch(/\sstyle=/);
    expect(notFoundPage().status).toBe(404);
  });

  it("redirects with mutable headers", () => {
    const res = redirect303("/settings", { "Set-Cookie": "a=b" });
    res.headers.append("Set-Cookie", "c=d");
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/settings");
    expect(res.headers.get("Set-Cookie")).toBe("a=b, c=d");
  });

  it("sends anonymous GETs to the login and back, and refuses other methods", () => {
    const get = authRequired(new Request(`${PROD}/settings?welcome=1`));
    expect(get.status).toBe(303);
    expect(get.headers.get("Location")).toBe("/login?next=%2Fsettings%3Fwelcome%3D1");
    expect(authRequired(new Request(`${PROD}/settings`, { method: "POST" })).status).toBe(401);
  });
});

describe("checkOrigin", () => {
  const req = (headers: Record<string, string>) => new Request(`${PROD}/settings`, { method: "POST", headers });

  it("accepts PUBLIC_URL's origin, or Sec-Fetch-Site same-origin without an Origin header", () => {
    expect(checkOrigin(req({ Origin: PROD }), PROD)).toBe(true);
    expect(checkOrigin(req({ Origin: PROD }), `${PROD}/`)).toBe(true);
    expect(checkOrigin(req({ "Sec-Fetch-Site": "same-origin" }), PROD)).toBe(true);
    // `Origin: null` (what browsers send under Referrer-Policy: no-referrer) falls back to Sec-Fetch-Site.
    expect(checkOrigin(req({ Origin: "null", "Sec-Fetch-Site": "same-origin" }), PROD)).toBe(true);
  });

  it("rejects other origins, sibling subdomains, http, missing headers and an unset PUBLIC_URL", () => {
    expect(checkOrigin(req({ Origin: "https://evil.test" }), PROD)).toBe(false);
    expect(checkOrigin(req({ Origin: "https://a.sync.test" }), PROD)).toBe(false);
    expect(checkOrigin(req({ Origin: "http://sync.test" }), PROD)).toBe(false);
    expect(checkOrigin(req({ Origin: "null" }), PROD)).toBe(false);
    expect(checkOrigin(req({ Origin: "null", "Sec-Fetch-Site": "cross-site" }), PROD)).toBe(false);
    expect(checkOrigin(req({ Origin: "https://evil.test", "Sec-Fetch-Site": "same-origin" }), PROD)).toBe(false);
    expect(checkOrigin(req({ "Sec-Fetch-Site": "same-site" }), PROD)).toBe(false);
    expect(checkOrigin(req({}), PROD)).toBe(false);
    expect(checkOrigin(req({ Origin: PROD }), undefined)).toBe(false);
    expect(checkOrigin(req({ Origin: PROD }), "not a url")).toBe(false);
  });
});

describe("cookies", () => {
  it("uses __Host- and Secure in production, neither on an http:// dev origin", () => {
    expect(cookieName("session", PROD)).toBe("__Host-session");
    expect(setCookie("session", "tok_en-1", PROD, { maxAge: 2_592_000 })).toBe("__Host-session=tok_en-1; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax; Secure");
    expect(setCookie("session", "tok", DEV, { maxAge: 60 })).toBe("session=tok; Path=/; Max-Age=60; HttpOnly; SameSite=Lax");
    expect(clearCookie("oauth", PROD)).toBe("__Host-oauth=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure");
  });

  it("refuses values that could break the header", () => {
    for (const bad of ["a;b", "a b", 'a"b', "a,b", "a\\b", "a\nb"]) {
      expect(() => setCookie("session", bad, PROD, { maxAge: 60 })).toThrow(/cookie-safe/);
    }
  });

  it("parses Cookie headers and reads the prefixed name", () => {
    expect(parseCookies("a=1; b = 2;c=x=y; a=3; junk")).toEqual(new Map([["a", "1"], ["b", "2"], ["c", "x=y"]]));
    expect(parseCookies(null).size).toBe(0);
    const req = new Request(PROD, { headers: { Cookie: "session=plain; __Host-session=secure" } });
    expect(readCookie(req, "session", PROD)).toBe("secure");
    expect(readCookie(req, "session", DEV)).toBe("plain");
    expect(readCookie(req, "oauth", PROD)).toBeNull();
  });
});
