# Phase 4 revision — event-driven approval (no Wait node)

Read CLAUDE.md. We're on Phase 4. n8n workflows are built manually in the n8n UI: do NOT generate
workflow JSON. Write website code in the repo and click-by-click n8n steps in docs/runbook.md.

## Why we're changing the design

The Phase 4 build you just did uses a Wait node inside WF-01, so every run that needs approval
stays a paused n8n execution for up to 48 hours, and the approval state lives inside n8n.
None of the Phase 4 n8n nodes have been built yet, so we're switching now.

New principle: **the database holds the state; workflows are short, stateless event handlers.**
- Use **independent workflows** (own webhook or schedule trigger) for events that happen later.
- Use **sub-workflows** (Execute Workflow node) for reusable work that runs immediately.
- No long-lived Wait nodes.

## Target architecture

| Workflow | Trigger | Job |
|---|---|---|
| WF-01 Intake & Enrichment | Webhook `/webhook/onboard` | Existing intake + AI enrichment, then route and END |
| WF-02 Approval Decision | Webhook `/webhook/approval` (called by `/api/approve`) | Record approve/reject from the DB state |
| WF-05 Approval Timeout | Schedule, every 15 minutes | Auto-reject runs waiting longer than 48 hours |
| WF-03 Provisioning (Phase 5) | Sub-workflow, called by WF-01 (auto-approve) and WF-02 (approve) | Not built yet: leave clearly marked attachment points |
| WF-04 Error Handler (Phase 6) | Error Trigger | Not built yet |

Add this table and the principle above to CLAUDE.md (architecture section) so future sessions
follow it.

## n8n: WF-01 changes (after `Save Enrichment`)

1. `Needs approval?` (IF): true when risk_level is not `low` OR service_tier is `enterprise`.
   Read risk from the validated data that fed Save Enrichment, tier from `$('Webhook').first()`.
   `.first()` everywhere, never `.item`.
2. false → `Mark auto-approved` (Postgres): run `status = 'approved'`, `approval_mode = 'auto'`,
   `approved_by = 'system'`, `approved_at = now()`; `run_steps` row `approval` → `succeeded`,
   output `{ mode: 'auto' }`. One statement, guarded on `status = 'enriching'`.
   Mark the spot where Phase 5 will add "Execute Workflow → WF-03".
3. true → `Mark awaiting approval` (Postgres): run `status = 'awaiting_approval'`,
   `approval_mode = 'manual'`; `run_steps` row `approval` → `started`. Guarded on
   `status = 'enriching'`. Leave `resume_url` NULL (column stays, unused; note it in the docs).
4. → `Slack alert` (HTTP Request to my Slack Incoming Webhook): company, tier, risk level,
   risk_reason, and a "Review" link to `http://localhost:3000/admin/runs/{run_id}`.
   On Error → Continue, so a Slack failure never blocks the run. Workflow ends here.

## n8n: WF-02 Approval Decision (new workflow)

1. `Webhook`: POST, path `approval`, Header Auth with the existing `Onboard Webhook Secret`
   credential, respond using Respond to Webhook nodes.
   Body: `{ run_id, decision: 'approve' | 'reject', decided_by, note }`.
2. `Validate request` (Code or IF): run_id is a uuid, decision is approve/reject, reject has a
   note. Invalid → Respond 400. Defense in depth: the website validates too.
3. `Record decision` (Postgres): ONE atomic statement that only acts when the run is still
   `awaiting_approval`:
   - approve → run `approved`, `approved_by`, `approved_at = now()`; step `approval` →
     `succeeded`, output `{ mode: 'manual', decision: 'approve', note }`.
   - reject → run `rejected`, `finished_at = now()`, `error = note`; step `approval` →
     `succeeded`, output `{ mode: 'manual', decision: 'reject', note }`.
   Returns the run's new status, or zero rows if it wasn't waiting.
   Parameterized queries only.
4. Zero rows → Respond `409 { ok: false, error: 'not_awaiting_approval' }`.
   Otherwise → Respond `200 { ok: true, run_id, status }`.
5. Mark the spot (after an approved decision) where Phase 5 adds "Execute Workflow → WF-03".

## n8n: WF-05 Approval Timeout (new workflow)

1. `Schedule Trigger`: every 15 minutes.
2. `Reject timed-out runs` (Postgres): one statement that rejects every run in
   `awaiting_approval` whose `approval` step started more than 48 hours ago:
   run → `rejected`, `finished_at = now()`, `error = 'approval timed out'`; step `approval` →
   `succeeded`, output `{ mode: 'timeout', decision: 'reject' }`. Return the affected run ids.
3. If any rows: `Slack timeout alert` (same incoming webhook, On Error → Continue) listing them.
4. Testing note: how to temporarily use `2 minutes` and a 1-minute schedule, then restore.

## Website changes

- `/api/approve`: stop using `resume_url`. POST to the fixed `${N8N_BASE_URL}/webhook/approval`
  with `X-Onboard-Secret` and `ngrok-skip-browser-warning: true`, body
  `{ run_id, decision, decided_by: <admin email>, note }`, 10s timeout.
  Keep: admin session required (401), Zod validation (400), pre-check that the run is
  `awaiting_approval` (409, for a fast clear message). Map n8n 409 → 409, n8n 400 → 400,
  other errors → 502, timeout/unreachable → 503. Never leak raw errors or the secret.
- Remove `resumeApproval`, `isTrustedResumeUrl` and their tests (no dynamic URL means no SSRF
  surface). Keep the shared POST helper if `/api/onboard` uses it.
- Dashboard pages stay as they are. Make sure the run detail page shows the approval step and,
  for rejected runs, the reason.

## Docs and tests

- `docs/api-contract.md`: replace the resume contract with the `/webhook/approval` contract.
- `docs/runbook.md`: rewrite the Phase 4 section as three parts (WF-01 changes, WF-02, WF-05),
  each with node names, SQL, Query Parameters, settings, troubleshooting, and the Slack incoming
  webhook setup. Test plan: signed-out access blocked, low-risk auto-approve, medium manual
  approve, high manual reject with note, timeout reject (2-minute test setting), double-click
  approve (second → 409).
- Vitest for `/api/approve`: 401, 400, 409 pre-check, success forwards to the fixed URL with the
  secret header, n8n 409/400/5xx mapping, timeout → 503.

Run lint, type-check, and tests. Don't commit yet. Stop and list exactly what I must do manually,
in order.
