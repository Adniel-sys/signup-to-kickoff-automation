import type { BUDGET_RANGES, SERVICE_TIERS, TIMELINES } from "@/lib/schemas/intake";
import type { RiskLevel, RunStatus, StepStatus } from "@/lib/schemas/runs";

/** Display labels shared by the intake form and the admin dashboard. */

export const SERVICE_TIER_LABELS: Record<(typeof SERVICE_TIERS)[number], string> = {
  starter: "Starter",
  growth: "Growth",
  enterprise: "Enterprise",
};

export const BUDGET_LABELS: Record<(typeof BUDGET_RANGES)[number], string> = {
  under_5k: "Under $5k",
  "5k_15k": "$5k – $15k",
  "15k_50k": "$15k – $50k",
  "50k_plus": "$50k+",
};

export const TIMELINE_LABELS: Record<(typeof TIMELINES)[number], string> = {
  asap: "As soon as possible",
  "1_3_months": "1–3 months",
  "3_6_months": "3–6 months",
  flexible: "Flexible",
};

export const RUN_STATUS_LABELS: Record<RunStatus, string> = {
  received: "Received",
  enriching: "Enriching",
  awaiting_approval: "Awaiting approval",
  approved: "Approved",
  rejected: "Rejected",
  provisioning: "Provisioning",
  completed: "Completed",
  failed: "Failed",
};

export const STEP_STATUS_LABELS: Record<StepStatus, string> = {
  started: "Started",
  succeeded: "Succeeded",
  failed: "Failed",
  skipped: "Skipped",
};

export const RISK_LABELS: Record<RiskLevel, string> = {
  low: "Low risk",
  medium: "Medium risk",
  high: "High risk",
};

/** Plain-language names for business rules recorded in intake_ai.rule_overrides. */
export const RULE_OVERRIDE_LABELS: Record<string, string> = {
  enterprise_tier_high: "Enterprise tier is always high risk",
};
