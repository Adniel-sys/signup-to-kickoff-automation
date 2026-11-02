# Phase 4 — WF-02 Approval Gate (final plan)

Read CLAUDE.md. We're on Phase 4. This prompt REPLACES phase-4-prompt.md and
phase-4-revision-prompt.md. n8n workflows are built manually in the n8n UI: do NOT generate
workflow JSON. Write website code in the repo and click-by-click n8n steps in docs/runbook.md.

## Ground rules

- **WF-01 is complete (Phases 2 and 3). Do not change it**, except ONE new final node after
  `Save Enrichment`: `Start approval` (Execute Workflow → WF-02 Approval Gate, pass `run_id`,
  Wait for completion: OFF).
- **All Phase 4 logic lives in one new workflow: WF-02 Approval Gate.**
- No Wait node anywhere. The database holds the state; workflows are short event handlers.
  `onboarding_runs.resume_url` stays in the schema but is unused (note it in the docs).
- Approvals happen in `/admin`. Slack only sends alerts with a "Review" link. No interactive
  Slack buttons.
- Auto-approve only when `risk_level = 'low'` AND `service_tier <> 'enterprise'`.
- Timeout: runs waiting more than 48 hours are auto-rejected with reason "approval timed out".
- The website never writes to the database. n8n writes.
- Update CLAUDE.md's architecture section with the workflow table below and these rules.

| Workflow | Trigger | Status |
|---|---|---|
| WF-01 Intake & Enrichment | Webhook `/webhook/onboard` | Done (Phases 2–3) + one new node |
| WF-02 Approval Gate | 3 triggers (below) | Phase 4 |
| WF-03 Provisioning | Sub-workflow, called by WF-02 on approval | Phase 5 |
| WF-04 Error Handler | Error Trigger | Phase 6 |

## WF-02 Approval Gate: three entry points in one workflow

### Entry 1 — Route a new run (trigger: When Executed by Another Workflow, input `run_id`)

1. `Load run` (Postgres): read the run's status, the client's `risk_level` and `service_tier`
   by `run_id`. Use query parameters only.
2. `Needs approval?` (IF): true when risk_level is not `low` OR service_tier is `enterprise`.
3. false → `Mark auto-approved` (Postgres): run `status = 'approved'`, `approval_mode = 'auto'`,
   `approved_by = 'system'`, `approved_at = now()`; `run_steps` row `approval` → `succeeded`,
   output `{ mode: 'auto' }`. One statement, guarded on `status = 'enriching'`.
   Mark the spot where Phase 5 adds "Execute Workflow → WF-03".
4. true → `Mark awaiting approval` (Postgres): run `status = 'awaiting_approval'`,
   `approval_mode = 'manual'`; `run_steps` row `approval` → `started`. Guarded on
   `status = 'enriching'`.
5. → `Slack alert` (HTTP Request to my Slack Incoming Webhook): company, tier, risk level,
   risk_reason, and a "Review" link to `http://localhost:3000/admin/runs/{run_id}`.
   On Error → Continue.

### Entry 2 — Record a decision (trigger: Webhook POST `/webhook/approval`)

1. Webhook: Header Auth with the existing `Onboard Webhook Secret` credential, respond using
   Respond to Webhook nodes. Body: `{ run_id, decision: 'approve' | 'reject', decided_by, note }`.
2. `Validate request`: run_id is a uuid, decision is approve/reject, reject requires a note.
   Invalid → Respond 400.
3. `Record decision` (Postgres): ONE atomic statement that only acts when the run is still
   `awaiting_approval`:
   - approve → run `approved`, `approved_by`, `approved_at = now()`; step `approval` →
     `succeeded`, output `{ mode: 'manual', decision: 'approve', note }`.
   - reject → run `rejected`, `finished_at = now()`, `error = note`; step `approval` →
     `succeeded`, output `{ mode: 'manual', decision: 'reject', note }`.
   Returns the new status, or zero rows if the run wasn't waiting.
4. Zero rows → Respond `409 { ok: false, error: 'not_awaiting_approval' }`.
   Otherwise → Respond `200 { ok: true, run_id, status }`.
5. Mark the spot (approved branch) where Phase 5 adds "Execute Workflow → WF-03".

### Entry 3 — Timeouts (trigger: Schedule, every 15 minutes)

1. `Reject timed-out runs` (Postgres): one statement rejecting every `awaiting_approval` run
   whose `approval` step started more than 48 hours ago: run → `rejected`, `finished_at = now()`,
   `error = 'approval timed out'`; step → `succeeded`, output `{ mode: 'timeout',
   decision: 'reject' }`. Return the affected runs (id + company name).
2. If any rows → `Slack timeout alert` listing them (On Error → Continue).
3. Testing note: how to temporarily use `2 minutes` and a 1-minute schedule, then restore.

## Website

- `/api/approve`: POST to the fixed `${N8N_BASE_URL}/webhook/approval` with `X-Onboard-Secret`
  and `ngrok-skip-browser-warning: true`, body `{ run_id, decision, decided_by: <admin email>,
  note }`, 10s timeout. Keep: admin session required (401), Zod validation (400), pre-check the
  run is `awaiting_approval` (409). Map n8n 409 → 409, 400 → 400, other → 502,
  timeout/unreachable → 503. Never leak raw errors or the secret.
- Remove any resume_url-based code (`resumeApproval`, `isTrustedResumeUrl`) and its tests.
- Dashboard pages stay as built. Make sure the run page shows the approval step and, for
  rejected runs, the reason.

## Docs and tests

- `docs/api-contract.md`: the `/webhook/approval` contract (headers, body, responses).
- `docs/runbook.md`: Phase 4 section = (a) the one new WF-01 node, (b) WF-02 entry 1, 2, 3 with
  node names, SQL, Query Parameters, settings, Slack incoming webhook setup, troubleshooting.
  Test plan: signed-out access blocked, low-risk auto-approve, medium manual approve, high manual
  reject with note, timeout reject (2-minute test setting), double-click approve (second → 409).
- Vitest for `/api/approve`: 401, 400, 409 pre-check, success forwards to the fixed URL with the
  secret header, n8n 409/400/5xx mapping, timeout → 503.

Run lint, type-check, and tests. Don't commit yet. Stop and list exactly what I must do manually,
in order.
