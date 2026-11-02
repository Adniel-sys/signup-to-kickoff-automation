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

## Phase 4: approval gate (WF-01 hand-off + WF-02 Approval Gate)

Low-risk runs are approved automatically. Every other run waits for a human in the website's
`/admin` dashboard, with a Slack alert that links to it. If nobody decides within 48 hours, the run
is rejected with the reason "approval timed out".

**The database holds the state; workflows are short event handlers.** There is no Wait node
anywhere: no n8n execution stays paused while a run waits. WF-01 is finished (Phases 2–3) and
gets only one new node. All Phase 4 logic is in one new workflow, **WF-02 Approval Gate**, with
three entry points:

```
WF-01  … Save Enrichment ─▶ Start approval (Execute Workflow → WF-02, don't wait)

WF-02  Entry 1  When Executed by Another Workflow (run_id)
                  ─▶ Load run ─▶ Needs approval? ─ false ─▶ Mark auto-approved                 ◀ Phase 5: Execute Workflow → WF-03
                                                 └ true ──▶ Mark awaiting approval ─▶ Slack alert

       Entry 2  Webhook POST /approval (from /api/approve)
                  ─▶ Validate request ─▶ Valid? ─ true ─▶ Record decision ─▶ Recorded? ─ true ─▶ Reply: Recorded (200) ─▶ Slack decision alert   ◀ Phase 5: if approved, Execute Workflow → WF-03
                                               │                                      └ false ─▶ Reply: Not awaiting (409)
                                               └ false ─▶ Reply: Invalid (400)

       Entry 3  Schedule, every 15 minutes
                  ─▶ Reject timed-out runs ─▶ Slack timeout alert
```

| Workflow | Trigger | Status |
|---|---|---|
| WF-01 Intake & Enrichment | Webhook `/webhook/onboard` | Done (Phases 2–3) + `Start approval` |
| WF-02 Approval Gate | The 3 triggers above | Phase 4 |
| WF-03 Provisioning | Sub-workflow, called by WF-02 on approval | Phase 5 |
| WF-04 Error Handler | Error Trigger | Phase 6 |

**Auto-approve** only when `risk_level = 'low'` **and** `service_tier <> 'enterprise'`. Phase 3's
business rule already makes enterprise runs high, so the tier check here is a second guard.

Website files for this phase:

| File | What it is |
|---|---|
| `apps/web/proxy.ts` | Refreshes the Supabase session; redirects signed-out `/admin` visits to `/login` |
| `apps/web/lib/server/auth.ts` | Server-side session check used by every admin page and `/api/approve` |
| `apps/web/app/login/` | Email + password sign-in |
| `apps/web/app/admin/` | Approval queue, recent runs, run detail with Approve / Reject |
| `apps/web/app/api/approve/route.ts` | Sends the decision to WF-02 entry 2 (contract: `docs/api-contract.md` §4–6) |

No migration is needed. The decision goes in the `approval` step's `run_steps.output`, and a
rejection reason in `onboarding_runs.error`. `onboarding_runs.resume_url` is **unused**: it stays
`NULL`. The column is kept so the schema doesn't change.

Same rules as before: read earlier data with `$('Node').first()`, never `.item`, and switch
**every** field that contains `{{ }}` to **Expression** mode. Values go into SQL only through
Query Parameters, never with `{{ }}` inside the query text.

### 0. One-time setup

**A. Supabase Auth** (Dashboard → Authentication):

- **Sign In / Providers → Email:** enabled.
- **Allow new users to sign up:** OFF. Every signed-in user is treated as an admin, so this must
  stay off.
- **Users:** your admin user exists and is confirmed (no "Waiting for verification" label).

**B. Slack incoming webhook** (free workspace):

1. Create a workspace at <https://slack.com/get-started> if you don't have one, and a channel
   such as `#onboarding`.
2. Go to <https://api.slack.com/apps> → **Create New App** → **From scratch**. Name it
   `Northpeak Onboarding` and pick your workspace.
3. **Incoming Webhooks** → switch **Activate Incoming Webhooks** ON → **Add New Webhook** → pick
   `#onboarding` → **Allow**.
