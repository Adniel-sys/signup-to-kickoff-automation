# Runbook

## WF-01 Onboarding: build it in the n8n UI (Phase 2: steps 1–3)

WF-01 is built by hand in the n8n UI. The request and response it has to honour are in
[`api-contract.md`](api-contract.md).

```
Webhook ─▶ Insert client + run ─▶ New run? ─ true ─▶ New Run Created (202)
                                           └ false ─▶ Find existing run ─▶ Reply: Duplicate, Existing Run (200)
```

Use the **exact node names** below, because later expressions refer to nodes by name.

### 0. Credentials (one time)

| Credential name | Type | Settings |
|---|---|---|
| `Onboard Webhook Secret` | Header Auth | **Name:** `X-Onboard-Secret` · **Value:** the same `ONBOARD_WEBHOOK_SECRET` as in `apps/web/.env.local` |
| `Supabase - Signup-to-Kickoff` | Postgres | Already set up: Supabase **session pooler** host/port/user, SSL on. Do not use the direct (IPv6-only) host. |

> **Header Auth gotcha:** n8n compares the credential's inner **Name** field against the request
> header, so it must be exactly `X-Onboard-Secret`. The credential's label (`Onboard Webhook Secret`
> above) is only a display name and can be anything. If Name is wrong, every call gets 401/403
> even when the secret value is right.

### 1. `Webhook`

- **HTTP Method:** `POST`
- **Path:** `onboard`
- **Authentication:** `Header Auth` → credential `Onboard Webhook Secret`
- **Respond:** `Using 'Respond to Webhook' Node`

The production URL is `{N8N_BASE_URL}/webhook/onboard`. It only works while the workflow is
**active**. Before then, use `/webhook-test/onboard` with "Listen for test event".

### 2. `Insert client + run` (Postgres)

- **Credential:** `Supabase - Signup-to-Kickoff`
- **Operation:** `Execute Query`
- **Query:**

```sql
-- One atomic statement: create the client and its run, or nothing at all.
-- On a duplicate submission_id the insert does nothing and zero rows are returned.
with new_client as (
  insert into public.clients
    (submission_id, company_name, contact_name, contact_email, service_tier, intake_raw)
  values
    ($1::uuid, $2, $3, $4, $5, $6::jsonb)
  on conflict (submission_id) do nothing
  returning id
),
new_run as (
  insert into public.onboarding_runs (client_id, status, n8n_execution_id)
  select id, 'received', $7
  from new_client
  returning id
)
select id as run_id from new_run;
```

- **Options → Add option → Query Parameters**: switch the field to **Expression** and paste this one
  expression. It returns an array, so commas inside the JSON can't split the parameters:

```
{{ [
  $json.body.submission_id,
  $json.body.company_name,
  $json.body.contact_name,
  $json.body.contact_email,
  $json.body.service_tier,
  JSON.stringify($json.body),
  $execution.id
] }}
```

`$6` is `intake_raw`: the full validated payload. The website has already removed `turnstile_token`.
`$7` records the n8n execution id on the run, for tracing.

- **Settings tab → Always Output Data: ON.** Without this, a duplicate (zero rows) would stop the
  workflow before the IF node.

> Never build this query with `{{ }}` inside the SQL text. Values must go through Query Parameters.

### 3. `New run?` (IF)

- **Condition:** String → `{{ $json.run_id }}` → **is not empty**
- `true` → step 4, `false` → step 5.

On a duplicate, "Always Output Data" emits one empty item, so `run_id` is empty and the `false`
branch runs.

### 4. `New Run Created` (Respond to Webhook), on the true branch

- **Respond With:** `JSON`
- **Response Body:** switch the field to **Expression** (not Fixed), then enter:
  `{{ { ok: true, duplicate: false, run_id: $json.run_id } }}`
  In Fixed mode n8n sends the text literally, so `run_id` is never filled in and the website
  returns 502.
- **Options → Response Code:** `202`

### 5. `Find existing run` (Postgres), on the false branch

- **Credential:** `Supabase - Signup-to-Kickoff` · **Operation:** `Execute Query`
- **Query:**

```sql
select r.id as run_id
from public.onboarding_runs r
join public.clients c on c.id = r.client_id
where c.submission_id = $1::uuid
order by r.started_at
limit 1;
```

