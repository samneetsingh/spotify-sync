// The logged-out home page. Three states: the instance has an owner ("Log in with Spotify"), it is
// waiting for the owner to use the emailed setup link ("Almost ready", with a resend button), or the
// deploy is missing what the setup link needs ("Still being set up"). Shows no owner details.

import { getOwner } from "../auth";
import type { Env } from "../env";
import { renderPage, ui, type Notice } from "./layout";

/** The disc from the digest emails, with a green label: decorative. */
const DISC = `<div class="disc" aria-hidden="true"><span class="disc-label"></span><img src="/email/vinyl.png?v=1" alt="" width="216" height="216"></div>`;

/** What the claim email and its link need: email sending, a public URL and the Spotify app. */
export const setupComplete = (env: Env): boolean =>
  !!(env.ALERT_EMAIL && env.ALERT_FROM && env.ALERT_EMAIL_TO && env.PUBLIC_URL && env.SPOTIFY_CLIENT_ID && env.SPOTIFY_CLIENT_SECRET);

export type LandingState = "owned" | "unclaimed" | "unconfigured";

export function landingBody(state: LandingState): { title: string; body: string } {
  if (state === "owned") {
    return {
      title: "Your music, kept in sync",
      body: `${DISC}<p class="lead">Playlists, Liked Songs and listening digests, built from what you play on Spotify.</p>
${ui.linkButton("/login", "Log in with Spotify", "primary")}
<p class="note">Only the owner's Spotify account can log in.</p>`,
    };
  }
  if (state === "unclaimed") {
    return {
      title: "Almost ready",
      body: `${DISC}<p class="lead">We emailed a setup link to the owner. Open it to connect Spotify and finish setting up.</p>
<form method="post" action="/claim/resend"><button type="submit" class="btn btn-secondary">Resend the setup link</button></form>
<p class="note">The email can take up to 10 minutes to arrive. Check the spam folder too. The link works once, for 7 days.</p>`,
    };
  }
  return {
    title: "Still being set up",
    body: `${DISC}<p class="lead">The developer still needs to finish setup. Check back soon.</p>`,
  };
}

/** The landing page for `env`; `notice` is a flash message (e.g. after logging out). */
export async function renderLanding(env: Env, db: D1Database, notice?: Notice): Promise<Response> {
  const owner = await getOwner(db, env);
  const state: LandingState = owner ? "owned" : setupComplete(env) ? "unclaimed" : "unconfigured";
  const { title, body } = landingBody(state);
  return renderPage({ title, session: null, body, notice, layout: "narrow" });
}