4. Copy the webhook URL (`https://hooks.slack.com/services/T…/B…/…`).

Treat the webhook URL as a secret: anyone who has it can post to your channel. It lives only in
WF-02's `Slack alert`, `Slack decision alert` and `Slack timeout alert` nodes. **Scrub it from workflow exports**
before committing them (replace it with `https://hooks.slack.com/services/REPLACE_ME`).

**C. Dashboard base URL.** Slack messages link to `{DASHBOARD_URL}/admin/runs/{run_id}`. For now
that's `http://localhost:3000`, typed into the Slack nodes' bodies. When the site is deployed
in Phase 6, replace it there with the Vercel URL.

### Part A: WF-01, one new node

WF-01 is otherwise unchanged. Build WF-02 (Part B) first, so you can pick it here.

#### A.1 `Start approval` (Execute Workflow): connect from `Save Enrichment`

- **Source:** `Database` · **Workflow:** `From list` → `WF-02 Approval Gate`
- **Workflow Inputs:** `run_id` = (Expression) `{{ $('Insert client + run').first().json.run_id }}`
  (the field appears once WF-02's entry-1 trigger defines it, E1.1)
- **Mode:** `Run once with all items`
- **Options → Wait For Sub-Workflow Completion:** **OFF**. WF-01 hands the run over and ends; WF-02
  runs as its own execution.

`Save Enrichment` returns one row when it saved, and zero rows otherwise, so `Start approval` only
runs after a successful enrichment. Save WF-01; it stays active.

### Part B: WF-02 Approval Gate (new workflow)

Create a new workflow named `WF-02 Approval Gate`. It holds three separate triggers on one
canvas; each starts its own short execution. **Activate** it when all three entries are built:
the webhook and the schedule only run while it is active.

### Entry 1: route a new run

#### E1.1 `When Executed by Another Workflow` (trigger)

- **Input data mode:** `Define using fields below`
- **Field:** name `run_id`, type `String`

#### E1.2 `Load run` (Postgres)

- **Credential:** `Supabase - Signup-to-Kickoff` · **Operation:** `Execute Query`
- **Query:**

```sql
-- What routing needs, plus what the Slack alert shows. Zero rows unless the run is
-- still 'enriching', so a repeated call does nothing.
select r.id                          as run_id,
       r.status,
       c.company_name,
       c.service_tier,
       c.risk_level,
       c.intake_ai ->> 'risk_reason' as risk_reason
from public.onboarding_runs r
join public.clients c on c.id = r.client_id
where r.id = $1::uuid
  and r.status = 'enriching';
```

- **Options → Query Parameters** (Expression): `{{ [ $json.run_id ] }}`
- Leave **Always Output Data OFF**: zero rows ends entry 1.

`risk_level` is the value Phase 3 saved, after its business rules.

#### E1.3 `Needs approval?` (IF)

- **Condition:** Boolean → `{{ $json.risk_level !== 'low' || $json.service_tier === 'enterprise' }}` → **is true**
- `true` → E1.5 (manual), `false` → E1.4 (auto).

A missing `risk_level` (`null`) counts as "not low", so it goes to a human.

#### E1.4 `Mark auto-approved` (Postgres), on the false branch

- **Credential:** `Supabase - Signup-to-Kickoff` · **Operation:** `Execute Query`
- **Query:**

```sql
-- Auto path: approve the run and record the approval step, in one statement.
-- Only from 'enriching', so a re-run can never approve twice.
with run as (
  update public.onboarding_runs
     set status        = 'approved',
         approval_mode = 'auto',
         approved_by   = 'system',
         approved_at   = now()
   where id = $1::uuid
     and status = 'enriching'
  returning id
)
insert into public.run_steps (run_id, step_name, status, duration_ms, output)
select id, 'approval', 'succeeded', 0, '{"mode": "auto"}'::jsonb
from run
on conflict (run_id, step_name) do update
   set status      = 'succeeded',
       duration_ms = 0,
       output      = excluded.output,
       error       = null
returning run_id, status;
```

- **Options → Query Parameters** (Expression): `{{ [ $('Load run').first().json.run_id ] }}`
- Leave **Always Output Data OFF**: zero rows means the run wasn't `enriching`, and nothing after
  this node may run.

> **Phase 5 attachment point.** Phase 5 connects `Mark auto-approved` → **Execute Workflow →
> WF-03 Provisioning**. Add a sticky note on the canvas here so the spot is obvious. Nothing is
> connected after it in Phase 4.

#### E1.5 `Mark awaiting approval` (Postgres), on the true branch

- **Credential:** `Supabase - Signup-to-Kickoff` · **Operation:** `Execute Query`
- **Query:**

```sql
-- Manual path: park the run and open its approval step. Only from 'enriching'.
-- It also returns what the Slack alert shows. resume_url is not used and stays NULL.
with run as (
  update public.onboarding_runs
     set status        = 'awaiting_approval',
         approval_mode = 'manual'
   where id = $1::uuid
     and status = 'enriching'
  returning id, client_id
),
step as (
  insert into public.run_steps (run_id, step_name, status)
  select id, 'approval', 'started'
  from run
  on conflict (run_id, step_name) do update
     set status      = 'started',
         attempt     = public.run_steps.attempt + 1,
         error       = null,
         output      = null,
         duration_ms = null,
         created_at  = now()
  returning run_id, created_at
)
select step.run_id,
       step.created_at                 as waiting_since,
       c.company_name,
       c.service_tier,
       c.risk_level,
       c.intake_ai ->> 'risk_reason'   as risk_reason
from step
join run on run.id = step.run_id
join public.clients c on c.id = run.client_id;
```

- **Options → Query Parameters** (Expression): `{{ [ $('Load run').first().json.run_id ] }}`
- Leave **Always Output Data OFF**: zero rows stops the branch before Slack.

The `approval` step's `created_at` is when the run started waiting. Entry 3's 48-hour clock and the
dashboard's "waiting for" both read it.

#### E1.6 `Slack alert` (HTTP Request)

- **Method:** `POST` · **URL:** your Slack webhook URL (Fixed mode) · **Authentication:** `None`
- **Send Body:** ON → **Body Content Type:** `JSON` → **Specify Body:** `Using JSON`
- **JSON** (Expression mode):

```
{{ JSON.stringify({
  text: "*Approval needed:* " + $json.company_name.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    + "\nTier: " + $json.service_tier + " · Risk: " + ($json.risk_level ?? "not assessed")
    + "\n> " + ($json.risk_reason ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    + "\n<http://localhost:3000/admin/runs/" + $json.run_id + "|Review in the dashboard>"
}) }}
```

  `$json` is `Mark awaiting approval`'s row. The company name and risk reason come from the
  client's intake, so `&`, `<` and `>` are escaped. Without that, an intake could post Slack
  links or `<!channel>` mentions. `http://localhost:3000` is the dashboard base URL from 0C.

- **Options → Timeout:** `10000`
- **Settings tab:** **On Error:** `Continue` (the plain option). A failed Slack post must never
  block the approval: the run is already `awaiting_approval` and in the dashboard queue.

Entry 1 ends here.

### Entry 2: record a decision

The website calls this from `/api/approve` after checking the admin's session; the contract is
`docs/api-contract.md` §5.

#### E2.1 `Webhook`

- **HTTP Method:** `POST`
- **Path:** `approval`
- **Authentication:** `Header Auth` → credential `Onboard Webhook Secret` (the same one WF-01 uses)
- **Respond:** `Using 'Respond to Webhook' Node`

Body: `{ run_id, decision: 'approve' | 'reject', decided_by, note }`. The production URL is
`{N8N_BASE_URL}/webhook/approval`; it only works while WF-02 is **active**.

#### E2.2 `Validate request` (Code)

- **Mode:** `Run Once for All Items` · **Language:** `JavaScript`
- **Code:** paste the whole of `n8n/snippets/validate-approval.js`.

It outputs `{ valid: true, run_id, decision, decided_by, note }` (note trimmed, blank → `null`) or
`{ valid: false, errors: [...] }`. The rules match the website's (`run_id` is a uuid, `decision` is
approve/reject, a rejection has a note of at least 3 characters, note ≤ 500). This is defense in
depth: the website validates first.

