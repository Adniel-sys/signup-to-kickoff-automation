import "server-only";
import { z } from "zod";
import { serverEnv } from "@/lib/server/env";

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const SITEVERIFY_TIMEOUT_MS = 5_000;

const siteverifyResponseSchema = z.object({
  success: z.boolean(),
  "error-codes": z.array(z.string()).default([]),
});

export type TurnstileResult =
  | { ok: true }
  | { ok: false; reason: "rejected"; errorCodes: string[] }
  | { ok: false; reason: "unavailable" };

/** Verifies a Turnstile token with Cloudflare. Tokens are single-use. */
export async function verifyTurnstile(
  token: string,
  remoteIp: string | null,
): Promise<TurnstileResult> {
  const body = new URLSearchParams({ secret: serverEnv.TURNSTILE_SECRET_KEY, response: token });
  if (remoteIp) body.set("remoteip", remoteIp);

  let json: unknown;
  try {
    const res = await fetch(SITEVERIFY_URL, {
      method: "POST",
      body,
      signal: AbortSignal.timeout(SITEVERIFY_TIMEOUT_MS),
    });
    json = await res.json();
  } catch (error) {
    console.error("[turnstile] siteverify unreachable", error);
    return { ok: false, reason: "unavailable" };
  }

  const parsed = siteverifyResponseSchema.safeParse(json);
  if (!parsed.success) {
    console.error("[turnstile] unexpected siteverify response");
    return { ok: false, reason: "unavailable" };
  }
  if (!parsed.data.success) {
    return { ok: false, reason: "rejected", errorCodes: parsed.data["error-codes"] };
  }
  return { ok: true };
}
