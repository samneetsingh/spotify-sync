// Extended streaming history import: upload to R2, stage and reconcile in a Workflow
// (tasks/dashboard-plan.md section 6).
// CONTRACT STUB from WP-0: WP-D owns src/import/* and implements these exports with these exact
// signatures. Until then they throw "not implemented" only for what they own.

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { Session } from "../auth";
import type { Env, ImportParams } from "../env";

export type { ImportParams };

const notImplemented = (what: string) => new Error(`not implemented: ${what} (WP-D)`);

/**
 * GET /import and everything under /import/ (create, upload parts, start, approve, cancel, retry);
 * null for any other path. Owner only; the router has already checked Origin on non-GET requests.
 */
export async function handleImportRoutes(request: Request, env: Env, ctx: ExecutionContext, session: Session | null): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  if (pathname !== "/import" && !pathname.startsWith("/import/")) return null;
  throw notImplemented(`${request.method} ${pathname}`);
}

/** The home page's Import card (HTML, built with the dashboard's ui helpers). Only shown when IMPORTS and IMPORT_WORKFLOW are bound. */
export async function importCard(db: D1Database): Promise<string> {
  throw notImplemented("importCard");
}

/** Index, stage, preview, wait for approval, apply month by month, enrich, backfill, finish. */
export class ImportWorkflow extends WorkflowEntrypoint<Env, ImportParams> {
  async run(event: Readonly<WorkflowEvent<ImportParams>>, step: WorkflowStep): Promise<unknown> {
    throw notImplemented("ImportWorkflow");
  }
}
