# Signup-to-Kickoff: AI Client Onboarding Pipeline

Portfolio demo of an end-to-end client onboarding pipeline for a fictional agency, "Northpeak Studio".
A client signs up on the website → n8n validates, dedupes, enriches with Claude Haiku 4.5, routes for
human approval → provisions Drive, ClickUp, Calendar, Gmail → ops dashboard shows every run and step live.

It is a demo built to behave like production. Prioritize correctness, idempotency, and observability over features.

## Current phase

**Phase 3 — AI enrichment.** Only build what Phase 3 lists. Do not start later phases unless told.

n8n workflows are built manually in the n8n UI, not generated as code. Exported JSON in `n8n/workflows/`
is a reference copy (credentials stripped).

## Stack (all free except Haiku)

| Layer | Tool |
|---|---|
| Website + admin | Next.js (App Router, TypeScript strict), Tailwind, shadcn/ui |
| Hosting | Vercel Hobby |
| Orchestration | n8n (self-hosted Docker, already running locally) |
| Tunnel | ngrok static domain: `https://your-subdomain.ngrok-free.dev` |
| DB + auth | Supabase (region `ap-northeast-2`), Postgres + Auth + Realtime |
| AI | Claude Haiku 4.5 (called from n8n only) |
| Approvals/alerts | Slack free workspace |
| Provisioning | Google Drive, Gmail, Calendar, ClickUp |
| Form safety | Zod, Cloudflare Turnstile |
| Tests/CI | Vitest, Playwright, GitHub Actions |

## Architecture rules

- Browsers and Slack only talk to the **Next.js website**. Never link anyone directly to n8n.
- The website calls n8n through ngrok with header `X-Onboard-Secret: $ONBOARD_WEBHOOK_SECRET`
  and header `ngrok-skip-browser-warning: true`.
- **n8n is the only writer** to Supabase (service role key). The website reads with the anon key + admin auth.
- `SUPABASE_SERVICE_ROLE_KEY` must never be imported in any client component or shipped to the browser.

## Repo structure

```
apps/web/                 Next.js site + /admin dashboard
  app/onboard/            intake form (Phase 2)
  app/admin/              runs, run detail, approvals (Phase 4/6)
  app/api/onboard/        forwards to n8n (Phase 2)
  app/api/approve/        dashboard + Slack approvals (Phase 4)
  lib/                    supabase clients, zod schemas, env validation
  tests/                  Vitest + Playwright
n8n/workflows/            exported workflow JSON (credentials stripped)
n8n/prompts/              Haiku system prompt + output JSON schema
supabase/migrations/      SQL migrations (schema + RLS + Realtime)
infra/docker-compose.yml  reference n8n + ngrok setup (documentation; dev runs existing instance)
docs/                     architecture, runbook, demo script
.github/workflows/ci.yml
.env.example
```

## Database schema

```sql
create table clients (
  id            uuid primary key default gen_random_uuid(),
  submission_id uuid not null unique,          -- generated in the browser, reused on retries
  company_name  text not null,
  contact_name  text not null,
  contact_email text not null,
  service_tier  text not null check (service_tier in ('starter','growth','enterprise')),
  intake_raw    jsonb not null,
  intake_ai     jsonb,
  risk_level    text check (risk_level in ('low','medium','high')),
  created_at    timestamptz not null default now()
);

create table onboarding_runs (
  id               uuid primary key default gen_random_uuid(),
  client_id        uuid not null references clients(id) on delete cascade,
  status           text not null default 'received' check (status in (
                     'received','enriching','awaiting_approval','approved','rejected',
                     'provisioning','completed','failed')),
  approval_mode    text check (approval_mode in ('auto','manual')),
  approved_by      text,
  approved_at      timestamptz,
  resume_url       text,
  n8n_execution_id text,
  error            text,
  started_at       timestamptz not null default now(),
  finished_at      timestamptz
);

create table run_steps (
  id          uuid primary key default gen_random_uuid(),
  run_id      uuid not null references onboarding_runs(id) on delete cascade,
  step_name   text not null,
  status      text not null check (status in ('started','succeeded','failed','skipped')),
  attempt     int not null default 1,
  duration_ms int,
  output      jsonb,
  error       text,
  created_at  timestamptz not null default now(),
  unique (run_id, step_name)
);
```

- Enable RLS on all three tables. Policies: `authenticated` can `select`; no insert/update/delete for
  anon or authenticated (service role bypasses RLS).
- Add `onboarding_runs` and `run_steps` to the `supabase_realtime` publication.
- Index `onboarding_runs(status)`, `onboarding_runs(client_id)`, `run_steps(run_id)`.

## Idempotency rules (non-negotiable)

1. Request level: browser generates `submission_id` once per form load. Duplicate insert → return the
   existing `run_id` with `duplicate: true`. Never start a second run.
2. Step level: every provisioning action is keyed by `(run_id, step_name)`. If a step already `succeeded`,
   skip it and return its stored `output`. Retrying a run must never recreate external resources.

## Environment variables

| Variable | Used by |
|---|---|
| `ONBOARD_WEBHOOK_SECRET` | web + n8n |
| `N8N_BASE_URL` | web |
| `NEXT_PUBLIC_SUPABASE_URL` | web |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | web |
| `SUPABASE_SERVICE_ROLE_KEY` | n8n only (and server-only scripts) |
| `ANTHROPIC_API_KEY` | n8n |
| `SLACK_SIGNING_SECRET` | web |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | web |
| `TURNSTILE_SECRET_KEY` | web |

Validate env at startup with Zod in `apps/web/lib/env.ts`. Never commit `.env` files.

## Coding conventions

- TypeScript strict, no `any`. Zod for every external input (forms, webhooks, n8n responses).
- Server-only code lives in route handlers or `lib/server/*` with `import 'server-only'`.
- Small, typed functions; no business logic in React components.
- Every API route returns typed JSON `{ ok: boolean, ... }` with correct HTTP status codes.
- Keep dependencies minimal; ask before adding a new one.

## Known snags

- Supabase direct connection is IPv6-only → n8n uses the **session pooler** (already configured).
- Google OAuth in Testing mode expires refresh tokens every 7 days → publish consent screen or reconnect before demos.
- Slack interactions need a 200 within 3s → verify signature, respond, then call n8n via `waitUntil` from `@vercel/functions`.
- Add production + preview Vercel domains to Turnstile allowed hostnames.
- Supabase free pauses after ~1 week idle.

## Phases

1. **Foundation** — monorepo scaffold, Next.js app, Supabase migration (schema + RLS + Realtime),
   `.env.example`, env validation, CI (lint + type-check). Done when: `npm run dev` works, migration applies
   cleanly, CI passes on first push.
2. **Intake** — `/onboard` form (Zod + Turnstile), `/api/onboard` → n8n WF-01 steps 1–3. Done when: double
   submit returns `duplicate: true`.
3. **AI enrichment** — Haiku prompt + JSON schema in `n8n/prompts/`, validated output, `risk_level` stored.
4. **Approval gate** — Wait node, Slack approval, WF-03, `/api/approve`, approval queue page.
5. **Provisioning** — WF-02 step-level idempotency; Drive → ClickUp → Calendar → Gmail; WF-04 error handler.
6. **Dashboard + polish** — Realtime views, stats, Simulate retry, Vitest + Playwright, README, demo video.

## How to work in this repo

- Start each session by restating the current phase and its done criteria.
- When a phase is done: show the file tree, list anything I must do manually (accounts, keys, n8n UI steps),
  and stop.
- n8n workflows are built in the n8n UI; when I export them, save to `n8n/workflows/` with credentials stripped.
