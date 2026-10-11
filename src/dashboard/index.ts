// The owner dashboard (tasks/dashboard-plan.md section 5): GET / (landing or home), GET/POST
// /settings, GET /activity and the POST /actions/*. Auth, import and 404s are handled elsewhere
// (src/index.ts routes in order: Origin check, auth, session, import, dashboard).
//
// renderPage and `ui` (src/dashboard/layout.ts) are shared with the auth and import pages. Escaping
// rule: arguments named `...Html`/`body` are trusted HTML, everything else is text and gets escaped.
// Classes only: the CSP blocks `style=` attributes.

import type { Session } from "../auth";
import type { Env } from "../env";
import { parseWriteMode } from "../env";
import { authRequired, redirect303, statusPage } from "../http";
import { importCard } from "../import";
import { emailConfig } from "../runtime";
import { loadSettings, saveSettings } from "../settings";
import { activityBody, loadActivity } from "./activity";
import { PREVIEW_COOLDOWN_MS, recreatePlaylist, sendPreview, syncNow } from "./actions";
import { homeBody } from "./home";
import { renderLanding } from "./landing";
import { renderPage, type Notice } from "./layout";
import { settingsBody } from "./settings-page";
import { loadStatus } from "./status";

export { ago, localTime, renderPage, ui, whenHtml, type ButtonVariant, type NavKey, type Notice, type PageOptions, type Tone } from "./layout";

/** Whether the import bindings exist (the Import nav item and card are hidden without them). */
export const importEnabled = (env: Env): boolean => !!(env.IMPORTS && env.IMPORT_WORKFLOW);

// ---------------------------------------------------------------------------- flash messages

/**
 * Fixed flash codes for `?ok=<code>` / `?error=<code>` after a redirect, so no user content ever
 * goes into a URL. Unknown codes are ignored. Other modules may redirect here with these codes.
 */
export const FLASH: { ok: Record<string, (env: Env) => string>; error: Record<string, (env: Env) => string> } = {
  ok: {
    synced: () => "Sync finished.",
    "preview-sent": (env) => `Preview sent to ${env.ALERT_EMAIL_TO ?? "your inbox"}. It can take a minute to arrive.`,
    "preview-logged": () => "Dry run: the preview was written to the Worker log instead of being sent.",
    saved: () => "Settings saved. They apply from the next run.",
    unchanged: () => "Nothing changed.",
    reset: () => "Setting reset.",
    recreate: () => "The playlist will be recreated at its next run.",
    "logged-out": () => "You're logged out.",
  },
  error: {
    "sync-busy": () => "A sync is already running. Try again in a minute or two.",
    "sync-failed": () => "The sync failed. The error is under Problems.",
    "email-off": () => "Email isn't set up for this dashboard, so previews can't be sent.",
    "preview-cooldown": () => `You asked for that preview a few minutes ago. You can ask again ${PREVIEW_COOLDOWN_MS / 60_000} minutes after the last one.`,
    "preview-empty-week": () => "There are no plays from last week to preview yet.",
    "preview-empty-month": () => "There are no plays from last month to preview yet.",
    "preview-failed": () => "The preview couldn't be sent. Check Activity for the error.",
  },
};

export function flashNotice(url: URL, env: Env): Notice | undefined {
  const ok = url.searchParams.get("ok");
  const error = url.searchParams.get("error");
  if (error && Object.hasOwn(FLASH.error, error)) return { kind: "error", text: FLASH.error[error]!(env) };
  if (ok && Object.hasOwn(FLASH.ok, ok)) return { kind: "ok", text: FLASH.ok[ok]!(env) };
  return undefined;
}

// ---------------------------------------------------------------------------- pages

