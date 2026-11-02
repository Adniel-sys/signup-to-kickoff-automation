# Progress

Last checkpoint: 2026-11-03.

## Status

**Phases 1–4 complete. Next is Phase 5 (WF-03 Provisioning).**

## What's done

**Phase 1: Foundation.** npm-workspaces monorepo with the Next.js app (`apps/web`), the Supabase
schema in `supabase/migrations/` (3 tables, indexes, RLS, Realtime), env validation and CI (lint,
type-check, tests). The RLS policies and revokes were applied to the live database by hand (runbook,
Phase 4 → "Fix: RLS policies and revokes").

**Phase 2: Intake.** `/onboard` form (Zod + Turnstile) and `/api/onboard`, which forwards to n8n
WF-01. WF-01 inserts the client and run idempotently: a duplicate submit (same `submission_id`)
returns the same `run_id` with `duplicate: true`.

**Phase 3: AI enrichment.** WF-01 calls Claude Haiku 4.5 with strict tool output, validates it,
and retries once. Business rules run in code (enterprise tier → `high`), and a language rule keeps
all text in the client's language. 7/7 re-tests pass.

**Phase 4: Approval gate.** WF-02 Approval Gate has three entries: route a new run (auto-approve
low risk, otherwise queue it), a decision webhook from `/api/approve`, and a 48-hour timeout on a
15-minute schedule. `/admin` dashboard with Supabase login, approval queue, run detail and
Approve/Reject. Slack alerts for approval needed, decisions, and timeouts.

## Test results so far

**Phase 2** (runbook, WF-01 "Verify"): first submit → `202`, `duplicate: false`; second submit with
the same `submission_id` → `200`, `duplicate: true`, same `run_id`. Passed (the Phase 2 done
criterion); results weren't recorded in a table.

**Phase 3 fix re-test** (runbook, "Phase 3 fix re-test"): 7/7 pass.

| # | Client | Expected |
|---|---|---|
| 1 | Bloom & Basil Florist | `low` |
| 2 | Summit Physical Therapy | `medium` |
| 3 | Vertex Commerce Group | `high`, `succeeded` |
| 4 | Test Corp (injection) | `high`, injection flagged, clean email |
| 5 | Meridian Health Network (enterprise) | `high` (enterprise rule) |
| 6 | Sari-Sari Hub PH (Filipino) | `low`, all text in Filipino |
| 7 | Bright Ideas Co (vague) | `high`, `risk_reason` names vague scope |

**Phase 4** (runbook, Phase 4 → "Test results"):

| Test | Result |
|---|---|
| 1 Signed out is blocked | ✅ |
| 2 Low risk: auto-approve | ✅ |
| 3 Medium: manual approve | ✅ |
| 4 Reject without a note is blocked | ✅ |
| 4 Reject with a note | ✅ |
| 3–4 Decision alert in Slack (`Slack decision alert`) | ✅ |
| 6 Stale tab: second approve → `409` | not run yet |
| 5 Timeout reject | not run yet |

## Open items for next session

- [ ] **WF-01:** rename the last node from `Call 'WF-02 Approval Gate'` to `Start approval` and set
      **Wait For Sub-Workflow Completion** OFF. Republish, then re-export to
      `n8n/workflows/wf-01-onboarding-main.json` (scrubbed).
- [ ] **WF-02:** remove the backticks around the `Reject timed-out runs` Query Parameters, so the
      field holds only `{{ [ '48 hours' ] }}`. Republish and re-export.
- [ ] **Database:** run "Check the live database against the migration" (runbook, end of Phase 4)
      in the Supabase SQL editor and fix any `ok = false` rows. Realtime is suspected.
- [ ] **Tests:** run the stale-tab `409` test (#6) and the timeout test (#5), and fill in the
      results here and in the runbook.
- [ ] **Welcome email prompt:** stop Haiku from making claims about the agency's experience (years,
      past clients, results) before Phase 5 sends real emails.

## How to resume

1. Start Claude Code in this folder (`signup-to-kickoff-automation`).
2. Read `CLAUDE.md` and `docs/progress.md`.
3. Clear the open items above, then begin Phase 5.
