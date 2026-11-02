import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { z } from "zod";
import { RiskBadge, RunStatusBadge, StepStatusBadge } from "@/components/status-badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDateTime, formatDuration } from "@/lib/format";
import {
  BUDGET_LABELS,
  RISK_LABELS,
  RULE_OVERRIDE_LABELS,
  SERVICE_TIER_LABELS,
  TIMELINE_LABELS,
} from "@/lib/labels";
import type { IntakeAi } from "@/lib/schemas/runs";
import { requireAdmin } from "@/lib/server/auth";
import { getRunDetail, type RunDetail } from "@/lib/server/runs";
import { DecisionPanel } from "./decision-panel";

/** Only http(s) links are rendered as links; anything else from the intake is shown as text. */
const HTTP_URL = /^https?:\/\//i;

export default function RunPage({ params }: PageProps<"/admin/runs/[id]">) {
  return (
    <>
      <Link href="/admin" className="text-sm text-muted-foreground hover:text-foreground">
        ← Back to the queue
      </Link>
      {/* The run id and the session are request data, so the detail streams in. */}
      <Suspense fallback={<p className="text-sm text-muted-foreground">Loading run…</p>}>
        <RunDetailView params={params} />
      </Suspense>
    </>
  );
}

async function RunDetailView({ params }: Pick<PageProps<"/admin/runs/[id]">, "params">) {
  const { id } = await params;
  await requireAdmin(`/admin/runs/${id}`);
  if (!z.uuid().safeParse(id).success) notFound();

  const run = await getRunDetail(id);
  if (!run) notFound();
  const { client } = run;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{client.company_name}</h1>
          <RunStatusBadge status={run.status} />
          <RiskBadge level={client.risk_level} />
        </div>
        <p className="text-sm text-muted-foreground">
          {SERVICE_TIER_LABELS[client.service_tier]} tier · Started {formatDateTime(run.started_at)}
        </p>
        <Outcome run={run} />
      </header>

      {run.status === "awaiting_approval" ? <DecisionPanel runId={run.id} /> : null}

      <div className="grid gap-6 lg:grid-cols-2">
        <ClientCard run={run} />
        {client.analysis ? <AnalysisCard analysis={client.analysis} /> : <NoAnalysisCard />}
      </div>

      {client.analysis ? (
        <div className="grid gap-6 lg:grid-cols-2">
          <EmailCard analysis={client.analysis} />
          <AgendaCard analysis={client.analysis} />
        </div>
      ) : null}

      <TimelineCard run={run} />
    </div>
  );
}

/** How the run ended or was decided, when it has. */
function Outcome({ run }: { run: RunDetail }) {
  if (run.status === "approved" && run.approved_at) {
    const who = run.approval_mode === "auto" ? "automatically" : `by ${run.approved_by ?? "an admin"}`;
    return <p className="text-sm">Approved {who} on {formatDateTime(run.approved_at)}.</p>;
  }
  if ((run.status === "rejected" || run.status === "failed") && run.error) {
    return (
      <p className="text-sm text-destructive">
        {run.status === "rejected" ? "Rejected" : "Failed"}: {run.error}
      </p>
    );
  }
  return null;
}

