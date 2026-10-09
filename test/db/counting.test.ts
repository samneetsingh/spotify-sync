import { env } from "cloudflare:workers";
import { beforeAll, expect, it } from "vitest";
import { countingD1 } from "../../src/db/counting";
import { migrate } from "../../src/db/schema";

beforeAll(() => migrate(env.DB));

it("counts single statements and each statement in a batch", async () => {
  const { db, queries } = countingD1(env.DB);
  await db.prepare("DELETE FROM state WHERE key LIKE 'count:%'").run();
  await db.batch([
    db.prepare("INSERT INTO state(key, value) VALUES(?1, ?2)").bind("count:a", "1"),
    db.prepare("INSERT INTO state(key, value) VALUES(?1, ?2)").bind("count:b", "2"),
  ]);
  const row = await db.prepare("SELECT COUNT(*) AS n FROM state WHERE key LIKE ?1").bind("count:%").first<{ n: number }>();
  expect(row?.n).toBe(2);
  expect(queries()).toBe(4);
});
