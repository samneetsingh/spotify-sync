// The Worker. Crons run the jobs (src/schedule.ts). HTTP serves the owner dashboard; static files
// in public/ are served before the Worker runs, so never add public/index.html (or any file named
// like a route): it would shadow the Worker's page.

import { getSession, handleAuthRoutes } from "./auth";
import { handleDashboard } from "./dashboard";
import type { Env } from "./env";
import { checkOrigin, notFoundPage, statusPage } from "./http";
import { handleImportRoutes } from "./import";
import { migrateOnce } from "./runtime";
import { runScheduled } from "./schedule";

export { ImportWorkflow } from "./import";

export default {
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    await runScheduled(event.cron, env, ctx);
  },

  /**
   * Routes, in order: the CSRF check for anything but GET/HEAD; auth (login, claim, OAuth callback,
   * logout); the session lookup; import; dashboard; 404. Handlers return null for paths they don't own.
   */
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method !== "GET" && request.method !== "HEAD" && !checkOrigin(request, env.PUBLIC_URL)) {
      return statusPage(403, "Request blocked", "That request didn't come from this dashboard. Open the dashboard and try again.");
    }
    try {
      await migrateOnce(env.DB);
      const auth = await handleAuthRoutes(request, env, ctx);
      if (auth) return auth;
      const session = await getSession(request, env);
      return (
        (await handleImportRoutes(request, env, ctx, session)) ??
        (await handleDashboard(request, env, ctx, session)) ??
        notFoundPage()
      );
    } catch (err) {
      const route = `${request.method} ${new URL(request.url).pathname}`;
      console.error(JSON.stringify({ route, error: err instanceof Error ? err.message : String(err) }));
      return statusPage(500, "Something went wrong", "That didn't work. Try again in a minute.");
    }
  },
};