#### E2.3 `Valid?` (IF)

- **Condition:** Boolean → `{{ $json.valid }}` → **is true**
- `true` → E2.5, `false` → E2.4.

#### E2.4 `Reply: Invalid (400)` (Respond to Webhook), on the false branch

- **Respond With:** `JSON`
- **Response Body** (Expression): `{{ { ok: false, error: 'invalid_request', errors: $json.errors } }}`
- **Options → Response Code:** `400`

#### E2.5 `Record decision` (Postgres), on the true branch

- **Credential:** `Supabase - Signup-to-Kickoff` · **Operation:** `Execute Query`
- **Query:**

```sql
-- One atomic statement: record an approve or reject, but only while the run is still
-- awaiting approval. Returns the run's new status and company name (for the Slack decision
-- alert), or zero rows if it wasn't waiting (already decided, timed out, or unknown).
-- Two racing requests can't both win.
with run as (
  update public.onboarding_runs
     set status      = case $2::text when 'approve' then 'approved' else 'rejected' end,
         approved_by = case $2::text when 'approve' then $3::text end,
         approved_at = case $2::text when 'approve' then now() end,
         finished_at = case $2::text when 'reject' then now() end,
         error       = case $2::text when 'reject' then $4::text end
   where id = $1::uuid
     and status = 'awaiting_approval'
     and $2::text in ('approve', 'reject')
  returning id, status, client_id
),
step as (
  insert into public.run_steps (run_id, step_name, status, duration_ms, output)
  select id, 'approval', 'succeeded', 0,
         jsonb_build_object('mode', 'manual', 'decision', $2::text,
                            'decided_by', $3::text, 'note', $4::text)
  from run
  on conflict (run_id, step_name) do update
     set status      = 'succeeded',
         duration_ms = (extract(epoch from (now() - public.run_steps.created_at)) * 1000)::int,
         output      = excluded.output,
         error       = null
  returning run_id
)
select run.id as run_id, run.status, c.company_name
from run
join step on step.run_id = run.id
join public.clients c on c.id = run.client_id;
```

