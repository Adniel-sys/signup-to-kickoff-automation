# Phase 4 — Approval gate

Read CLAUDE.md. We're now on Phase 4. Update the "Current phase" line in CLAUDE.md to Phase 4.
n8n workflows are built manually in the n8n UI: do NOT generate workflow JSON. Write website
code in the repo and click-by-click n8n steps in docs/runbook.md, the same way as Phases 2 and 3.

## Decisions already made

- Approvals happen in the website's **/admin dashboard** (login required).
- **Slack** only sends an alert with a "Review" link to the run in the dashboard. No interactive
  Slack buttons yet (those need a public URL; they may come in Phase 6 after deploying).
- **Auto-approve** only when `risk_level = 'low'` AND `service_tier <> 'enterprise'`.
  Everything else waits for a human.
- **Timeout:** if nobody decides within **48 hours**, the run is auto-rejected with reason
  "approval timed out".
- The website still never writes to the database. Decisions go to n8n, and n8n writes.

## n8n: WF-01 continues after `Save Enrichment`

Write the runbook steps (exact node names, SQL, Query Parameters, settings) for:

1. `Needs approval?` (IF): true when risk is not low OR tier is enterprise. Read risk_level from
   the validated data that fed Save Enrichment and tier from `$('Webhook').first()`.
   Use `.first()` everywhere; never `.item`.
2. **Auto path** → `Mark auto-approved` (Postgres): run `status = 'approved'`,
   `approval_mode = 'auto'`, `approved_by = 'system'`, `approved_at = now()`, and a `run_steps`
   row `approval` → `succeeded` with output `{ mode: 'auto' }`. One statement.
3. **Manual path:**
   - `Mark awaiting approval` (Postgres): run `status = 'awaiting_approval'`,
     `approval_mode = 'manual'`, `resume_url = $execution.resumeUrl`, and a `run_steps` row
     `approval` → `started`. Only from `status = 'enriching'` (guard against re-runs).
   - `Slack alert` (HTTP Request to a Slack **Incoming Webhook**): company, tier, risk level,
     risk_reason, and a "Review" link to `{DASHBOARD_URL}/admin/runs/{run_id}`. Explain how to
     create the incoming webhook in a free Slack workspace and where to put the dashboard base
     URL (localhost for now). A failed Slack post must NOT block the approval: On Error → Continue.
   - `Wait for decision` (Wait): Resume = On Webhook Call, HTTP method POST, Authentication =
     Header Auth with the existing `Onboard Webhook Secret` credential, Limit Wait Time = 48 hours.
     Note how to temporarily set it to 2 minutes for testing the timeout.
   - `Decision` (Switch): `approve`, `reject`, or no body (timeout).
   - `Record approval` (Postgres): run → `approved`, `approved_by`, `approved_at`; step
     `approval` → `succeeded` with output `{ mode: 'manual', decision: 'approve', note }`.
     Guard: only from `awaiting_approval`.
   - `Record rejection` (Postgres): run → `rejected`, `finished_at`, reason in `error`
     (the note, or "approval timed out"); step `approval` → `succeeded` with output
     `{ mode: 'manual' | 'timeout', decision: 'reject', note }`. Guard: only from
     `awaiting_approval`.
   Phase 5 will continue from both `Mark auto-approved` and `Record approval`.

If the schema needs a new column (e.g. for the decision note), add a migration in
`supabase/migrations/` and tell me to run it in the SQL editor. Prefer reusing existing columns.

## Website

1. **Admin login** with Supabase Auth (email + password; sign-ups are disabled, I already have a
   user). `/login` page, and middleware/route protection so every `/admin` route and
   `/api/approve` requires a session. Server-side session checks, not just client redirects.
2. **`/admin`**: approval queue first (runs in `awaiting_approval`: company, tier, risk level,
   risk_reason, waiting since), then a list of recent runs with their status.
3. **`/admin/runs/[id]`**: client details, AI summary, goals, risk flags, risk reason,
   `ai_risk_level` + `rule_overrides` when present, the drafted welcome email, the kickoff agenda,
   the `run_steps` timeline, and **Approve / Reject** buttons (reject requires a short note) shown
   only while the run is `awaiting_approval`.
4. **`/api/approve`** (route handler):
   - Require an admin session → 401 otherwise.
   - Zod-validate `{ run_id, decision: 'approve' | 'reject', note? }` → 400.
   - Load the run; if it isn't `awaiting_approval` or has no `resume_url` → 409.
   - **SSRF guard:** only call the `resume_url` if its origin matches `N8N_BASE_URL`; otherwise 502
     and log it.
   - POST `{ decision, decided_by: <admin email>, note }` to the `resume_url` with headers
     `X-Onboard-Secret` and `ngrok-skip-browser-warning: true`, 10s timeout.
   - Map n8n errors like `/api/onboard` does (never leak raw errors or the secret).
   - A second click must not resume twice: n8n's Record nodes already guard on status, and the
     resume URL only works once; return a clear 409 if the run is no longer waiting.
5. Keep the visual style of `/onboard`. Use the existing shadcn components.

## Docs and tests

- `docs/api-contract.md`: add the approval resume contract (headers, body, responses).
- `docs/runbook.md`: new section "WF-01 continued: Phase 4 approval gate" with every node, the
  Slack setup, a troubleshooting table, and a test plan:
  low-risk auto-approve, medium manual approve, high manual reject with note, timeout reject
  (2-minute wait), double-click approve (second gets 409), logged-out access to /admin and
  /api/approve (blocked).
- Vitest for `/api/approve`: no session 401, bad body 400, not waiting 409, origin mismatch
  blocked, success forwards with the secret header, n8n error mapping.

Run lint, type-check, and tests. Don't commit yet. Stop and list exactly what I must do manually,
in order (migration if any, Slack webhook, n8n nodes, env vars).
