import Link from "next/link";
import { Suspense } from "react";
import { RiskBadge, RunStatusBadge } from "@/components/status-badge";
import { Card, CardContent } from "@/components/ui/card";
import { formatAge, formatDateTime } from "@/lib/format";
import { SERVICE_TIER_LABELS } from "@/lib/labels";
import { requireAdmin } from "@/lib/server/auth";
import { listApprovalQueue, listRecentRuns } from "@/lib/server/runs";

export default function AdminPage() {
  return (
    <>
      <section className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">Approval queue</h1>
          <p className="text-muted-foreground">
            Runs waiting for a decision, oldest first. Undecided runs are rejected automatically after 48 hours.
          </p>
        </div>
        <Suspense fallback={<Placeholder>Loading the queue…</Placeholder>}>
          <ApprovalQueue />
        </Suspense>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-xl font-semibold tracking-tight">Recent runs</h2>
        <Suspense fallback={<Placeholder>Loading runs…</Placeholder>}>
          <RecentRuns />
        </Suspense>
      </section>
    </>
  );
}

async function ApprovalQueue() {
  await requireAdmin("/admin");
  const { items, checkedAt } = await listApprovalQueue();
  if (items.length === 0) return <Placeholder>Nothing is waiting for approval.</Placeholder>;

  return (
    <ul className="flex flex-col gap-3">
      {items.map((item) => (
        <li key={item.runId}>
          <Card className="transition-colors hover:bg-muted/40">
            <CardContent>
              <Link href={`/admin/runs/${item.runId}`} className="flex flex-col gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{item.companyName}</span>
                  <span className="text-sm text-muted-foreground">{SERVICE_TIER_LABELS[item.serviceTier]}</span>
                  <RiskBadge level={item.riskLevel} />
                  <span className="ml-auto text-sm text-muted-foreground" title={formatDateTime(item.waitingSince)}>
                    Waiting {formatAge(item.waitingSince, checkedAt)}
                  </span>
                </div>
                {item.riskReason ? <p className="text-sm text-muted-foreground">{item.riskReason}</p> : null}
              </Link>
            </CardContent>
          </Card>
        </li>
      ))}
    </ul>
  );
}

async function RecentRuns() {
  await requireAdmin("/admin");
  const runs = await listRecentRuns();
  if (runs.length === 0) return <Placeholder>No runs yet.</Placeholder>;

  return (
    <Card className="py-0">
      <ul className="divide-y">
        {runs.map((run) => (
          <li key={run.id}>
            <Link
              href={`/admin/runs/${run.id}`}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 transition-colors hover:bg-muted/40 sm:px-6"
            >
              <span className="font-medium">{run.clients.company_name}</span>
              <span className="text-sm text-muted-foreground">{SERVICE_TIER_LABELS[run.clients.service_tier]}</span>
              <RiskBadge level={run.clients.risk_level} />
              <RunStatusBadge status={run.status} />
              <span className="ml-auto text-sm text-muted-foreground">{formatDateTime(run.started_at)}</span>
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Placeholder({ children }: { children: React.ReactNode }) {
  return (
    <Card>
      <CardContent>
        <p className="text-sm text-muted-foreground">{children}</p>
      </CardContent>
    </Card>
  );
}