- **Options → Query Parameters** (Expression):

```
{{ [
  $('Validate request').first().json.run_id,
  $('Validate request').first().json.decision,
  $('Validate request').first().json.decided_by,
  $('Validate request').first().json.note
] }}
```

- **Settings tab → Always Output Data: ON.** Zero rows must still reach `Recorded?` so the caller
  gets a `409`, not a timeout.

For a rejection, the note becomes the run's `error` (the reason the dashboard shows). The
`decided_by` of a rejection is kept in the step's output; `approved_by` stays empty. The approval
step ends `succeeded` either way, because a decision was made; the run's status carries the outcome.

#### E2.6 `Recorded?` (IF)

- **Condition:** String → `{{ $json.status ?? '' }}` → **is not empty**
- `true` → E2.7, `false` → E2.9.

On zero rows, "Always Output Data" emits one empty item, so `status` is empty. The `?? ''` keeps
n8n's strict type check from failing on `undefined`.

#### E2.7 `Reply: Recorded (200)` (Respond to Webhook)

- **Respond With:** `JSON`
- **Response Body** (Expression): `{{ { ok: true, run_id: $json.run_id, status: $json.status } }}`
- **Options → Response Code:** `200`

#### E2.8 `Slack decision alert` (HTTP Request): connect from `Reply: Recorded (200)`

Tells the channel the decision was made, so nobody else opens the "Review" link for a run that's
already done.

- **Method:** `POST` · **URL:** your Slack webhook URL (Fixed mode) · **Authentication:** `None`
- **Send Body:** ON → **Body Content Type:** `JSON` → **Specify Body:** `Using JSON`
- **JSON** (Expression mode):

