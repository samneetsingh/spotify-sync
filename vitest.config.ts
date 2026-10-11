import { configDefaults, defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";

export default defineConfig({
  plugins: [
    cloudflareTest({
      // Tests reset tables; never let them reach a remote D1.
      remoteBindings: false,
      wrangler: { configPath: "./wrangler.toml" },
    }),
  ],
  // Git worktrees for parallel work live under .claude/worktrees; their tests run in their own checkout.
  test: { exclude: [...configDefaults.exclude, ".claude/**"] },
});
