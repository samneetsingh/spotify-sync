// Owner pages refuse a missing session, a session that isn't the owner's, and a write from another
// origin, changing nothing.

import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createSession } from "../../src/auth/session";
import { handleDashboard } from "../../src/dashboard";
import { migrate } from "../../src/db/schema";
import worker from "../../src/index";
import { resetDb } from "../parity/spotify-fixture";
import { ctx, ORIGIN, post, session, testEnv } from "./helpers";

beforeAll(() => migrate(env.DB));
beforeEach(() => resetDb(env.DB));

const e = (over = {}) => testEnv({ SETTINGS: "{}", ...over });
const rows = async () =>
  Object.fromEntries((await env.DB.prepare("SELECT key, value FROM settings ORDER BY key").all<{ key: string; value: string }>()).results.map((r) => [r.key, JSON.parse(r.value)]));

describe("owner-only routes", () => {
  it("refuse a settings save without a session (401), changing nothing", async () => {
    const res = (await handleDashboard(post("/settings", { frequent: "false" }), e(), ctx, null))!;
    expect(res.status).toBe(401);
    expect(await rows()).toEqual({});
  });

  it("no longer have a toggle route", async () => {
    expect(await handleDashboard(post("/settings/toggle", { key: "frequent", value: "false" }), e(), ctx, session)).toBeNull();
  });

  it("treat a session of an account that isn't the owner as no session", async () => {
    await env.DB.prepare("INSERT INTO state(key, value) VALUES('owner:spotify_id', 'owner-1')").run();
    const environment = e({ SPOTIFY_USER_ID: "" });
    const cookie = (await createSession(env.DB, environment, "someone-else", null)).split(";")[0]!;
    const fetch = (request: Request) => worker.fetch(request, environment, ctx);

    const page = await fetch(new Request(`${ORIGIN}/settings`, { headers: { Cookie: cookie } }));
    expect(page.status).toBe(303);
    expect(page.headers.get("Location")).toBe(`/login?next=${encodeURIComponent("/settings")}`);

    const write = post("/settings", { frequent: "false" });
    write.headers.set("Cookie", cookie);
    expect((await fetch(write)).status).toBe(401);
    expect(await rows()).toEqual({});
  });

  it("refuse a settings save from another origin before the dashboard sees it", async () => {
    const cookie = (await createSession(env.DB, e({ SPOTIFY_USER_ID: "owner-1" }), "owner-1", null)).split(";")[0]!;
    const res = await worker.fetch(
      new Request(`${ORIGIN}/settings`, {
        method: "POST",
        headers: { Origin: "https://evil.test", Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
        body: "frequent=false",
      }),
      e({ SPOTIFY_USER_ID: "owner-1" }),
      ctx,
    );
    expect(res.status).toBe(403);
    expect(await rows()).toEqual({});
  });
});