```
{{ (() => {
  const esc = s => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const d = $('Record decision').first().json;
  const v = $('Validate request').first().json;
  const approved = d.status === 'approved';
  return JSON.stringify({
    text: (approved ? "✅ *Approved:* " : "❌ *Rejected:* ") + esc(d.company_name)
      + " · by " + esc(v.decided_by)
      + (v.note ? "\n> " + esc(v.note) : "")
      + "\n<http://localhost:3000/admin/runs/" + d.run_id + "|View in the dashboard>"
  });
})() }}
```

  It reads `Record decision` and `Validate request` by name, not `$json`, because a Respond to
  Webhook node's output isn't guaranteed to be its input. The company name, `decided_by` and the
  note are escaped like the other Slack nodes (`esc`). The note line is left out when there is
  no note (an approval without one); only a note's first line is shown as a quote.

- **Options → Timeout:** `10000`
- **Settings tab:** **On Error:** `Continue`. The decision is already saved and the website already
  has its `200`; a failed Slack post must not mark the execution as failed.

> **Phase 5 attachment point.** Phase 5 connects `Slack decision alert` → an IF on
> `{{ $('Record decision').first().json.status }}` equals `approved` → **Execute Workflow → WF-03
> Provisioning**. It sits **after** the reply so the website gets its answer at once, and after the
> Slack post, which passes an item on even when it fails (On Error: Continue). Add a sticky note
> here. Nothing is connected after it in Phase 4.

#### E2.9 `Reply: Not awaiting (409)` (Respond to Webhook)

- **Respond With:** `JSON`
- **Response Body:** `{"ok": false, "error": "not_awaiting_approval"}`
- **Options → Response Code:** `409`

#### Entry 2 by hand

The website is the normal caller, but you can check WF-02 directly (PowerShell 7, from the repo
root; it reads the secret from `apps/web/.env.local` without printing it). Use the id of a run
that is `awaiting_approval`:

```powershell
$vars = @{}
Get-Content apps/web/.env.local | Where-Object { $_ -match '^\s*(ONBOARD_WEBHOOK_SECRET|N8N_BASE_URL)\s*=' } |
  ForEach-Object { $k, $v = $_ -split '=', 2; $vars[$k.Trim()] = $v.Trim().Trim('"') }
$body = @{ run_id = "<run id>"; decision = "approve"; decided_by = "you@example.com"; note = $null } | ConvertTo-Json
Invoke-WebRequest -Method Post -Uri "$($vars.N8N_BASE_URL)/webhook/approval" -ContentType "application/json" -Body $body `
  -Headers @{ "X-Onboard-Secret" = $vars.ONBOARD_WEBHOOK_SECRET; "ngrok-skip-browser-warning" = "true" } -SkipHttpErrorCheck |
  Select-Object StatusCode, Content
