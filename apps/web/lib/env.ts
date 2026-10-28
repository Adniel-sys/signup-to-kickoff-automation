import { z } from "zod";

/**
 * Browser-safe environment. Every key must be NEXT_PUBLIC_* and referenced as
 * a literal `process.env.NAME` so Next.js inlines it into the client bundle.
 * Server secrets live in `lib/server/env.ts`.
 */
const publicEnvSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.url({ protocol: /^https$/ }),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  NEXT_PUBLIC_TURNSTILE_SITE_KEY: z.string().min(1),
});

export type PublicEnv = z.infer<typeof publicEnvSchema>;

export function formatEnvError(scope: string, error: z.ZodError): Error {
  return new Error(`Invalid ${scope} environment variables:\n${z.prettifyError(error)}`);
}

function parsePublicEnv(): PublicEnv {
  const result = publicEnvSchema.safeParse({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    NEXT_PUBLIC_TURNSTILE_SITE_KEY: process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY,
  });
  if (!result.success) throw formatEnvError("public", result.error);
  return result.data;
}

export const publicEnv: PublicEnv = parsePublicEnv();
