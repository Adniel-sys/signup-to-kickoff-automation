import { z } from "zod";

/** JSON returned by /api/onboard to the browser. See docs/api-contract.md. */

export const ONBOARD_ERROR_CODES = [
  "invalid_json",
  "validation_failed",
  "turnstile_failed",
  "upstream_error",
  "unavailable",
] as const;

export const onboardSuccessSchema = z.object({
  ok: z.literal(true),
  run_id: z.uuid(),
  duplicate: z.boolean(),
});

export const onboardErrorSchema = z.object({
  ok: z.literal(false),
  error: z.enum(ONBOARD_ERROR_CODES),
  message: z.string(),
  field_errors: z.record(z.string(), z.array(z.string())).optional(),
});

export const onboardResponseSchema = z.discriminatedUnion("ok", [
  onboardSuccessSchema,
  onboardErrorSchema,
]);

export type OnboardSuccess = z.infer<typeof onboardSuccessSchema>;
export type OnboardError = z.infer<typeof onboardErrorSchema>;
export type OnboardErrorCode = OnboardError["error"];
export type OnboardResponse = z.infer<typeof onboardResponseSchema>;