- **Options → Query Parameters** (Expression):
  `{{ [ $('Webhook').first().json.body.submission_id ] }}`
  Read it from `Webhook`, because the incoming item here is the empty one. Use `.first()`, **not**
  `.item`: the empty item that "Always Output Data" creates has no paired-item link back to the
  Webhook, so `.item` fails ("Paired item data … unavailable"). The webhook only ever carries one
  item, so `.first()` is always the right one.
- Leave **Always Output Data OFF**. If no row is found (which shouldn't happen), the workflow ends
  without a valid response, and the website returns `502` instead of a fake success.

### 6. `Reply: Duplicate, Existing Run` (Respond to Webhook)

- **Respond With:** `JSON`
- **Response Body:** **Expression** mode (not Fixed), as in step 4:
  `{{ { ok: true, duplicate: true, run_id: $json.run_id } }}`
- **Options → Response Code:** `200`

### Why this is safe under concurrency

Two simultaneous requests with the same `submission_id` cannot both create a run. The second
insert waits on the unique index, then `do nothing` applies once the first one commits. The client
and the run are written in one statement, so there is never a client without a run.

### Verify

Replace `<secret>` and use your real `N8N_BASE_URL`. Send the same body twice:

```bash
BODY='{"submission_id":"3f6b2a52-8c1d-4e7a-9b0f-2d4c6e8a1b3c","company_name":"Acme Robotics","contact_name":"Jordan Lee","contact_email":"jordan@acme.example","service_tier":"growth","project_description":"We need a marketing site and a customer portal.","budget_range":"15k_50k","timeline":"1_3_months"}'

curl -i -X POST "$N8N_BASE_URL/webhook/onboard" \
  -H "Content-Type: application/json" -H "ngrok-skip-browser-warning: true" \
  -H "X-Onboard-Secret: <secret>" -d "$BODY"
# 1st call → HTTP 202 {"ok":true,"duplicate":false,"run_id":"..."}
# 2nd call → HTTP 200 {"ok":true,"duplicate":true,"run_id":"<same id>"}
# Wrong secret → 401/403 (the website turns this into 502)
```

Then, in the Supabase SQL editor:

```sql
select c.submission_id, count(r.id) as runs
from public.clients c join public.onboarding_runs r on r.client_id = c.id
group by c.submission_id having count(r.id) > 1;   -- must return no rows
```

End to end: open `/onboard`, submit, and you get a confirmation with the `run_id`. Then replay the
same request (DevTools → Network → right-click → "Copy as fetch", run it in the console). It returns
`200` with `duplicate: true` and the same `run_id`. That is the Phase 2 done criterion. The replay
only works with Cloudflare's always-pass **test** keys (the defaults in `.env.example`). With real
keys a Turnstile token is single-use, so a replay gets `403`. In that case, check deduplication with
the curl test above.

Clean up test rows afterwards: `delete from public.clients where submission_id = '3f6b2a52-8c1d-4e7a-9b0f-2d4c6e8a1b3c';`
(this cascades to the runs).

### Troubleshooting

| Symptom on the website | Likely cause |
|---|---|
| "temporarily unavailable" (503) | ngrok not running, or n8n down; the server log shows `ngrok ERR_NGROK_…` or `timed out` |
| "Something went wrong" (502), log shows `HTTP 401`/`403` | Header Auth credential's inner **Name** isn't exactly `X-Onboard-Secret`, or its Value ≠ `ONBOARD_WEBHOOK_SECRET` |
| 502, log shows `HTTP 404` | Workflow not active, or path isn't `onboard` |
| 502, log shows a body with a literal `{{ … }}` or no `run_id` | A reply node's Response Body is in Fixed mode; switch it to Expression |
| 502, log shows `HTTP 200` with some other body | A reply node's body or status is wrong, or "Always Output Data" is off on `Insert client + run` |
| Duplicate submit fails in n8n with "Paired item data … unavailable" | `Find existing run` uses `$('Webhook').item`; change it to `$('Webhook').first()` |
| Replaying a request in the console returns 403 | Expected with real Turnstile keys: tokens are single-use. Use the test keys or the curl check. |
