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

## WF-01 continued: Phase 3 enrichment

After `New Run Created` replies 202, the same execution carries on. Haiku 4.5 analyzes the intake,
the output is validated, and the result is saved. The website already has its answer at this point,
so Haiku's latency never counts against the website's 10 s timeout.

```
New Run Created ─▶ Mark enriching ─▶ Call Haiku ─▶ Validate output ─▶ Output valid? ─ true ──────────────────────────────────────────────────▶ Save enrichment
                                                                                  └ false ─▶ Call Haiku (retry) ─▶ Validate output (retry) ─▶ Retry valid? ─ true ─▶ Save enrichment
                                                                                                                                                         └ false ─▶ Mark failed
```

Haiku gets one automatic second try when its first output fails validation. Only a second failure
marks the run failed. The retry is a plain copy of the first chain, so the canvas reads left to
right with no loop.

Files used here:

| File | What it is |
|---|---|
| `n8n/prompts/intake-enrichment.system.md` | Haiku system prompt (rules, risk rubric, language rule, email rules) |
| `n8n/prompts/intake-enrichment.schema.json` | JSON Schema for the tool input, with every length and count limit; the source of truth for the output shape |
| `n8n/snippets/build-haiku-request.mjs` | Prints the `Call Haiku` body expression with the prompt and the strict tool schema inlined |
| `n8n/snippets/validate-enrichment.js` | The script for both `Validate output` Code nodes: validation plus business rules |
| `n8n/samples/intake-{low,medium,high}.json` | Test intakes (see Test below) |

Rules carried over from Phase 2: read earlier data with `$('Webhook').first()` /
`$('Insert client + run').first()` (never `.item`), and switch **every** field that contains `{{ }}`
to **Expression** mode.

### 0. Credential: Anthropic (one time)

Credentials → Create → **Anthropic**: paste your Anthropic API key (`sk-ant-…`). Give it any label,
for example `Anthropic - Signup-to-Kickoff`. n8n sends it as the `x-api-key` header.

A **Header Auth** credential works too: **Name** `x-api-key` (exact, lowercase), **Value** the key.
In that case, use `Generic Credential Type` → `Header Auth` in step 2 instead.

### 1. `Mark enriching` (Postgres): connect from `New Run Created`

- **Credential:** `Supabase - Signup-to-Kickoff` · **Operation:** `Execute Query`
- **Query:**

```sql
-- Move the run to 'enriching' and open the enrich_with_ai step, in one statement.
-- Only a 'received' run can start; a step that already succeeded is never reopened.
with run as (
  update public.onboarding_runs
     set status = 'enriching'
   where id = $1::uuid
     and status = 'received'
     and not exists (
       select 1 from public.run_steps
        where run_id = $1::uuid and step_name = 'enrich_with_ai' and status = 'succeeded'
     )
  returning id
)
insert into public.run_steps (run_id, step_name, status, attempt)
select id, 'enrich_with_ai', 'started', 1
from run
on conflict (run_id, step_name) do update
   set status      = 'started',
       attempt     = public.run_steps.attempt + 1,
       error       = null,
       output      = null,
       duration_ms = null,
       created_at  = now()
 where public.run_steps.status <> 'succeeded'
returning run_id, attempt, created_at as started_at;
```

- **Options → Query Parameters** (Expression): `{{ [ $('Insert client + run').first().json.run_id ] }}`
- Leave **Always Output Data OFF**. Zero rows means the run wasn't `received` or the step already
  succeeded, and the branch should stop there, before spending a Haiku call.

### 2. `Call Haiku` (HTTP Request)

- **Method:** `POST` · **URL:** `https://api.anthropic.com/v1/messages`
- **Authentication:** `Predefined Credential Type` → **Credential Type:** `Anthropic` → your credential
- **Send Headers:** ON → `anthropic-version` = `2023-06-01` (Fixed mode). That is the only header
  to add. Strict tool use is generally available, so it needs no `anthropic-beta` header.
  `x-api-key` comes from the credential, and `content-type` from the JSON body.
- **Send Body:** ON → **Body Content Type:** `JSON` → **Specify Body:** `Using JSON`
- **JSON:** switch the field to **Expression**, then paste the output of:

```bash
node n8n/snippets/build-haiku-request.mjs | clip     # Windows; copies it to the clipboard
```

  The pasted expression has this shape. The generator inlines `system` from the prompt file and
  `input_schema` from the schema file, minus the keywords strict mode rejects:

```
{{ JSON.stringify({
  model: "claude-haiku-4-5",
  max_tokens: 2000,
  temperature: 0.2,
  system: "<intake-enrichment.system.md as a JSON string>",
  tools: [{
    name: "record_intake_analysis",
    description: "Record the structured analysis of one Northpeak Studio project intake. Call exactly once.",
    strict: true,
    input_schema: <intake-enrichment.schema.json without minLength, maxLength, maxItems, minItems above 1>
  }],
  tool_choice: { type: "tool", name: "record_intake_analysis" },
  messages: [{
    role: "user",
    content: "<intake>\n" + JSON.stringify({
    company_name: $('Webhook').first().json.body.company_name,
    contact_name: $('Webhook').first().json.body.contact_name,
    service_tier: $('Webhook').first().json.body.service_tier,
    website: $('Webhook').first().json.body.website ?? null,
    project_description: $('Webhook').first().json.body.project_description,
    budget_range: $('Webhook').first().json.body.budget_range,
    timeline: $('Webhook').first().json.body.timeline,
    }, null, 2).replace(/</g, "\\u003c") + "\n</intake>"
  }]
}) }}
```

  Don't assemble this by hand. The generator escapes the prompt correctly and lays the schema out
  so that no `}}` appears inside the expression, which n8n would read as the end of it. Re-run it
  and re-paste whenever the prompt or schema changes.

- **Options → Timeout:** `30000`
- **Settings tab:** **Retry On Fail** ON, **Max Tries** `2`, **Wait Between Tries (ms)** `2000`.
  **On Error:** `Continue` (the plain option, not "using error output"). A call that still fails
  then reaches `Validate output` as an `{ error }` item and is recorded as a failed step, so the run
  is never left stuck in `enriching`.

Why it's built this way:
- **Forced tool:** `tool_choice` forces a `record_intake_analysis` call, so the answer comes back as
  `content[].input` JSON, not prose.
- **Strict tool use:** `strict: true` makes the API constrain Haiku's output to the tool schema. So
  required fields are always present, `welcome_email` is always an object, and no extra keys like
  `goal1` appear. Strict mode rejects `minLength`, `maxLength`, `maxItems` and `minItems` above 1
  with a 400, so the generator drops those from the **tool** schema only. The schema file keeps
  every limit, and `Validate output` enforces them.
- **`max_tokens: 2000`:** raised from 1500 to leave room for non-English output, which takes more
  tokens for the same text.
- **Intake data:** `contact_email` and `submission_id` are not sent to the model. Any `<` in the
  intake is escaped as `<`, so the intake can't close its `<intake>` tag.
- **API version:** `temperature: 0.2` is accepted under `anthropic-version: 2023-06-01`. If this
  call is ever moved to `anthropic-version: 2026-10-21`, remove `temperature`, because that version
  rejects it with a 400.

### 3. `Validate output` (Code)

- **Mode:** `Run Once for All Items` · **Language:** `JavaScript`
- **Code:** paste all of `n8n/snippets/validate-enrichment.js`.

It outputs `{ valid: true, data, attempt, step_output }` or
`{ valid: false, errors: [...], attempt, step_output }`. A schema violation, a missing tool call,
`stop_reason` `max_tokens`/`refusal`, and an API error all become `valid: false` with readable
errors. Its embedded schema is tested against the schema file (`npm run test:n8n`), so if you edit
the schema, update the snippet too and re-paste it.

After validation passes, the script applies **business rules in code**, so they never depend on the
prompt being followed:

- `service_tier = enterprise` → `risk_level = high` (never lower).
- `data.ai_risk_level` always holds Haiku's own verdict. `data.rule_overrides` lists each rule that
  changed it, for example `["enterprise_tier_high"]`, or is `[]` when none did.

The script finds the tier with `$('Webhook').first()`. It tells the first call from the retry by
the node its input came from (`$prevNode`), so the node names in steps 4–5 must match exactly.

### 4. `Output valid?` (IF)

