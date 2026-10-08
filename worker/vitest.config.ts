import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";

export default defineConfig({
  plugins: [
    cloudflareTest({
      // Tests reset tables; never let them reach a remote D1.
      remoteBindings: false,
      wrangler: { configPath: "./wrangler.toml" },
    }),
  ],
});
