// The auth problem pages (src/auth/pages.tsx): each keeps its status, title, text, buttons and
// headers; none has a style= attribute, an inline script or the logged-in nav; values are escaped.
import { describe, expect, it } from "vitest";
import {
  alreadySetUpPage,
  checkEmailPage,
  claimLinkPage,
  loginCancelledPage,
  loginExpiredPage,
  loginMismatchPage,
  methodNotAllowedPage,
  resendFailedPage,
  spotifyFailedPage,
  unconfiguredPage,
  wrongAccountPage,
} from "../../src/auth/pages";
import { esc } from "../../src/email/layout";

const CLEAR = { "Set-Cookie": "__Host-oauth=; Path=/; Max-Age=0" };
const LOG_IN_AGAIN = '<div class="actions"><a class="btn btn-primary" href="/login">Log in again</a></div>';
const RETRY_CLAIM = "<p>Open the setup link in the email again to retry.</p>";
const RESEND = '<div class="actions"><form class="inline" method="post" action="/claim/resend"><button type="submit" class="btn btn-primary">Email the owner a new link</button></form></div>';
const DASHBOARD = '<div class="actions"><a class="btn btn-secondary" href="/">Go to the dashboard</a></div>';
const p = (text: string) => `<p>${esc(text)}</p>`;

/** [name, page, status, title, the panel's exact HTML, headers it must carry] */
const PAGES: Array<[string, () => Response, number, string, string, Record<string, string>?]> = [
  ["unconfigured", () => unconfiguredPage(), 503, "Setup isn't finished", p("Whoever deployed spotify-sync still needs to finish setting it up. Try again later.")],
  ["unconfigured, clearing the OAuth cookie", () => unconfiguredPage(CLEAR), 503, "Setup isn't finished", p("Whoever deployed spotify-sync still needs to finish setting it up. Try again later."), CLEAR],
  ["a dead setup link, with resend", () => claimLinkPage(404, true), 404, "This setup link doesn't work anymore", p("Setup links work once and expire after 7 days.") + RESEND],
  ["a dead setup link, owned", () => claimLinkPage(404, false), 404, "This setup link doesn't work anymore", p("Setup links work once and expire after 7 days.") + DASHBOARD],
  ["a dead setup link at the callback", () => claimLinkPage(400, true, CLEAR), 400, "This setup link doesn't work anymore", p("Setup links work once and expire after 7 days.") + RESEND, CLEAR],
  ["a wrong method", () => methodNotAllowedPage("GET, HEAD"), 405, "Not allowed", p("That page can't be opened this way."), { Allow: "GET, HEAD" }],
  ["a failed resend", () => resendFailedPage(), 503, "Couldn't send the email", p("The setup email didn't go out. Try again in a few minutes.")],
  [
    "a resend",
    () => checkEmailPage("Sun, Oct 11, 5:00 AM PDT"),
    200,
    "Check your email",
    p("The latest setup link went to the owner's email at Sun, Oct 11, 5:00 AM PDT. If it isn't in the inbox, check spam.") +
      p("Links work once, for 7 days. You can ask for another an hour after the last one, up to 5 a day."),
  ],
  ["an expired login", () => loginExpiredPage(CLEAR), 400, "That login took too long", p("Start again: logins have to finish within 10 minutes.") + LOG_IN_AGAIN, CLEAR],
  ["a mismatched login", () => loginMismatchPage(CLEAR), 400, "That login didn't match", p("This page was opened from a different login. Start again from the dashboard.") + LOG_IN_AGAIN, CLEAR],
  ["a cancelled login", () => loginCancelledPage("error", false, CLEAR), 400, "Login cancelled", p("Spotify didn't finish the login, so nothing changed.") + LOG_IN_AGAIN, CLEAR],
  ["a cancelled claim", () => loginCancelledPage("error", true, CLEAR), 400, "Login cancelled", p("Spotify didn't finish the login, so nothing changed.") + RETRY_CLAIM, CLEAR],
  ["a login without a code", () => loginCancelledPage("no-code", false, CLEAR), 400, "Login cancelled", p("Spotify didn't send a login code, so nothing changed.") + LOG_IN_AGAIN, CLEAR],
  ["a claim without a code", () => loginCancelledPage("no-code", true, CLEAR), 400, "Login cancelled", p("Spotify didn't send a login code, so nothing changed.") + RETRY_CLAIM, CLEAR],
  ["Spotify refusing a login", () => spotifyFailedPage(false, CLEAR), 502, "Couldn't reach Spotify", p("Spotify didn't accept the login. Nothing changed; try again in a minute.") + LOG_IN_AGAIN, CLEAR],
  ["Spotify refusing a claim", () => spotifyFailedPage(true, CLEAR), 502, "Couldn't reach Spotify", p("Spotify didn't accept the login. Nothing changed; try again in a minute.") + RETRY_CLAIM, CLEAR],
  ["a lost claim", () => alreadySetUpPage(CLEAR), 409, "Already set up", p("Another Spotify account finished setting up spotify-sync first. Nothing changed for your account."), CLEAR],
  [
    "the wrong account",
    () => wrongAccountPage("Robin (robin-1)", "/login?switch=1&next=%2Factivity", CLEAR),
    403,
    "That's a different Spotify account",
    p("You logged in to Spotify as Robin (robin-1). Only the owner's Spotify account can use this dashboard, so nothing changed.") +
      '<div class="actions"><a class="btn btn-primary" href="/login?switch=1&amp;next=%2Factivity">Use a different Spotify account</a></div>',
    CLEAR,
  ],
];

describe("auth problem pages", () => {
  it.each(PAGES)("%s", async (_name, make, status, title, panel, headers = {}) => {
    const res = make();
    expect(res.status).toBe(status);
    for (const [k, v] of Object.entries(headers)) expect(res.headers.get(k)).toBe(v);
    const nonce = res.headers.get("Content-Security-Policy")?.match(/style-src 'nonce-([^']+)'/)?.[1];
    expect(nonce).toBeTruthy();
    const body = await res.text();
    expect(body).toContain(`<title>${esc(title)} · spotify-sync</title>`);
    expect(body).toContain(`<main id="main" class="narrow"><h1>${esc(title)}</h1><div class="problem">${panel}</div></main>`);
    for (const tag of body.match(/<style\b[^>]*>/g) ?? []) expect(tag).toBe(`<style nonce="${nonce}">`);
    expect(body).not.toMatch(/\sstyle\s*=/i);
    expect(body).not.toMatch(/<script/i);
    expect(body).not.toContain("<nav");
  });

  it("escapes the Spotify account name and the switch link", async () => {
    const body = await wrongAccountPage(`<img src=x onerror=alert(1)> "R" & 'S'`, `/login?switch=1&next="><script>`, {}).text();
    expect(body).toContain("You logged in to Spotify as &lt;img src=x onerror=alert(1)&gt; &quot;R&quot; &amp; &#39;S&#39;.");
    expect(body).toContain('href="/login?switch=1&amp;next=&quot;&gt;&lt;script&gt;"');
    expect(body).not.toContain("<img");
    expect(body).not.toMatch(/<script/i);
  });
});
