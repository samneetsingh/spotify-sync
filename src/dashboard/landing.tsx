// The logged-out home page. Three states: the instance has an owner ("Log in with Spotify"), it is
// waiting for the owner to use the emailed setup link ("Almost ready", with a resend button), or the
// deploy is missing what the setup link needs ("Still being set up"). Shows no owner details. The
// resend form posts to /claim/resend (src/auth).

import { getOwner } from "../auth";
import { canSendClaim } from "../auth/claim";
import type { Env } from "../env";
import { LinkButton } from "./components/primitives";
import { renderPage, type Notice } from "./layout";
import { render } from "./render";

/** The record from the digest emails with an apricot label, on a soft glow: decorative. */
const Disc = () => (
  <div class="disc" aria-hidden="true">
    <span class="disc-label"></span>
    <img src="/email/vinyl.png?v=1" alt="" width="216" height="216" />
  </div>
);

export type LandingState = "owned" | "unclaimed" | "unconfigured";

const TITLE: Record<LandingState, string> = {
  owned: "Your music, kept in sync",
  unclaimed: "Almost ready",
  unconfigured: "Still being set up",
};

function LandingBody({ state }: { state: LandingState }) {
  if (state === "owned") {
    return (
      <>
        <Disc />
        <p class="lead">Playlists, Liked Songs and listening digests, built from what you play on Spotify.</p>
        <LinkButton href="/login" label="Log in with Spotify" variant="primary" />
        <p class="note">Only the owner's Spotify account can log in.</p>
      </>
    );
  }
  if (state === "unclaimed") {
    return (
      <>
        <Disc />
        <p class="lead">We emailed a setup link to the owner. Open it to connect Spotify and finish setting up.</p>
        <form method="post" action="/claim/resend">
          <button type="submit" class="btn btn-secondary">
            Resend the setup link
          </button>
        </form>
        <p class="note">The email can take up to 10 minutes to arrive. Check the spam folder too. The link works once, for 7 days.</p>
      </>
    );
  }
  return (
    <>
      <Disc />
      <p class="lead">The developer still needs to finish setup. Check back soon.</p>
    </>
  );
}

/** The page's title (its <h1>) and body HTML for `state`. */
export function landingBody(state: LandingState): { title: string; body: string } {
  return { title: TITLE[state], body: render(<LandingBody state={state} />) };
}

/** The landing page for `env`; `notice` is a flash message (e.g. after logging out). */
export async function renderLanding(env: Env, db: D1Database, notice?: Notice): Promise<Response> {
  const owner = await getOwner(db, env);
  const state: LandingState = owner ? "owned" : canSendClaim(env) ? "unclaimed" : "unconfigured";
  const { title, body } = landingBody(state);
  return renderPage({ title, session: null, body, notice, layout: "narrow" });
}