```

The first call returns `200 {"ok":true,…,"status":"approved"}`; the same call again returns `409`.

### Entry 3: time out waiting runs

#### E3.1 `Schedule Trigger`

- **Trigger Interval:** `Minutes` · **Minutes Between Triggers:** `15`

A run can sit up to 15 minutes past its 48 hours before it's rejected. That's fine for a
48-hour window.

#### E3.2 `Reject timed-out runs` (Postgres)

- **Credential:** `Supabase - Signup-to-Kickoff` · **Operation:** `Execute Query`
- **Query:**

```sql
-- Reject every run still awaiting approval whose approval step opened more than $1 ago.
-- Guarded on the run's status, so a decision recorded at the same moment wins cleanly
-- and is never overwritten. Returns one row per rejected run.
with run as (
  update public.onboarding_runs r
     set status      = 'rejected',
         finished_at = now(),
         error       = 'approval timed out'
    from public.run_steps s
   where s.run_id = r.id
     and s.step_name = 'approval'
     and s.status = 'started'
     and s.created_at < now() - $1::interval
     and r.status = 'awaiting_approval'
  returning r.id, r.client_id
),
step as (
  update public.run_steps s
     set status      = 'succeeded',
         duration_ms = (extract(epoch from (now() - s.created_at)) * 1000)::int,
         output      = '{"mode": "timeout", "decision": "reject"}'::jsonb
    from run
   where s.run_id = run.id
     and s.step_name = 'approval'
  returning s.run_id
)
select run.id as run_id, c.company_name
from run
join step on step.run_id = run.id
join public.clients c on c.id = run.client_id
order by c.company_name;
```

- **Options → Query Parameters** (Expression): `{{ [ '48 hours' ] }}` (type it without the
  surrounding backticks; n8n ignores text outside `{{ }}` here, but the field should hold only the expression)
- Leave **Always Output Data OFF**. When nothing timed out, the query returns zero rows and the
  workflow stops here, so Slack is only called when there is something to report.

#### E3.3 `Slack timeout alert` (HTTP Request)

- **Method:** `POST` · **URL:** your Slack webhook URL (Fixed mode) · **Authentication:** `None`
- **Send Body:** ON → **Body Content Type:** `JSON` → **Specify Body:** `Using JSON`
- **JSON** (Expression mode):

```
{{ JSON.stringify({
  text: "*Approval timed out:* no decision within 48 hours, so these runs were rejected:\n"
    + $input.all().map(i => "• <http://localhost:3000/admin/runs/" + i.json.run_id + "|"
        + i.json.company_name.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\|/g, "/")
        + ">").join("\n")
}) }}
```

- **Options → Timeout:** `10000`
- **Settings tab:** **Execute Once:** ON (one message listing every run, not one per run) ·
  **On Error:** `Continue`. The runs are already rejected; a Slack failure changes nothing.

#### Testing the timeout

1. In `Reject timed-out runs`, set Query Parameters to `{{ [ '2 minutes' ] }}`.
2. In `Schedule Trigger`, set **Minutes Between Triggers** to `1`. Save.
3. Submit a medium-risk intake and don't decide. After 3–4 minutes the run is `rejected`.
4. **Restore** `'48 hours'` and `15`, and save. Leaving the test values in would reject real runs
   after 2 minutes.

### Test

Start the website (`npm run dev`) and sign in at <http://localhost:3000/login>. Then:

| # | Test | Steps | Expected |
|---|---|---|---|
| 1 | Signed out is blocked | In a private window open `/admin` and `/admin/runs/<any id>`. Then send a POST to `/api/approve` with no cookie (below) | Both pages redirect to `/login?next=…`; signing in lands back on the page. The POST returns `401` |
| 2 | Low risk: auto-approve | Submit a clear growth-tier intake (e.g. Bloom & Basil Florist) | Run `approved`, `approval_mode = auto`, `approved_by = system`; step `approval` succeeded with `{"mode": "auto"}`; no Slack message; not in the queue. WF-01's execution has finished |
| 3 | Medium: manual approve | Submit Summit Physical Therapy | WF-01 and WF-02's executions both **finish** (nothing paused). A Slack alert with a working "Review" link; the run is in the queue; **Approve** → `approved`, `approved_by` = your email; one WF-02 entry-2 execution; a "✅ Approved" message in Slack |
| 4 | High: manual reject with note | Submit Vertex Commerce Group. Try **Reject** with an empty note first | An empty note is refused in the form. With a note → `rejected`, `error` = your note, `finished_at` set; the page shows "Rejected: <note>"; a "❌ Rejected" message in Slack with the note |
| 5 | Timeout reject | Use the 2-minute test settings (entry 3), submit a medium intake, don't decide | After 3–4 min: `rejected`, `error = approval timed out`, step output `{"mode": "timeout", "decision": "reject"}`, a Slack timeout message. Restore the settings |
| 6 | Double-click approve | Open one waiting run in two tabs. Approve in the first, then approve in the second | The first succeeds; the second shows "no longer waiting" (`409`) and refreshes to `Approved` |

POST without a session (PowerShell 7):

```powershell
Invoke-WebRequest -Method Post -Uri http://localhost:3000/api/approve -ContentType "application/json" `
  -Body '{"run_id":"00000000-0000-4000-8000-000000000000","decision":"approve"}' -SkipHttpErrorCheck |
  Select-Object StatusCode, Content
```

To see WF-02's own `409` (not just the website's pre-check), run "Entry 2 by hand" twice on the
same run.

Check the runs in the Supabase SQL editor:

```sql
select c.company_name,
       c.service_tier,
       c.risk_level,
       r.status,
       r.approval_mode,
       r.approved_by,
       r.error,
       s.status                      as approval_step,
       s.created_at                  as waiting_since,
       s.output                      as approval_output