- **Condition:** Boolean → `{{ $json.valid }}` → **is true**
- `true` → step 6 (`Save enrichment`), `false` → step 5 (`Call Haiku (retry)`).

### 5. The retry chain: `Call Haiku (retry)` → `Validate output (retry)` → `Retry valid?`

1. Select `Call Haiku` and `Validate output` on the canvas, then copy and paste them (Ctrl+C,
   Ctrl+V). The copies keep every setting: body, credential, headers, timeout, Retry On Fail,
   On Error `Continue`, and the script.
2. Rename the copies to exactly `Call Haiku (retry)` and `Validate output (retry)`. The script
   matches the first name to report `attempt: 2`. It reads the first attempt's errors from the node
   named exactly `Validate output`, so leave the original's name as it is.
3. Connect `Output valid?` **false** → `Call Haiku (retry)` → `Validate output (retry)`. The pasted
   copies arrive already connected to each other; check that this link is there.
4. Add an **IF** after `Validate output (retry)`, named `Retry valid?`, with the same condition:
   `{{ $json.valid }}` **is true**.
5. Connect `Retry valid?` **true** → `Save enrichment` (it now has two incoming links) and
   **false** → `Mark failed`. Delete the old `Output valid?` false → `Mark failed` link.

The retry sends the same request. The body reads the intake from `$('Webhook').first()`, not from
`$json`, so it doesn't depend on what came before it. Haiku is sampled at `temperature: 0.2`, so a
second call usually gives different output, and most one-off slips pass on the retry.

### 6. `Save enrichment` (Postgres), from `Output valid?` true and `Retry valid?` true

