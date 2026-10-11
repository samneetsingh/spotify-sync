import { describe, expect, it } from "vitest";
import { renderDigest, type DigestData } from "../../src/jobs/digest";
import { monthData, weekData } from "./fixtures";

const sha256 = async (s: string) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");

// Hashes of the renderer's output before the AI editor (commit a931a19). The default email must stay
// byte-identical: without a plan, theme tokens and the section registry are a pure refactor.
const SNAPSHOT: Record<string, { data: () => DigestData; subject: string; html: string; text: string }> = {
  month: {
    data: monthData,
    subject: "Your September 2026 in music: 1,564 plays",
    html: "b85e33b5358965cfed36f1a8dcb4f52114183f401c1156c1ec0358ab1386099f",
    text: "72c4ba98f3b2e987c9aa6145895da1c6627b3f8fa2dea8e2f25a3ebe5848fd34",
  },
  week: {
    data: weekData,
    subject: "Your week in music, Sep 28 to Oct 4: 212 plays",
    html: "db45bc39634aba997d6c6e4a08eadd873f187fd1c1be028f0ace0004a825aad6",
    text: "b1562b9c6c50766c07f6f4340f39e8a543cf7a58ecc5902ee2cedb2a5ebdc0b4",
  },
};

describe("default output is unchanged", () => {
  for (const [name, want] of Object.entries(SNAPSHOT)) {
    it(`${name}`, async () => {
      const email = renderDigest(want.data());
      expect(email.subject).toBe(want.subject);
      expect(await sha256(email.html!)).toBe(want.html);
      expect(await sha256(email.text)).toBe(want.text);
    });
  }
});