from public.clients c
join public.onboarding_runs r on r.client_id = c.id
left join public.run_steps s on s.run_id = r.id and s.step_name = 'approval'
order by r.started_at desc
limit 6;
```

In n8n → **Executions**, no execution should be in the "Waiting" state.

### Test results

| Test | Result |
|---|---|
| 1 Signed out is blocked | ✅ |
| 2 Low risk: auto-approve | ✅ |
| 3 Medium: manual approve | ✅ |
| 4 Reject without a note is blocked | ✅ |
| 4 Reject with a note | ✅ |
| 3–4 Decision alert in Slack (`Slack decision alert`) | ✅ |
| 6 Stale tab: second approve → `409` | [fill in result] |
| 5 Timeout reject | [fill in result] |

### Troubleshooting

| Symptom | Likely cause |
|---|---|
| `/admin` sends you back to `/login` right after signing in | Session cookie not stored: open the site on `http://localhost:3000` exactly, not `127.0.0.1` or another port |
| "Invalid email or password" with the right password | The user isn't confirmed, or the Email provider is disabled (0A) |
| Dashboard shows "No runs yet" but runs exist | The RLS policies and revokes from the Phase 1 migration were never applied to the live database. Run the SQL in [Fix: RLS policies and revokes](#fix-rls-policies-and-revokes), then [check the live database](#check-the-live-database-against-the-migration) |
| Slack's "Review" link asks you to sign in | Expected in a browser without a dashboard session. After signing in, `/login?next=…` sends you back to the run |
| 404 `The requested webhook "POST approval" is not registered` while WF-02 shows **Published** | The Webhook node's **Path** is still n8n's random default (a UUID). Set it to exactly `approval`, save, and publish again |
| An edit in n8n doesn't take effect | The live (published) version is a snapshot taken when you published. **Publish again after every change** |
| "Referenced node doesn't exist" or an expression returns nothing | Node names are case-sensitive: `Load run`, `Validate request`, `Record decision` exactly, as written in this runbook |
| Approve shows "couldn't be delivered" (502); server log `n8n error HTTP 404 … not registered` | WF-02 isn't active, or its Webhook path isn't exactly `approval` (see the row above) |
| 502; server log `n8n error HTTP 403` or `401` | WF-02's Webhook Authentication isn't the `Onboard Webhook Secret` Header Auth credential |
| 502; server log `n8n error HTTP 200: …` with some other body | A reply node's body is in Fixed mode, or `Reply: Recorded (200)` doesn't echo `run_id` and `status` |
| A decided run gets 502 or 503 from WF-02 instead of 409 | `Record decision` has Always Output Data OFF, so on zero rows no reply node runs. Turn it ON (E2.5) |
| 400 "refused this decision as invalid"; server log shows WF-02's `errors` | The website and `Validate request` disagree; re-paste `n8n/snippets/validate-approval.js` |
| 409 on the very first click | The run isn't `awaiting_approval`: entry 3 timed it out, someone else decided, or `Mark awaiting approval` never ran (check WF-02's entry-1 execution) |
| Run stays `awaiting_approval` after 48 hours | WF-02 isn't active (the Schedule only fires when it is), or the Query Parameters field of `Reject timed-out runs` is in Fixed mode |
| Runs are rejected after a few minutes | Entry 3 still has the test settings (`'2 minutes'`, every 1 minute). Restore them |
| Slack alert never arrives, but the run waits in the queue | Expected when Slack fails; check `Slack alert`'s output. The webhook URL may have been revoked |
| Slack says `invalid_payload`, or shows literal `{{ … }}` | The JSON body is in Fixed mode; switch it to Expression |
| One Slack timeout message per run instead of one list | **Execute Once** is off on `Slack timeout alert` |
| Run stays `enriching` after enrichment; no WF-02 execution | `Start approval` isn't connected after `Save Enrichment`, points at the wrong workflow, or `Save Enrichment` returned zero rows |
| `Start approval` fails with "…is not allowed to call…" | WF-02 → **Settings → This workflow can be called by**: allow WF-01 (workflows from the same owner is the default) |
| WF-02 entry 1 runs with `run_id` empty | The trigger's input field isn't named exactly `run_id`, or `Start approval`'s value is in Fixed mode |
| `Load run` returns nothing | The run isn't `enriching` (already routed, or enrichment failed), so entry 1 correctly stops |
| Low-risk run goes to the manual path | `risk_level` isn't `low` in `clients` (check the row), or the tier is `enterprise` (Phase 3's rule makes it high anyway) |

