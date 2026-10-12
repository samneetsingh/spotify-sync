// The owner dashboard: GET / (landing or home), GET/POST /settings, GET /activity (with the
// `advanced` setting on) and the POST /actions/*. Auth, import and 404s are handled
// elsewhere (src/index.ts routes in order: Origin check, auth, session, import, dashboard).
//
// renderPage (src/dashboard/layout.tsx) is shared with the auth and import pages. Escaping
// rule: arguments named `...Html`/`body` are trusted HTML, everything else is text and gets escaped.
// Classes only: the CSP blocks `style=` attributes.

import type { Session } from "../auth";
import type { Env } from "../env";
import { parseWriteMode } from "../env";
import { authRequired, redirect303, statusPage } from "../http";
import { importSection } from "../import";
import { emailConfig } from "../runtime";
import { loadSettings, saveSettings } from "../settings";
import { activityBody, loadActivity } from "./activity";
import { fillArt } from "./art";
import { loadHome } from "./home-data";
import { HomeView } from "./home-view";
import { PREVIEW_COOLDOWN_MS, recreatePlaylist, sendPreview, syncNow } from "./actions";
import { renderLanding } from "./landing";
import { renderPage, type Notice, type PageOptions } from "./layout";
import { render } from "./render";
import { settingsBody, type SettingsView } from "./settings";
import { loadStatus } from "./status";

export { ago, localTime, renderPage, type ButtonVariant, type NavKey, type Notice, type PageOptions, type Tone } from "./layout";

/** Whether the import bindings exist (Settings hides the History import card without them). */
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

/**
 * The owner's Home: one D1 batch (loadHome), then art for anything the cache lacks (at most two
 * Spotify calls, capped at 2.5 s; a warm view makes none).
 */
async function homePage(env: Env, ctx: ExecutionContext, session: Session, notice: Notice | undefined): Promise<Response> {
  const settings = await loadSettings(env.DB, env);
  const data = await fillArt(env, ctx, await loadHome(env.DB, { now: Date.now(), timeZone: settings.values.timeZone }));
  const body = render(HomeView({ data, writeMode: parseWriteMode(env.WRITE_MODE) }));
  return renderPage({ title: "Home", session, nav: "home", layout: "wide", hideTitle: true, body, notice, showActivity: settings.values.advanced });
}

/** The History import section for Settings: "" without the import bindings or when it can't be read. */
async function importSectionHtml(env: Env, timeZone: string): Promise<string> {
  if (!importEnabled(env)) return "";
  try {
    return await importSection(env.DB, timeZone);
  } catch (err) {
    // The rest of the page still works without the import section.
    console.error(JSON.stringify({ dashboard: "import section failed", error: err instanceof Error ? err.message : String(err) }));
    return "";
  }
}

/**
 * The settings page: the settings, the live state (loadStatus) and the import card. `extra` is the
 * refused save's posted form and errors, or the first visit's welcome.
 */
async function renderSettings(env: Env, session: Session, extra: Pick<SettingsView, "submitted" | "errors" | "welcome">, page: Pick<PageOptions, "notice" | "status">): Promise<Response> {
  const [settings, status] = await Promise.all([loadSettings(env.DB, env), loadStatus(env.DB)]);
  const importHtml = await importSectionHtml(env, settings.values.timeZone);
  const email = emailConfig(env, settings.values);
  const body = settingsBody({
    session,
    settings,
    env,
    status,
    writeMode: parseWriteMode(env.WRITE_MODE),
    email: { configured: !!(email.binding && email.from && email.to), to: email.to ?? null },
    importHtml,
    ...extra,
  });
  return renderPage({ title: "Settings", session, nav: "settings", layout: "wide", body, showActivity: settings.values.advanced, scripts: ["/settings-form.js"], ...page });
}

/** POST /settings: saves through saveSettings; a refused save shows the form again with the errors. */
async function saveSettingsForm(request: Request, env: Env, session: Session): Promise<Response> {
  const form = await request.formData();
  const result = await saveSettings(env.DB, env, form);
  if (result.ok) return redirect303(`/settings?ok=${form.has("reset") ? "reset" : result.changed.length ? "saved" : "unchanged"}`);
  return renderSettings(env, session, { submitted: form, errors: result.errors }, { status: 400 });
}

/** GET /activity, a page of the `advanced` setting: without it, back to the setting. */
async function activityPage(env: Env, session: Session, url: URL): Promise<Response> {
  const [settings, data] = await Promise.all([loadSettings(env.DB, env), loadActivity(env.DB)]);
  if (!settings.values.advanced) return redirect303("/settings#s-advanced");
  return renderPage({ title: "Activity", session, nav: "activity", layout: "wide", body: activityBody(data, settings.values.timeZone), notice: flashNotice(url, env), showActivity: true });
}

// ---------------------------------------------------------------------------- router

const PAGES = new Set(["/", "/settings", "/activity"]);
const POSTS = new Set(["/settings", "/actions/sync", "/actions/preview", "/actions/playlist/recreate"]);

/**
 * GET / (landing without a session, home with one), GET/POST /settings, GET /activity and POST
 * /actions/*; null for any other path. Owner pages without
 * a session: authRequired(request). The router has already checked Origin on non-GET requests.
 */
export async function handleDashboard(request: Request, env: Env, ctx: ExecutionContext, session: Session | null): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (!PAGES.has(path) && !POSTS.has(path)) return null;
  const read = request.method === "GET" || request.method === "HEAD";

  if (path === "/" && read && !session) return renderLanding(env, env.DB, flashNotice(url, env));
  if (!session) return authRequired(request);

  if (read && PAGES.has(path)) {
    if (path === "/") return homePage(env, ctx, session, flashNotice(url, env));
    if (path === "/settings") return renderSettings(env, session, { welcome: url.searchParams.get("welcome") === "1" }, { notice: flashNotice(url, env) });
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
