import { z } from "zod";
import { intakeSchema, toIntakePayload } from "@/lib/schemas/intake";
import type { OnboardError, OnboardErrorCode, OnboardSuccess } from "@/lib/schemas/onboard-response";
import { forwardToN8n } from "@/lib/server/n8n";
import { verifyTurnstile } from "@/lib/server/turnstile";

const MESSAGES: Record<OnboardErrorCode, string> = {
  invalid_json: "The request could not be read. Please reload the page and try again.",
  validation_failed: "Please fix the highlighted fields.",
  turnstile_failed: "Verification failed. Please complete the check again.",
  upstream_error: "Something went wrong on our side. Please try again shortly.",
  unavailable: "Onboarding is temporarily unavailable. Please try again in a few minutes.",
};

/**
 * POST /api/onboard: verify Turnstile → validate → forward to n8n WF-01.
 * Contract: docs/api-contract.md.
 */
export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return error(400, "invalid_json");
  }

  const token = readTurnstileToken(body);
  if (!token) {
    return error(400, "validation_failed", {
      turnstile_token: ["Complete the verification check"],
    });
  }

  const turnstile = await verifyTurnstile(token, clientIp(request));
  if (!turnstile.ok) {
    if (turnstile.reason === "unavailable") return error(503, "unavailable");
    console.warn("[onboard] turnstile rejected", turnstile.errorCodes);
    return error(403, "turnstile_failed");
  }

  const parsed = intakeSchema.safeParse(body);
  if (!parsed.success) {
    return error(400, "validation_failed", z.flattenError(parsed.error).fieldErrors);
  }

  const result = await forwardToN8n(toIntakePayload(parsed.data));
  switch (result.kind) {
    case "accepted":
      return success(202, { ok: true, run_id: result.runId, duplicate: false });
    case "duplicate":
      return success(200, { ok: true, run_id: result.runId, duplicate: true });
    case "upstream_error":
      console.error("[onboard] n8n error", result.detail);
      return error(502, "upstream_error");
    case "unavailable":
      console.error("[onboard] n8n unavailable", result.detail);
      return error(503, "unavailable");
  }
}

function readTurnstileToken(body: unknown): string | null {
  if (typeof body !== "object" || body === null || !("turnstile_token" in body)) return null;
  const token = body.turnstile_token;
  return typeof token === "string" && token.length > 0 && token.length <= 2048 ? token : null;
}

function clientIp(request: Request): string | null {
  return (
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    null
  );
}

function success(status: 200 | 202, body: OnboardSuccess): Response {
  return Response.json(body, { status });
}

function error(
  status: number,
  code: OnboardErrorCode,
  fieldErrors?: Record<string, string[] | undefined>,
): Response {
  const body: OnboardError = { ok: false, error: code, message: MESSAGES[code] };
  if (fieldErrors) body.field_errors = compact(fieldErrors);
  return Response.json(body, { status });
}

function compact(fieldErrors: Record<string, string[] | undefined>): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(fieldErrors).filter((entry): entry is [string, string[]] => entry[1] !== undefined),
  );
}
