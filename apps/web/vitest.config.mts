import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
    alias: {
      // `server-only` throws outside a React Server bundle; it is a no-op under test.
      "server-only": fileURLToPath(new URL("./tests/stubs/server-only.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Dummy values so lib/env.ts and lib/server/env.ts validate at import time.
    env: {
      ONBOARD_WEBHOOK_SECRET: "test-secret-0123456789abcdef0123456789abcdef",
      N8N_BASE_URL: "https://n8n.test",
      SLACK_SIGNING_SECRET: "test-slack-signing-secret",
      TURNSTILE_SECRET_KEY: "test-turnstile-secret",
      NEXT_PUBLIC_SUPABASE_URL: "https://test-project.supabase.co",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
      NEXT_PUBLIC_TURNSTILE_SITE_KEY: "test-site-key",
    },
  },
});
