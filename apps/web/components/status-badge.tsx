import { cn } from "@/lib/utils";
import { RISK_LABELS, RUN_STATUS_LABELS, STEP_STATUS_LABELS } from "@/lib/labels";
import type { RiskLevel, RunStatus, StepStatus } from "@/lib/schemas/runs";

type Tone = "neutral" | "info" | "success" | "warning" | "danger";

const TONES: Record<Tone, string> = {
  neutral: "bg-muted text-muted-foreground",
  info: "bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-200",
  success: "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200",
  warning: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
  danger: "bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-200",
};

const RUN_TONES: Record<RunStatus, Tone> = {
  received: "neutral",
  enriching: "info",
  awaiting_approval: "warning",
  approved: "success",
  rejected: "danger",
  provisioning: "info",
  completed: "success",
  failed: "danger",
};

const STEP_TONES: Record<StepStatus, Tone> = {
  started: "info",
  succeeded: "success",
  failed: "danger",
  skipped: "neutral",
};

const RISK_TONES: Record<RiskLevel, Tone> = { low: "success", medium: "warning", high: "danger" };

function Badge({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap",
        TONES[tone],
      )}
    >
      {children}
    </span>
  );
}

export function RunStatusBadge({ status }: { status: RunStatus }) {
  return <Badge tone={RUN_TONES[status]}>{RUN_STATUS_LABELS[status]}</Badge>;
}

export function StepStatusBadge({ status }: { status: StepStatus }) {
  return <Badge tone={STEP_TONES[status]}>{STEP_STATUS_LABELS[status]}</Badge>;
}

export function RiskBadge({ level }: { level: RiskLevel | null }) {
  if (!level) return <Badge tone="neutral">Not assessed</Badge>;
  return <Badge tone={RISK_TONES[level]}>{RISK_LABELS[level]}</Badge>;
}
