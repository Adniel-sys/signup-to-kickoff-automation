# API contract: website ⇄ n8n (intake and approval)

This is the spec the n8n webhooks are built against. Sections 1–3 cover the WF-01 intake
(Phase 2) and sections 4–6 the WF-02 approval decision (Phase 4). The intake side is implemented
in `apps/web/lib/server/n8n.ts` and tested in `apps/web/tests/api-onboard.test.ts`.

```
Browser ──POST /api/onboard──▶ Next.js ──POST {N8N_BASE_URL}/webhook/onboard──▶ n8n WF-01 ──▶ Supabase
```

The browser never talks to n8n. By the time a request reaches n8n, the website has already
verified Turnstile and validated the payload with `apps/web/lib/schemas/intake.ts`.

## 1. Request: website → n8n

```
POST {N8N_BASE_URL}/webhook/onboard
Content-Type: application/json
X-Onboard-Secret: <ONBOARD_WEBHOOK_SECRET>
ngrok-skip-browser-warning: true
```

| Header | Purpose |
|---|---|
| `X-Onboard-Secret` | Shared secret. n8n's Webhook node checks it with Header Auth. |
| `ngrok-skip-browser-warning` | Stops ngrok from serving its HTML interstitial instead of proxying. |

The website waits **10 seconds** at most, then aborts.

### Body

This is the validated intake **without** `turnstile_token`. Strings are already trimmed.

| Field | Type | Notes |
|---|---|---|
| `submission_id` | uuid | Generated once per form load in the browser; identical on retries. **Dedupe key.** |
| `company_name` | string | 2–100 chars |
| `contact_name` | string | 2–100 chars |
| `contact_email` | string | valid email, ≤ 254 chars |
| `service_tier` | `"starter"` \| `"growth"` \| `"enterprise"` | matches the `clients.service_tier` check constraint |
| `website` | string (http/https URL) | **optional: key omitted** when not provided |
| `project_description` | string | 30–2000 chars |
| `budget_range` | `"under_5k"` \| `"5k_15k"` \| `"15k_50k"` \| `"50k_plus"` | |
| `timeline` | `"asap"` \| `"1_3_months"` \| `"3_6_months"` \| `"flexible"` | |

Example:

```json
{
  "company_name": "Acme Robotics",
  "contact_name": "Jordan Lee",
  "contact_email": "jordan@acme.example",
  "service_tier": "growth",
  "website": "https://acme.example",
  "project_description": "We need a marketing site and a customer portal for our new product line.",
  "budget_range": "15k_50k",
  "timeline": "1_3_months",
  "submission_id": "3f6b2a52-8c1d-4e7a-9b0f-2d4c6e8a1b3c"
}
```

In n8n the body is at `$json.body`, and the whole object is what gets stored as `clients.intake_raw`.

## 2. Responses: n8n → website

The website accepts exactly two success shapes. **Anything else is treated as an error.**

### New submission: `202 Accepted`

```json
{ "ok": true, "duplicate": false, "run_id": "9a1c3e5f-7b2d-4f6a-8c0e-1d3f5a7b9c2e" }
```

`run_id` is `onboarding_runs.id` of the run that was just created.

### Duplicate `submission_id`: `200 OK`

```json
{ "ok": true, "duplicate": true, "run_id": "9a1c3e5f-7b2d-4f6a-8c0e-1d3f5a7b9c2e" }
```

`run_id` is the **existing** run for that `submission_id`. No new client or run is created.

### How the website maps n8n's answer

| n8n result | Website → browser |
|---|---|
| `202` + body exactly as above (`run_id` a uuid) | `202 { ok: true, run_id, duplicate: false }` |
| `200` + body with `duplicate: true` | `200 { ok: true, run_id, duplicate: true }` |
| `401` / `403` (bad secret), `404` (workflow not active), `5xx`, a `200`/`202` with any other body, non-JSON | `502 upstream_error` |
| No response within 10 s | `503 unavailable` |
| Connection refused / DNS / TLS failure | `503 unavailable` |
| Response carries an `ngrok-error-code` header (tunnel offline, e.g. `ERR_NGROK_3200`) | `503 unavailable` |

The browser only ever gets a generic message. The secret and n8n's raw status or body are logged on
the server and never sent to the client.

## 3. Responses: website → browser (`POST /api/onboard`)

Schema: `apps/web/lib/schemas/onboard-response.ts`.

```ts
type OnboardResponse =
  | { ok: true; run_id: string; duplicate: boolean }
  | {
      ok: false;
      error: "invalid_json" | "validation_failed" | "turnstile_failed" | "upstream_error" | "unavailable";
      message: string;                          // safe to show to the user
      field_errors?: Record<string, string[]>;  // only for validation_failed
    };
```

| Status | `error` | When |
|---|---|---|
| 202 | – | New submission accepted |
| 200 | – | Duplicate; the browser shows the same confirmation |
| 400 | `invalid_json` | Body is not JSON |
| 400 | `validation_failed` | Missing Turnstile token, or the Zod schema failed (`field_errors` set) |
| 403 | `turnstile_failed` | Cloudflare siteverify rejected the token |
| 502 | `upstream_error` | n8n answered with anything other than the two success shapes |
| 503 | `unavailable` | n8n or Cloudflare siteverify is unreachable or timed out |

Order of checks: parse JSON → Turnstile siteverify → Zod → n8n. Turnstile tokens are single-use, so
after any failed attempt the form resets the widget and gets a fresh token. The `submission_id` is
kept, so a retry after a timeout is deduplicated by n8n and can never create a second run.

