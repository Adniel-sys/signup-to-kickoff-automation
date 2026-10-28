import "server-only";
import { z } from "zod";
import { formatEnvError, publicEnv, type PublicEnv } from "@/lib/env";

/**
 * Server-only secrets for the website. SUPABASE_SERVICE_ROLE_KEY and
 * ANTHROPIC_API_KEY are deliberately absent: n8n is the only writer to
 * Supabase and the only caller of Haiku.
 */
const serverEnvSchema = z.object({
  ONBOARD_WEBHOOK_SECRET: z.string().min(32, "use at least 32 characters"),
  N8N_BASE_URL: z.url({ protocol: /^https?$/ }).transform((url) => url.replace(/\/+$/, "")),
  SLACK_SIGNING_SECRET: z.string().min(1),
  TURNSTILE_SECRET_KEY: z.string().min(1),
});

export type ServerEnv = z.infer<typeof serverEnvSchema> & PublicEnv;

function parseServerEnv(): ServerEnv {
  const result = serverEnvSchema.safeParse(process.env);
  if (!result.success) throw formatEnvError("server", result.error);
  return { ...result.data, ...publicEnv };
}

export const serverEnv: ServerEnv = parseServerEnv();
