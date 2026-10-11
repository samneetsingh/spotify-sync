import { readFileSync } from "node:fs";
import { configDefaults, defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
// @ts-expect-error plain JS module without type declarations
import { generate } from "./scripts/configure.mjs";

// wrangler.toml is a template ({{WORKER_NAME}} isn't a valid Worker name), so tests run against
// it filled with the example values. Bindings are local and simulated, so no real ids are needed.
const example = JSON.parse(readFileSync(new URL("./deploy.config.example.json", import.meta.url), "utf8"));
const { file } = generate(example, "wrangler.example.generated.toml", "deploy.config.example.json");

export default defineConfig({
  plugins: [
    cloudflareTest({
      // Tests reset tables; never let them reach a remote D1.
      remoteBindings: false,
      wrangler: { configPath: `./${file}` },
    }),
  ],
  // Git worktrees for parallel work live under .claude/worktrees; their tests run in their own checkout.
  test: { exclude: [...configDefaults.exclude, ".claude/**"] },
});
