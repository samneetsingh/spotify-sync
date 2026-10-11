import { env } from "cloudflare:workers";
import { expect, it } from "vitest";

// vitest.config.ts blanks these: real credentials in .dev.vars must never let a test call OpenAI
// or authenticate against Spotify. Tests that need them pass their own fakes and inject fetch.
it.each(["OPENAI_API_KEY", "SPOTIFY_CLIENT_ID", "SPOTIFY_CLIENT_SECRET"])("tests never see a real %s", (name) => {
  expect((env as unknown as Record<string, string | undefined>)[name] ?? "").toBe("");
});