### Fix: RLS policies and revokes

If the Phase 1 migration's security part never reached the live database, run this once in the
Supabase SQL editor. It is the same SQL as `supabase/migrations/20261027000000_init_schema.sql`,
written so it can run again safely.

```sql
alter table public.clients         enable row level security;
alter table public.onboarding_runs enable row level security;
alter table public.run_steps       enable row level security;

drop policy if exists "authenticated can read clients" on public.clients;
create policy "authenticated can read clients"
  on public.clients for select to authenticated using (true);

drop policy if exists "authenticated can read onboarding_runs" on public.onboarding_runs;
create policy "authenticated can read onboarding_runs"
  on public.onboarding_runs for select to authenticated using (true);

drop policy if exists "authenticated can read run_steps" on public.run_steps;
create policy "authenticated can read run_steps"
  on public.run_steps for select to authenticated using (true);

revoke all on public.clients, public.onboarding_runs, public.run_steps from anon;
revoke insert, update, delete, truncate, references, trigger
  on public.clients, public.onboarding_runs, public.run_steps from authenticated;
```

### Check the live database against the migration

Run this in the Supabase SQL editor. It returns one row per thing the migration creates; any row
with `ok = false` is missing from the live database (sorted to the top).

```sql
select item, ok
from (values
  ('RLS on clients',                         (select relrowsecurity from pg_class where oid = 'public.clients'::regclass)),
  ('RLS on onboarding_runs',                 (select relrowsecurity from pg_class where oid = 'public.onboarding_runs'::regclass)),
  ('RLS on run_steps',                       (select relrowsecurity from pg_class where oid = 'public.run_steps'::regclass)),
  ('policy: authenticated reads clients',         exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'clients'         and cmd = 'SELECT' and 'authenticated' = any (roles))),
  ('policy: authenticated reads onboarding_runs', exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'onboarding_runs' and cmd = 'SELECT' and 'authenticated' = any (roles))),
  ('policy: authenticated reads run_steps',       exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'run_steps'       and cmd = 'SELECT' and 'authenticated' = any (roles))),
  ('anon has no table privileges', not exists (
     select 1 from unnest(array['public.clients', 'public.onboarding_runs', 'public.run_steps']) t,
                   unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p
     where has_table_privilege('anon', t, p))),
  ('authenticated can select', (
     select bool_and(has_table_privilege('authenticated', t, 'SELECT'))
     from unnest(array['public.clients', 'public.onboarding_runs', 'public.run_steps']) t)),
  ('authenticated has no write privileges', not exists (
     select 1 from unnest(array['public.clients', 'public.onboarding_runs', 'public.run_steps']) t,
                   unnest(array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p
     where has_table_privilege('authenticated', t, p))),
  ('index onboarding_runs_status_idx',    to_regclass('public.onboarding_runs_status_idx') is not null),
  ('index onboarding_runs_client_id_idx', to_regclass('public.onboarding_runs_client_id_idx') is not null),
  ('index run_steps_run_id_idx',          to_regclass('public.run_steps_run_id_idx') is not null),
  ('unique clients(submission_id)',       exists (select 1 from pg_constraint where conrelid = 'public.clients'::regclass and contype = 'u')),
  ('unique run_steps(run_id, step_name)', exists (select 1 from pg_constraint where conrelid = 'public.run_steps'::regclass and contype = 'u')),
  ('check onboarding_runs.status',        exists (select 1 from pg_constraint where conrelid = 'public.onboarding_runs'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%awaiting_approval%')),
  ('check run_steps.status',              exists (select 1 from pg_constraint where conrelid = 'public.run_steps'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%skipped%')),
  ('realtime: onboarding_runs', exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'onboarding_runs')),
  ('realtime: run_steps',       exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'run_steps'))
) as expected (item, ok)
order by ok, item;
```
