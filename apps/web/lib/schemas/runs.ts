import { z } from "zod";
import { BUDGET_RANGES, SERVICE_TIERS, TIMELINES } from "@/lib/schemas/intake";

/**
 * Rows the admin dashboard reads from Supabase (RLS: authenticated select). Parsed with Zod
 * because jsonb columns and embedded selects are untyped at runtime.
 */

export const RUN_STATUSES = [
  "received",
  "enriching",
  "awaiting_approval",
  "approved",
  "rejected",
  "provisioning",
  "completed",
  "failed",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const STEP_STATUSES = ["started", "succeeded", "failed", "skipped"] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

export const RISK_LEVELS = ["low", "medium", "high"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

/** clients.intake_ai, as written by WF-01's Save Enrichment (Phase 3). */
export const intakeAiSchema = z.object({
  summary: z.string(),
  goals: z.array(z.string()),
  risk_flags: z.array(z.string()),
  risk_level: z.enum(RISK_LEVELS),
  risk_reason: z.string(),
  welcome_email: z.object({ subject: z.string(), body: z.string() }),
  kickoff_agenda: z.array(z.string()),
  ai_risk_level: z.enum(RISK_LEVELS).optional(),
  rule_overrides: z.array(z.string()).optional(),
});
export type IntakeAi = z.infer<typeof intakeAiSchema>;

/** The parts of clients.intake_raw the dashboard shows. Lenient: older rows may lack fields. */
export const intakeRawSchema = z.object({
  website: z.string().optional(),
  project_description: z.string().optional(),
  budget_range: z.enum(BUDGET_RANGES).optional(),
  timeline: z.enum(TIMELINES).optional(),
});

export const approvalQueueRowSchema = z.object({
  id: z.uuid(),
  started_at: z.string(),
  clients: z.object({
    company_name: z.string(),
    service_tier: z.enum(SERVICE_TIERS),
    risk_level: z.enum(RISK_LEVELS).nullable(),
    risk_reason: z.string().nullable(),
  }),
  run_steps: z.array(z.object({ created_at: z.string() })),
});

export const recentRunRowSchema = z.object({
  id: z.uuid(),
  status: z.enum(RUN_STATUSES),
  started_at: z.string(),
  clients: z.object({
    company_name: z.string(),
    service_tier: z.enum(SERVICE_TIERS),
    risk_level: z.enum(RISK_LEVELS).nullable(),
  }),
});

export const runStepRowSchema = z.object({
  step_name: z.string(),
  status: z.enum(STEP_STATUSES),
  attempt: z.number().int(),
  duration_ms: z.number().int().nullable(),
  error: z.string().nullable(),
  created_at: z.string(),
});

export const runDetailRowSchema = z.object({
  id: z.uuid(),
  status: z.enum(RUN_STATUSES),
  approval_mode: z.enum(["auto", "manual"]).nullable(),
  approved_by: z.string().nullable(),
  approved_at: z.string().nullable(),
  error: z.string().nullable(),
  started_at: z.string(),
  finished_at: z.string().nullable(),
  clients: z.object({
    company_name: z.string(),
    contact_name: z.string(),
    contact_email: z.string(),
    service_tier: z.enum(SERVICE_TIERS),
    risk_level: z.enum(RISK_LEVELS).nullable(),
    intake_raw: z.unknown(),
    intake_ai: z.unknown(),
  }),
  run_steps: z.array(runStepRowSchema),
});

export const decisionRowSchema = z.object({
  status: z.enum(RUN_STATUSES),
});