(Your canvas names this node `Save Enrichment`; the name doesn't matter here.)

- **Credential:** `Supabase - Signup-to-Kickoff` · **Operation:** `Execute Query`
- **Query:**

```sql
-- Store the analysis on the client and close the step, in one statement.
-- Run status stays 'enriching'; Phase 4 moves it on to approval.
-- attempt counts Haiku tries: Mark enriching opened it at n, the retry adds 1.
with saved as (
  update public.clients
     set intake_ai  = $2::jsonb,
         risk_level = $3
   where id = (select client_id from public.onboarding_runs where id = $1::uuid)
  returning id
)
update public.run_steps
   set status      = 'succeeded',
       attempt     = attempt + ($5::int - 1),
       duration_ms = (extract(epoch from (now() - created_at)) * 1000)::int,
       output      = $4::jsonb,
       error       = null
 where run_id = $1::uuid
   and step_name = 'enrich_with_ai'
returning run_id, status, attempt, duration_ms;
```

- **Options → Query Parameters** (Expression):

```
{{ [
  $('Insert client + run').first().json.run_id,
  JSON.stringify($json.data),
  $json.data.risk_level,
  JSON.stringify($json.step_output),
  $json.attempt
] }}
```

`$json` is whichever `Validate output` node fed this one. `data` already has the business rules
applied, so `clients.risk_level` and `intake_ai` store the final level, with `ai_risk_level` and
`rule_overrides` alongside. `step_output` holds `{ summary, risk_level, ai_risk_level,
rule_overrides, ai_attempts }`, plus `first_attempt_errors` after a retry.

### 7. `Mark failed` (Postgres), from `Retry valid?` false

- **Credential:** `Supabase - Signup-to-Kickoff` · **Operation:** `Execute Query`
- **Query:**

```sql
-- Fail the step and the run together, with the validation errors on both.
with step as (
  update public.run_steps
     set status      = 'failed',
         attempt     = attempt + ($4::int - 1),
         duration_ms = (extract(epoch from (now() - created_at)) * 1000)::int,
         error       = $2,
         output      = $3::jsonb
   where run_id = $1::uuid
     and step_name = 'enrich_with_ai'
  returning run_id
)
update public.onboarding_runs
   set status      = 'failed',
       error       = $2,
       finished_at = now()
 where id = $1::uuid
returning id as run_id, status;
```

- **Options → Query Parameters** (Expression):

```
{{ [
  $('Insert client + run').first().json.run_id,
  ('enrich_with_ai: ' + $json.errors.join('; ')).slice(0, 1000),
  JSON.stringify($json.step_output),
  $json.attempt
] }}
```

`error` holds the second attempt's errors. `output` holds `{ errors, ai_attempts: 2,
first_attempt_errors }`, so both attempts can be read later.

Save the workflow. It stays active, so the next production submission runs the new branch.

### Test

Send the three sample intakes from PowerShell 7, each with a fresh `submission_id`. Fill in your
secret and ngrok domain, and run from the repo root:

```powershell
$secret  = "<ONBOARD_WEBHOOK_SECRET>"
$url     = "https://<your-subdomain>.ngrok-free.dev/webhook/onboard"
$headers = @{ "X-Onboard-Secret" = $secret; "ngrok-skip-browser-warning" = "true" }
foreach ($name in "low", "medium", "high") {
  $intake = Get-Content "n8n/samples/intake-$name.json" -Raw | ConvertFrom-Json
  $intake.submission_id = [guid]::NewGuid().ToString()
  $r = Invoke-WebRequest -Method Post -Uri $url -Headers $headers -ContentType "application/json" `
         -Body ($intake | ConvertTo-Json) -SkipHttpErrorCheck
  "$name -> HTTP $($r.StatusCode) $($r.Content)"
}
```

Each call should return `202` straight away. Give Haiku a few seconds, then check in the Supabase SQL editor:

```sql
select c.company_name,
       c.risk_level,
       r.status                       as run_status,
       s.status                       as step_status,
       s.duration_ms,
       c.intake_ai ->> 'risk_reason'  as risk_reason,
       c.intake_ai -> 'risk_flags'    as risk_flags,
       s.error
from public.clients c
join public.onboarding_runs r on r.client_id = c.id
left join public.run_steps s on s.run_id = r.id and s.step_name = 'enrich_with_ai'
order by r.started_at desc
limit 3;
```

| Sample | What it tests | Expected `risk_level` |
|---|---|---|
| `intake-low.json`: Harbor & Pine Dental | Clear 8-page redesign + booking + local SEO, growth tier, $15k–50k, 3–6 months | `low` |
| `intake-medium.json`: Fernway Coffee Roasters | Simple site is clear, but "sell beans online at some point, maybe a subscription, not sure" is an open gap | `medium` |
| `intake-high.json`: NextGen Holdings | Enterprise tier, "Uber + Airbnb" web + mobile with AI and crypto, under $5k, asap, **plus a prompt-injection attempt** | `high` |

For every row, `run_status` should be `enriching`, `step_status` `succeeded`, and `duration_ms` filled
in. Also read the high-risk email: it must **not** contain "$3,000", any price, or a date, and
`risk_flags` should include the injection flag:

```sql
select c.intake_ai -> 'welcome_email' ->> 'body' as email
from public.clients c where c.company_name = 'NextGen Holdings'
order by c.created_at desc limit 1;
```

Haiku isn't deterministic. If `medium` occasionally lands on `low` or `high`, read `risk_reason`
before changing the prompt. Re-run 2–3 times, and only tune the rubric if the miss repeats. The
`low` and `high` samples should be stable.

**Failure branch:** set `max_tokens` to `50` in **both** `Call Haiku` nodes, then send one sample.
The row should show `step_status = failed`, `attempt = 2`, `run_status = failed`, and `error`
starting with `enrich_with_ai: Response was cut off`. Re-paste the generator output into both
afterwards.

**Retry branch:** set `max_tokens` to `50` in `Call Haiku` only, and send one sample. The step
should succeed with `attempt = 2`, and `output -> 'first_attempt_errors'` should mention
`Response was cut off`. Re-paste afterwards.

#### Phase 3 fix re-test

Submit each of these through `/onboard`, then run the query below.

| # | Client | Expected | What it checks |
|---|---|---|---|
| 1 | Bloom & Basil Florist | `low` | Unchanged behaviour |
| 2 | Summit Physical Therapy | `medium` | Unchanged behaviour |
| 3 | Vertex Commerce Group | `high`, `succeeded` | Strict mode: no structure failures on a complex intake |
| 4 | Test Corp (injection) | `high`, injection flagged, clean email | Injection handling unchanged |
| 5 | Meridian Health Network (enterprise) | `high` | Enterprise rule. If Haiku said otherwise: `ai_risk_level` ≠ `high` and `rule_overrides = ["enterprise_tier_high"]` |
| 6 | Sari-Sari Hub PH (Filipino) | `low`, all text in Filipino | Language rule, including `risk_reason` and `risk_flags` |
| 7 | Bright Ideas Co (vague) | `high`, `risk_reason` names vague scope | Rubric: any high-risk condition means high |

```sql
select c.company_name,
       c.service_tier,
       c.risk_level,
       c.intake_ai ->> 'ai_risk_level'  as ai_risk_level,
       c.intake_ai -> 'rule_overrides'  as rule_overrides,
       r.status                         as run_status,
       s.status                         as step_status,
       s.attempt,
       s.output -> 'first_attempt_errors' as first_attempt_errors,
       c.intake_ai ->> 'risk_reason'    as risk_reason,
       s.error
from public.clients c
join public.onboarding_runs r on r.client_id = c.id
left join public.run_steps s on s.run_id = r.id and s.step_name = 'enrich_with_ai'
order by r.started_at desc
limit 7;
```

Every row should have `step_status = succeeded`. `attempt = 2` is acceptable (the retry did its
job), but if the same client keeps needing it, look at `first_attempt_errors`. For #6, also read
the email and agenda:
`select intake_ai from public.clients where company_name = 'Sari-Sari Hub PH' order by created_at desc limit 1;`

Clean up test rows (this cascades to the runs and steps):
`delete from public.clients where company_name in ('Harbor & Pine Dental', 'Fernway Coffee Roasters', 'NextGen Holdings');`

### Troubleshooting

| Symptom | Likely cause |
|---|---|
| Run stays `received`, with no `run_steps` row | `Mark enriching` isn't connected after `New Run Created`, or the workflow wasn't saved |
| `Mark enriching` returns 0 rows | Expected for a run that isn't `received` or a step that already succeeded. Otherwise check that the parameter reads `$('Insert client + run').first()` |
| Step `failed`, error `Anthropic API call failed: … 401` | The Anthropic credential's key is wrong or revoked (with Header Auth: Name isn't exactly `x-api-key`) |
| Error `… 400` mentioning the schema, `minLength`, `maxItems` or `minItems` | The tool schema still has a keyword strict mode rejects. Re-paste the generator output; don't paste the schema file by hand |
| Error `… 400 Schema is too complex for compilation` | The schema grew past strict mode's limits. Simplify it, or set `strict` back to `false` temporarily |
| A retried step shows `attempt` 1, or no `first_attempt_errors` | The copied nodes aren't named exactly `Call Haiku (retry)` / `Validate output`. Rename them |
| Error `Could not read the intake from the Webhook node` | The trigger node was renamed. It must be called `Webhook` |
| Enterprise run saved below `high` | `Validate output` has the old script. Re-paste `validate-enrichment.js` into **both** Code nodes |
| Error `… 400` mentioning `temperature` | The call was moved to `anthropic-version: 2026-10-21`; set it back to `2023-06-01` or remove `temperature` |
| Error `… 400` invalid request / JSON | The body field is in Fixed mode, or a hand-edited expression broke. Re-paste the generator output in Expression mode |
| Error `… 429` or `… 529 overloaded` after 2 tries | Rate-limited or overloaded. Both are temporary; re-send the intake (a fresh `submission_id`), or raise Max Tries |
| Error `… timeout` | Haiku took longer than 30 s. Rare at 2000 tokens; check Anthropic status |
| Error `Response was cut off (stop_reason=max_tokens)` | `max_tokens` too low for the output; keep it at 2000 in both `Call Haiku` nodes |
| Error `No record_intake_analysis tool call` | `tool_choice` missing or the tool name was changed; re-paste the generator output |
| Errors like `welcome_email.body: must be at least 400 characters` | Haiku broke a schema rule. One-off: re-send. Repeated: tighten the prompt for that field |
| `Validate output` fails with `$input is not defined` / `SyntaxError` | Code node isn't in "Run Once for All Items" JavaScript mode, or the paste was partial |
| `Save enrichment` errors `invalid input syntax for type json` | A Query Parameters field is in Fixed mode, so the `{{ }}` text was sent literally |
| Duplicate submit triggers Haiku | `Mark enriching` was connected after the duplicate reply instead of `New Run Created` |
