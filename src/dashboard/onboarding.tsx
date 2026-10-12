// The onboarding is a guided tour of the real dashboard (public/tour.js): on Home while the owner
// hasn't finished or skipped it (state ONBOARDING_KEY; the claim and every login land on Home until
// then), and on demand with ?tour=0 ("Take the tour again" in Settings). The pages carry #tour-data
// for the script (whether to start, and the owner's name); finishing or skipping posts
// /welcome/done. GET /welcome replays it. The router checks the session (and Origin on the POST).

import type { Session } from "../auth";
import { ONBOARDING_KEY } from "../auth/owner";
import { getState, setState } from "../db/state";
import type { Env } from "../env";
import { redirect303 } from "../http";

/** The tour script, for renderPage's `scripts`. */
export const TOUR_SCRIPT = "/tour.js";

/** Whether the owner has finished or skipped the tour. */
export const onboarded = async (db: D1Database): Promise<boolean> => (await getState(db, ONBOARDING_KEY)) !== null;

/** What the tour script reads: start on its own (`auto`, Home only) and the owner's name for the welcome. Hidden. */
export function TourData({ auto, session }: { auto: boolean; session: Session }) {
  return <div id="tour-data" data-auto={auto ? "1" : "0"} data-name={session.displayName ?? ""} hidden></div>;
}

/** GET /welcome: the tour from the start (old links, and a way back to it). */
export const replayTour = (): Response => redirect303("/?tour=0");

/** POST /welcome/done (then=home|import): the tour is finished (or skipped) and doesn't start on its own again. */
export async function finishWelcome(request: Request, env: Env, imports: boolean): Promise<Response> {
  const then = (await request.formData()).get("then");
  await setState(env.DB, ONBOARDING_KEY, new Date().toISOString());
  return redirect303(then === "import" && imports ? "/import" : "/");
}
