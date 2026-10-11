import { env } from "cloudflare:workers";
import { expect, it } from "vitest";

// vitest.config.ts blanks OPENAI_API_KEY: a real key in .dev.vars must never make tests call the API.
it("tests never see a real OpenAI key", () => {
  expect((env as unknown as { OPENAI_API_KEY?: string }).OPENAI_API_KEY ?? "").toBe("");
});