## 4. Approval: overview

```
Admin browser ──POST /api/approve──▶ Next.js ──POST {N8N_BASE_URL}/webhook/approval──▶ n8n WF-02 ──▶ Supabase
```

All approval logic lives in WF-02 `Approval Gate`. When WF-01 finishes enrichment it hands the
run to WF-02 (entry 1), which either approves it automatically or sets it to `awaiting_approval`,
sends a Slack alert, and **ends**. Nothing in n8n stays paused: the database holds the state.
Later, an admin decides in `/admin`, and the website sends the decision to WF-02's webhook
(entry 2, the contract below), which records it in one atomic statement. **n8n records the
decision; the website never writes to the database.** WF-02's schedule (entry 3) rejects runs
nobody decided within 48 hours.

The website side is in `apps/web/app/api/approve/route.ts` and `apps/web/lib/server/n8n.ts`,
tested in `apps/web/tests/api-approve.test.ts`. WF-02's `Validate request` Code node is
`n8n/snippets/validate-approval.js`, tested in `n8n/snippets/validate-approval.test.mjs`.

The URL is fixed (built from `N8N_BASE_URL`), so nothing stored in the database decides where the
secret is sent. `onboarding_runs.resume_url` is no longer used and stays `NULL`; the column is
kept so no migration is needed.

## 5. Request: website → n8n WF-02

```
POST {N8N_BASE_URL}/webhook/approval
Content-Type: application/json
X-Onboard-Secret: <ONBOARD_WEBHOOK_SECRET>
ngrok-skip-browser-warning: true
```

```json
{
  "run_id": "9a1c3e5f-7b2d-4f6a-8c0e-1d3f5a7b9c2e",
  "decision": "approve",
  "decided_by": "ops@northpeak.example",
  "note": "Scope and budget line up."
}
```

| Field | Type | Notes |
|---|---|---|
| `run_id` | uuid | The run being decided |
| `decision` | `"approve"` \| `"reject"` | |
| `decided_by` | string | The signed-in admin's email, taken from the session; the browser can't set it |
| `note` | string \| null | Trimmed, ≤ 500 chars. Required (≥ 3 chars) for `reject`, where it becomes the rejection reason |

WF-02's Webhook checks `X-Onboard-Secret` with the same Header Auth credential as the intake
webhook, then validates the body again (defense in depth). The website waits **10 seconds** at most.

### Responses: n8n WF-02 → website

| Status | Body | When |
|---|---|---|
| `200` | `{ "ok": true, "run_id": "<uuid>", "status": "approved" \| "rejected" }` | The decision was recorded |
| `409` | `{ "ok": false, "error": "not_awaiting_approval" }` | The run isn't `awaiting_approval` (already decided, timed out, or unknown); nothing changed |
| `400` | `{ "ok": false, "error": "invalid_request", "errors": ["…"] }` | The body failed `Validate request` |

### How the website maps n8n's answer

| n8n result | Website → browser |
|---|---|
| `200` with the body above and the same `run_id` | `200 { ok: true, run_id, decision, status }` |
| `409` | `409 not_waiting` |
| `400` | `400 invalid_decision` |
| `200` with any other body, `401`/`403` (bad secret), `404` (WF-02 not active), `5xx`, anything else | `502 upstream_error` |
| No response within 10 s, connection failure, or an `ngrok-error-code` header | `503 unavailable` |

The browser only gets a generic message. The secret, the n8n URL and n8n's raw status or body are
logged on the server and never sent to the client.

## 6. Responses: website → browser (`POST /api/approve`)

Browser request body (schema: `apps/web/lib/schemas/approve.ts`):

```json
{ "run_id": "9a1c3e5f-7b2d-4f6a-8c0e-1d3f5a7b9c2e", "decision": "reject", "note": "Budget far below scope" }
```

```ts
type ApproveResponse =
  | { ok: true; run_id: string; decision: "approve" | "reject"; status: "approved" | "rejected" }
  | {
      ok: false;
      error:
        | "unauthorized" | "forbidden" | "invalid_json" | "validation_failed"
        | "not_found" | "not_waiting" | "invalid_decision" | "upstream_error" | "unavailable";
      message: string;                          // safe to show to the admin
      field_errors?: Record<string, string[]>;  // only for validation_failed
    };
```

| Status | `error` | When |
|---|---|---|
| 200 | – | n8n recorded the decision; `status` is the run's new status |
| 401 | `unauthorized` | No valid admin session |
| 403 | `forbidden` | The `Origin` header is another site's (cross-site POST with the admin's cookie) |
| 400 | `invalid_json` | Body is not JSON |
| 400 | `validation_failed` | Zod failed: bad `run_id`, unknown `decision`, reject without a note, note too long |
| 400 | `invalid_decision` | n8n's `Validate request` refused the body (the two validations drifted apart) |
| 404 | `not_found` | No run with that id |
| 409 | `not_waiting` | The run isn't `awaiting_approval` (pre-check), or n8n found it already decided |
| 502 | `upstream_error` | n8n answered with an error or an unexpected body |
| 503 | `unavailable` | Supabase or n8n is unreachable or timed out |

Order of checks: session → origin → parse JSON → Zod → pre-check the run's status → n8n.

**A decision can't be applied twice.** The page disables both buttons after the first click. The
website's status pre-check gives a fast `409` for a run that was already decided. The real guard is
WF-02's `Record decision`: one statement that only changes a run still `awaiting_approval`, so two
concurrent requests (or a decision racing the 48-hour timeout) can't both win. The loser gets `409`.
