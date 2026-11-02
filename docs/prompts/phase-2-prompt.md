# Phase 2 — Intake

Read CLAUDE.md. We're now on Phase 2 (Intake). First update the "Current phase" line in CLAUDE.md to Phase 2, and note that n8n workflows are built manually in the n8n UI. Do NOT create any n8n workflow JSON.

Build:

1. shadcn/ui setup with only: button, input, textarea, select, label, card, form.

2. Shared Zod schema in apps/web/lib/schemas/intake.ts, used by both form and API route:
   - company_name, contact_name (required, trimmed, 2-100 chars)
   - contact_email (valid email)
   - service_tier: starter | growth | enterprise
   - website (optional URL)
   - project_description (required, 30-2000 chars)
   - budget_range: under_5k | 5k_15k | 15k_50k | 50k_plus
   - timeline: asap | 1_3_months | 3_6_months | flexible
   - submission_id (uuid)
   - turnstile_token (string)

3. /onboard page: clean, professional intake form for "Northpeak Studio".
   - Generate submission_id with crypto.randomUUID() once on mount; reuse it on retries.
   - Disable submit while sending. Inline field errors.
   - Success shows a confirmation with run_id. Duplicate shows the same confirmation, not an error.
   - Cloudflare Turnstile widget.

4. /api/onboard route handler:
   - Verify Turnstile server-side (siteverify).
   - Validate with Zod → 400 with field errors if invalid.
   - POST to ${N8N_BASE_URL}/webhook/onboard with headers X-Onboard-Secret, ngrok-skip-browser-warning: true, Content-Type: application/json. Send the validated payload without turnstile_token. 10s timeout via AbortController.
   - Map responses: n8n 202 → { ok: true, run_id, duplicate: false }; n8n 200 with duplicate: true → { ok: true, run_id, duplicate: true }; n8n 401/other → 502 generic error; timeout/unreachable → 503 "temporarily unavailable".
   - Never leak the secret or raw n8n errors to the client.

5. docs/api-contract.md: the exact request (headers + JSON body with an example) the website sends to n8n, and the exact responses it expects back (status codes + JSON bodies). This is the spec I'll build the n8n workflow against.

6. Vitest tests for the Zod schema and API route (mock fetch): valid → forwards with secret header; invalid → 400; n8n 401 → 502; duplicate passthrough; timeout → 503.

Run lint, type-check, and tests. Don't commit yet. Stop and summarize what was built.
