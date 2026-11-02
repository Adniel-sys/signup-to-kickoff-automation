import "server-only";
import { z } from "zod";
import {
  approvalQueueRowSchema,
  decisionRowSchema,
  intakeAiSchema,
  intakeRawSchema,
  recentRunRowSchema,
  runDetailRowSchema,
  type IntakeAi,
  type RunStatus,
} from "@/lib/schemas/runs";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * Read-only queries for the admin dashboard. They run as the signed-in admin (anon key + session),
 * so RLS applies. Callers must check the session first (lib/server/auth.ts).
 */

const RECENT_RUNS_LIMIT = 25;

export type ApprovalQueueItem = {
  runId: string;
  companyName: string;
  serviceTier: z.infer<typeof approvalQueueRowSchema>["clients"]["service_tier"];
  riskLevel: z.infer<typeof approvalQueueRowSchema>["clients"]["risk_level"];
  riskReason: string | null;
  waitingSince: string;
};

export type ApprovalQueue = {
  items: ApprovalQueueItem[];
  /** When the queue was read (ms since epoch), to show how long each run has waited. */
  checkedAt: number;
};

/** Runs waiting for a human, oldest first. */
export async function listApprovalQueue(): Promise<ApprovalQueue> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("onboarding_runs")
    .select(
      "id, started_at, clients!inner(company_name, service_tier, risk_level, risk_reason:intake_ai->>risk_reason), run_steps(created_at)",
    )
    .eq("status", "awaiting_approval")
    .eq("run_steps.step_name", "approval")
    .order("started_at", { ascending: true });
  if (error) throw new Error(`approval queue query failed: ${error.message}`);

  const items = z
    .array(approvalQueueRowSchema)
    .parse(data)
    .map((row) => ({
      runId: row.id,
      companyName: row.clients.company_name,
      serviceTier: row.clients.service_tier,
      riskLevel: row.clients.risk_level,
      riskReason: row.clients.risk_reason,
      // The approval step opens when the run starts waiting.
      waitingSince: row.run_steps[0]?.created_at ?? row.started_at,
    }))
    .sort((a, b) => a.waitingSince.localeCompare(b.waitingSince));
  return { items, checkedAt: Date.now() };
}

export type RecentRun = z.infer<typeof recentRunRowSchema>;

export async function listRecentRuns(): Promise<RecentRun[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("onboarding_runs")
    .select("id, status, started_at, clients!inner(company_name, service_tier, risk_level)")
    .order("started_at", { ascending: false })
    .limit(RECENT_RUNS_LIMIT);
  if (error) throw new Error(`recent runs query failed: ${error.message}`);
  return z.array(recentRunRowSchema).parse(data);
}

export type RunDetail = Omit<z.infer<typeof runDetailRowSchema>, "clients"> & {
  client: Omit<z.infer<typeof runDetailRowSchema>["clients"], "intake_raw" | "intake_ai"> & {
    intake: z.infer<typeof intakeRawSchema>;
    /** null when enrichment hasn't run yet, or the stored shape is unexpected. */
    analysis: IntakeAi | null;
  };
};

/** One run with its client and step timeline, or null if it doesn't exist. */
export async function getRunDetail(runId: string): Promise<RunDetail | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("onboarding_runs")
    .select(
      "id, status, approval_mode, approved_by, approved_at, error, started_at, finished_at, " +
        "clients!inner(company_name, contact_name, contact_email, service_tier, risk_level, intake_raw, intake_ai), " +
        "run_steps(step_name, status, attempt, duration_ms, error, created_at)",
    )
    .eq("id", runId)
    .order("created_at", { referencedTable: "run_steps", ascending: true })
    .maybeSingle();
  if (error) throw new Error(`run detail query failed: ${error.message}`);
  if (!data) return null;

  const { clients, ...run } = runDetailRowSchema.parse(data);
  const { intake_raw, intake_ai, ...client } = clients;
  return {
    ...run,
    client: {
      ...client,
      intake: intakeRawSchema.safeParse(intake_raw).data ?? {},
      analysis: intakeAiSchema.safeParse(intake_ai).data ?? null,
    },
  };
}

/** A run's current status, for /api/approve's pre-check. Null when the run doesn't exist. */
export async function getRunStatus(runId: string): Promise<RunStatus | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("onboarding_runs")
    .select("status")
    .eq("id", runId)
    .maybeSingle();
  if (error) throw new Error(`decision lookup failed: ${error.message}`);
  if (!data) return null;
  return decisionRowSchema.parse(data).status;
}
