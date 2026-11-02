import { z } from "zod";

/** POST /api/approve: request and response shapes. See docs/api-contract.md. */

export const DECISIONS = ["approve", "reject"] as const;
export type Decision = (typeof DECISIONS)[number];

export const NOTE_MIN_FOR_REJECT = 3;
export const NOTE_MAX = 500;

export const approveRequestSchema = z
  .object({
    run_id: z.uuid("Unknown run"),
    decision: z.enum(DECISIONS, "Choose approve or reject"),
    note: z
      .string()
      .trim()
      .max(NOTE_MAX, `Keep the note under ${NOTE_MAX} characters`)
      .optional()
      .transform((note) => note || undefined),
  })
  .refine((body) => body.decision !== "reject" || (body.note?.length ?? 0) >= NOTE_MIN_FOR_REJECT, {
    path: ["note"],
    message: "Add a short note explaining the rejection",
  });

export type ApproveRequest = z.output<typeof approveRequestSchema>;

export const APPROVE_ERROR_CODES = [
  "unauthorized",
  "forbidden",
  "invalid_json",
  "validation_failed",
  "not_found",
  "not_waiting",
  "invalid_decision",
  "upstream_error",
  "unavailable",
] as const;

export const approveSuccessSchema = z.object({
  ok: z.literal(true),
  run_id: z.uuid(),
  decision: z.enum(DECISIONS),
  status: z.enum(["approved", "rejected"]),
});

export const approveErrorSchema = z.object({
  ok: z.literal(false),
  error: z.enum(APPROVE_ERROR_CODES),
  message: z.string(),
  field_errors: z.record(z.string(), z.array(z.string())).optional(),
});

export const approveResponseSchema = z.discriminatedUnion("ok", [approveSuccessSchema, approveErrorSchema]);

export type ApproveSuccess = z.infer<typeof approveSuccessSchema>;
export type ApproveError = z.infer<typeof approveErrorSchema>;
export type ApproveErrorCode = ApproveError["error"];
