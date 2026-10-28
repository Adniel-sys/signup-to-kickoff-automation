-- Phase 1: core schema, RLS, Realtime.
-- n8n writes with the service role (bypasses RLS). The website only reads,
-- as an authenticated admin.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.clients (
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

create table public.onboarding_runs (
  id               uuid primary key default gen_random_uuid(),
  client_id        uuid not null references public.clients(id) on delete cascade,
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

create table public.run_steps (
  id          uuid primary key default gen_random_uuid(),
  run_id      uuid not null references public.onboarding_runs(id) on delete cascade,
  step_name   text not null,
  status      text not null check (status in ('started','succeeded','failed','skipped')),
  attempt     int not null default 1,
  duration_ms int,
  output      jsonb,
  error       text,
  created_at  timestamptz not null default now(),
  unique (run_id, step_name)
);

-- ---------------------------------------------------------------------------
-- Indexes (run_steps(run_id) is also the leading column of the unique index,
-- kept explicit to match the spec)
-- ---------------------------------------------------------------------------

create index onboarding_runs_status_idx    on public.onboarding_runs (status);
create index onboarding_runs_client_id_idx on public.onboarding_runs (client_id);
create index run_steps_run_id_idx          on public.run_steps (run_id);

-- ---------------------------------------------------------------------------
-- Row Level Security: authenticated may select; nobody but service role writes.
-- ---------------------------------------------------------------------------

alter table public.clients         enable row level security;
alter table public.onboarding_runs enable row level security;
alter table public.run_steps       enable row level security;

create policy "authenticated can read clients"
  on public.clients for select to authenticated using (true);

create policy "authenticated can read onboarding_runs"
  on public.onboarding_runs for select to authenticated using (true);

create policy "authenticated can read run_steps"
  on public.run_steps for select to authenticated using (true);

-- Defense in depth: Supabase grants full table privileges to anon and
-- authenticated by default. RLS already blocks writes; revoke them too.
revoke all on public.clients, public.onboarding_runs, public.run_steps from anon;
revoke insert, update, delete, truncate, references, trigger
  on public.clients, public.onboarding_runs, public.run_steps from authenticated;

-- ---------------------------------------------------------------------------
-- Realtime
-- ---------------------------------------------------------------------------

alter publication supabase_realtime add table public.onboarding_runs, public.run_steps;