async function homePage(env: Env, session: Session, notice: Notice | undefined): Promise<Response> {
  const db = env.DB;
  const [settings, status] = await Promise.all([loadSettings(db, env), loadStatus(db)]);
  const email = emailConfig(env, settings.values);
  let importHtml = "";
  if (importEnabled(env)) {
    try {
      importHtml = await importCard(db, settings.values.timeZone);
    } catch (err) {
      // The rest of the home page still works without the import card.
      console.error(JSON.stringify({ dashboard: "import card failed", error: err instanceof Error ? err.message : String(err) }));
    }
  }
  const body = homeBody({
    session,
    status,
    values: settings.values,
    writeMode: parseWriteMode(env.WRITE_MODE),
    email: { configured: !!(email.binding && email.from && email.to), to: email.to ?? null },
    aiAvailable: !!env.OPENAI_API_KEY,
    importHtml,
  });
  return renderPage({ title: "Dashboard", session, nav: "home", body, notice, importEnabled: importEnabled(env) });
}

async function settingsPage(env: Env, session: Session, url: URL): Promise<Response> {
  const settings = await loadSettings(env.DB, env);
  const body = settingsBody({ session, settings, env, welcome: url.searchParams.get("welcome") === "1" });
  return renderPage({ title: "Settings", session, nav: "settings", body, notice: flashNotice(url, env), importEnabled: importEnabled(env) });
}

/** POST /settings: saves through saveSettings; a refused save shows the form again with the errors. */
async function saveSettingsForm(request: Request, env: Env, session: Session): Promise<Response> {
  const form = await request.formData();
  const result = await saveSettings(env.DB, env, form);
  if (result.ok) return redirect303(`/settings?ok=${form.has("reset") ? "reset" : result.changed.length ? "saved" : "unchanged"}`);
  const settings = await loadSettings(env.DB, env);
  const body = settingsBody({ session, settings, env, submitted: form, errors: result.errors });
  return renderPage({ title: "Settings", session, nav: "settings", body, status: 400, importEnabled: importEnabled(env) });
}

async function activityPage(env: Env, session: Session, url: URL): Promise<Response> {
  const [settings, data] = await Promise.all([loadSettings(env.DB, env), loadActivity(env.DB)]);
  return renderPage({ title: "Activity", session, nav: "activity", body: activityBody(data, settings.values.timeZone), notice: flashNotice(url, env), importEnabled: importEnabled(env) });
}

// ---------------------------------------------------------------------------- router

const PAGES = new Set(["/", "/settings", "/activity"]);
const POSTS = new Set(["/settings", "/actions/sync", "/actions/preview", "/actions/playlist/recreate"]);

/**
 * GET / (landing without a session, home with one), GET/POST /settings, GET /activity and
 * POST /actions/*; null for any other path. Owner pages without a session: authRequired(request).
 * The router has already checked Origin on non-GET requests.
 */
export async function handleDashboard(request: Request, env: Env, ctx: ExecutionContext, session: Session | null): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (!PAGES.has(path) && !POSTS.has(path)) return null;
  const read = request.method === "GET" || request.method === "HEAD";

  if (path === "/" && read && !session) return renderLanding(env, env.DB, flashNotice(url, env));
  if (!session) return authRequired(request);

  if (read && PAGES.has(path)) {
    if (path === "/") return homePage(env, session, flashNotice(url, env));
    if (path === "/settings") return settingsPage(env, session, url);
    return activityPage(env, session, url);
  }
  if (request.method === "POST" && POSTS.has(path)) {
    if (path === "/settings") return saveSettingsForm(request, env, session);
    if (path === "/actions/sync") return syncNow(env);
    const form = await request.formData();
    if (path === "/actions/preview") return sendPreview(form, env, await loadSettings(env.DB, env));
    return recreatePlaylist(form, env);
  }
  const res = statusPage(405, "Not allowed", "That page doesn't accept this kind of request.");
  res.headers.set("Allow", PAGES.has(path) && POSTS.has(path) ? "GET, HEAD, POST" : PAGES.has(path) ? "GET, HEAD" : "POST");
  return res;
}

/** The logged-out home page: "Log in with Spotify", "Almost ready" (unclaimed) or "still being set up". */
export async function landingPage(env: Env, db: D1Database, notice?: Notice): Promise<Response> {
  return renderLanding(env, db, notice);
}