function ClientCard({ run }: { run: RunDetail }) {
  const { client } = run;
  const { intake } = client;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Client</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          <Term>Contact</Term>
          <dd>{client.contact_name}</dd>
          <Term>Email</Term>
          <dd className="break-all">
            <a href={`mailto:${client.contact_email}`} className="underline underline-offset-4">
              {client.contact_email}
            </a>
          </dd>
          <Term>Website</Term>
          <dd className="break-all">
            {intake.website && HTTP_URL.test(intake.website) ? (
              <a href={intake.website} target="_blank" rel="noopener noreferrer nofollow" className="underline underline-offset-4">
                {intake.website}
              </a>
            ) : (
              <span className="text-muted-foreground">{intake.website ?? "None given"}</span>
            )}
          </dd>
          <Term>Budget</Term>
          <dd>{intake.budget_range ? BUDGET_LABELS[intake.budget_range] : "–"}</dd>
          <Term>Timeline</Term>
          <dd>{intake.timeline ? TIMELINE_LABELS[intake.timeline] : "–"}</dd>
        </dl>
        {intake.project_description ? (
          <div className="flex flex-col gap-1">
            <h3 className="text-sm font-medium">Project description</h3>
            <p className="text-sm whitespace-pre-line text-muted-foreground">{intake.project_description}</p>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function AnalysisCard({ analysis }: { analysis: IntakeAi }) {
  const overrides = analysis.rule_overrides ?? [];
  return (
    <Card>
      <CardHeader>
        <CardTitle>AI analysis</CardTitle>
        <CardDescription>Claude Haiku 4.5, checked against the schema and business rules.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 text-sm">
        <p>{analysis.summary}</p>
        <List title="Goals" items={analysis.goals} />
        <List title="Risk flags" items={analysis.risk_flags} empty="No risk flags." />
        <div className="flex flex-col gap-1">
          <h3 className="font-medium">Risk reason</h3>
          <p className="text-muted-foreground">{analysis.risk_reason}</p>
        </div>
        {overrides.length > 0 && analysis.ai_risk_level ? (
          <div className="rounded-lg border border-dashed p-3">
            <p>
              Raised from <strong>{RISK_LABELS[analysis.ai_risk_level].toLowerCase()}</strong> (Haiku&apos;s
              verdict) to <strong>{RISK_LABELS[analysis.risk_level].toLowerCase()}</strong> by a business rule:
            </p>
            <ul className="mt-1 list-disc pl-5 text-muted-foreground">
              {overrides.map((rule) => (
                <li key={rule}>{RULE_OVERRIDE_LABELS[rule] ?? rule}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function NoAnalysisCard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>AI analysis</CardTitle>
        <CardDescription>Not available yet. Enrichment hasn&apos;t finished, or it failed (see the timeline).</CardDescription>
      </CardHeader>
    </Card>
  );
}

function EmailCard({ analysis }: { analysis: IntakeAi }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Drafted welcome email</CardTitle>
        <CardDescription>Sent to the client in Phase 5, after approval.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        <p>
          <span className="text-muted-foreground">Subject: </span>
          <span className="font-medium">{analysis.welcome_email.subject}</span>
        </p>
        <p className="whitespace-pre-line">{analysis.welcome_email.body}</p>
      </CardContent>
    </Card>
  );
}

function AgendaCard({ analysis }: { analysis: IntakeAi }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Kickoff agenda</CardTitle>
      </CardHeader>
      <CardContent>
        <ol className="list-decimal space-y-1 pl-5 text-sm">
          {analysis.kickoff_agenda.map((item, index) => (
            <li key={index}>{item}</li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}

function TimelineCard({ run }: { run: RunDetail }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Timeline</CardTitle>
        <CardDescription>Every workflow step recorded for this run.</CardDescription>
      </CardHeader>
      <CardContent>
        {run.run_steps.length === 0 ? (
          <p className="text-sm text-muted-foreground">No steps recorded yet.</p>
        ) : (
          <ol className="flex flex-col gap-3">
            {run.run_steps.map((step) => (
              <li key={step.step_name} className="flex flex-col gap-1 border-l-2 pl-4">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-mono">{step.step_name}</span>
                  <StepStatusBadge status={step.status} />
                  {step.attempt > 1 ? <span className="text-muted-foreground">attempt {step.attempt}</span> : null}
                  {step.duration_ms !== null ? (
                    <span className="text-muted-foreground">{formatDuration(step.duration_ms)}</span>
                  ) : null}
                  <span className="ml-auto text-muted-foreground">{formatDateTime(step.created_at)}</span>
                </div>
                {step.error ? <p className="text-sm break-words text-destructive">{step.error}</p> : null}
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}

function List({ title, items, empty }: { title: string; items: string[]; empty?: string }) {
  return (
    <div className="flex flex-col gap-1">
      <h3 className="font-medium">{title}</h3>
      {items.length === 0 ? (
        <p className="text-muted-foreground">{empty}</p>
      ) : (
        <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
          {items.map((item, index) => (
            <li key={index}>{item}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Term({ children }: { children: React.ReactNode }) {
  return <dt className="text-muted-foreground">{children}</dt>;
}
