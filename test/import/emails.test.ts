// The import's emails and the home page's Import card.
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, expect, it } from "vitest";
import { migrate } from "../../src/db/schema";
import { doneEmail, failedEmail, reviewEmail } from "../../src/import/emails";
import { importSection } from "../../src/import";
import type { Preview } from "../../src/import/store";
import { resetDb } from "../parity/spotify-fixture";
import { insertImport } from "./helpers";

const PREVIEW: Preview = {
  from: Date.UTC(2016, 2, 5),
  to: Date.UTC(2026, 8, 30),
  records: 322_000,
  skipped: 2_000,
  short: 40_000,
  plays: 280_000,
  months: {},
  totals: [270_000, 1_200, 3_400],
  warnings: {},
};

beforeAll(() => migrate(env.DB));
beforeEach(() => resetDb(env.DB));

it("asks for a review with a link to the Import page", () => {
  const e = reviewEmail(PREVIEW, "https://spotify.example.com/");
  expect(e.subject).toBe("[spotify-sync] Your listening history is ready to review");
  expect(e.text).toContain("We read 280,000 plays from Mar 2016 to Sep 2026");
  expect(e.text).toContain("Review the import: https://spotify.example.com/import");
  expect(e.text).toContain("Plays to remove: 3,400");
  expect(e.html).toContain("Ready to review");
  const warned = reviewEmail({ ...PREVIEW, warnings: { historyLoss: { deletes: 500, imported: 900 } } }, undefined);
  expect(warned.text).toContain("something in this export looks off");
  expect(warned.text).not.toContain("http"); // no PUBLIC_URL: no link
});

it("reports what was imported, including the library backfill", () => {
  const e = doneEmail({ from: PREVIEW.from, to: PREVIEW.to, added: 270_000, updated: 1_200, removed: 3_400, newTracks: 25_000, newArtists: 6_000, liked: null, frequent: 120, librarySkipped: null }, "https://spotify.example.com");
  expect(e.subject).toBe("[spotify-sync] Your listening history is imported");
  expect(e.text).toContain("Years: Mar 2016 to Sep 2026");
  expect(e.text).toContain("Frequent Plays: 120 added");
  expect(e.text).not.toContain("Liked Songs");
  const skipped = doneEmail({ from: 0, to: 1, added: 0, updated: 0, removed: 0, newTracks: 0, newArtists: 0, liked: 0, frequent: null, librarySkipped: "Liked Songs is off in Settings" }, undefined);
  expect(skipped.text).toContain("Library backfill skipped: Liked Songs is off in Settings.");
});

it("escapes the error in the failure email", () => {
  const e = failedEmail("<b>boom</b>", "https://spotify.example.com");
  expect(e.html).toContain("&lt;b&gt;boom&lt;/b&gt;");
  expect(e.text).toContain("Error: <b>boom</b>");
});

it("summarizes the latest import on the home page", async () => {
  expect(await importSection(env.DB)).toContain("Import history");
  const id = await insertImport(env.DB, { status: "review", preview: PREVIEW });
  expect(await importSection(env.DB)).toContain("Ready to review");
  await env.DB.prepare("UPDATE imports SET status = 'applying', progress = 'Imported 2019-03 (month 37 of 127)' WHERE id = ?1").bind(id).run();
  expect(await importSection(env.DB)).toContain("Imported 2019-03 (month 37 of 127)");
  await env.DB.prepare("UPDATE imports SET status = 'done' WHERE id = ?1").bind(id).run();
  expect(await importSection(env.DB)).toContain("Imported Mar 2016 to Sep 2026");
});
