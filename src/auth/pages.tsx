// The logged-out problem pages of the auth routes (src/auth/index.ts): expired or mismatched logins,
// setup links that don't work, the resend result and the wrong Spotify account. Presentation only:
// the routes decide which page, its status and its headers. JSX escapes every value (a Spotify
// display name included).

import type { Child } from "hono/jsx";
import { LinkButton, PostButton } from "../dashboard/components/primitives";
import { renderPage } from "../dashboard/layout";
import { render } from "../dashboard/render";

/** A logged-out page: the message in a panel, then its buttons. `headers` are appended (Set-Cookie). */
function problemPage(status: number, title: string, body: Child, headers: Record<string, string> = {}): Response {
  const res = renderPage({ title, session: null, status, layout: "narrow", body: render(<div class="problem">{body}</div>) });
  for (const [k, v] of Object.entries(headers)) res.headers.append(k, v);
  return res;
}

const Actions = ({ children }: { children?: Child }) => <div class="actions">{children}</div>;
const LogInAgain = () => (
  <Actions>
    <LinkButton href="/login" label="Log in again" variant="primary" />
  </Actions>
);
/** What to do after a failed login: claims retry from the emailed link, logins log in again. */
const Retry = ({ claim }: { claim: boolean }) => (claim ? <p>Open the setup link in the email again to retry.</p> : <LogInAgain />);

export const unconfiguredPage = (headers?: Record<string, string>) =>
  problemPage(503, "Setup isn't finished", <p>Whoever deployed spotify-sync still needs to finish setting it up. Try again later.</p>, headers);

/** A used, expired or unknown setup link; `offerResend` shows the resend form (only while it can send). */
export function claimLinkPage(status: number, offerResend: boolean, headers?: Record<string, string>): Response {
  return problemPage(
    status,
    "This setup link doesn't work anymore",
    <>
      <p>Setup links work once and expire after 7 days.</p>
      <Actions>{offerResend ? <PostButton action="/claim/resend" label="Email the owner a new link" variant="primary" /> : <LinkButton href="/" label="Go to the dashboard" />}</Actions>
    </>,
    headers,
  );
}

/** 405 with the Allow header. */
export function methodNotAllowedPage(allow: string): Response {
  const res = problemPage(405, "Not allowed", <p>That page can't be opened this way.</p>);
  res.headers.set("Allow", allow);
  return res;
}

export const resendFailedPage = () => problemPage(503, "Couldn't send the email", <p>The setup email didn't go out. Try again in a few minutes.</p>);

/** After POST /claim/resend; `sentAt` is the time of the latest send, already formatted. */
export const checkEmailPage = (sentAt: string) =>
  problemPage(
    200,
    "Check your email",
    <>
      <p>The latest setup link went to the owner's email at {sentAt}. If it isn't in the inbox, check spam.</p>
      <p>Links work once, for 7 days. You can ask for another an hour after the last one, up to 5 a day.</p>
    </>,
  );

export const loginExpiredPage = (headers: Record<string, string>) =>
  problemPage(
    400,
    "That login took too long",
    <>
      <p>Start again: logins have to finish within 10 minutes.</p>
      <LogInAgain />
    </>,
    headers,
  );

export const loginMismatchPage = (headers: Record<string, string>) =>
  problemPage(
    400,
    "That login didn't match",
    <>
      <p>This page was opened from a different login. Start again from the dashboard.</p>
      <LogInAgain />
    </>,
    headers,
  );

/** Spotify ended the login without a code: `reason` is "error" (the owner cancelled) or "no-code". */
export const loginCancelledPage = (reason: "error" | "no-code", claim: boolean, headers: Record<string, string>) =>
  problemPage(
    400,
    "Login cancelled",
    <>
      <p>{reason === "error" ? "Spotify didn't finish the login, so nothing changed." : "Spotify didn't send a login code, so nothing changed."}</p>
      <Retry claim={claim} />
    </>,
    headers,
  );

export const spotifyFailedPage = (claim: boolean, headers: Record<string, string>) =>
  problemPage(
    502,
    "Couldn't reach Spotify",
    <>
      <p>Spotify didn't accept the login. Nothing changed; try again in a minute.</p>
      <Retry claim={claim} />
    </>,
    headers,
  );

export const alreadySetUpPage = (headers: Record<string, string>) =>
  problemPage(409, "Already set up", <p>Another Spotify account finished setting up spotify-sync first. Nothing changed for your account.</p>, headers);

/** A login with an account that isn't the owner's; `switchHref` restarts the login with Spotify's account picker. */
export const wrongAccountPage = (account: string, switchHref: string, headers: Record<string, string>) =>
  problemPage(
    403,
    "That's a different Spotify account",
    <>
      <p>You logged in to Spotify as {account}. Only the owner's Spotify account can use this dashboard, so nothing changed.</p>
      <Actions>
        <LinkButton href={switchHref} label="Use a different Spotify account" variant="primary" />
      </Actions>
    </>,
    headers,
  );
