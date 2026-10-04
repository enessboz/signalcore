-- SignalCore Agent UAT result ledger.

create table if not exists public.agent_uat_runs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid not null,
  scenario_key text not null,
  scenario_name text not null,
  expected_agent_key text not null,
  actual_agent_key text,
  execution_mode text not null check (execution_mode in ('direct','router')),
  status text not null default 'running'
    check (status in ('running','passed','failed','error')),
  score integer check (score between 0 and 100),
  checks jsonb not null default '{}'::jsonb,
  agent_run_id uuid references public.agent_runs(id) on delete set null,
  actual_cost numeric(12,6),
  error text,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (project_id,owner_id)
    references public.projects(id,owner_id) on delete cascade
);

create index if not exists agent_uat_runs_owner_created_idx
  on public.agent_uat_runs(owner_id,created_at desc);

create index if not exists agent_uat_runs_project_agent_idx
  on public.agent_uat_runs(project_id,expected_agent_key,created_at desc);

create index if not exists agent_uat_runs_project_owner_fk_idx
  on public.agent_uat_runs(project_id,owner_id);

create index if not exists agent_uat_runs_agent_run_fk_idx
  on public.agent_uat_runs(agent_run_id);

alter table public.agent_uat_runs enable row level security;

grant select,insert,update,delete on public.agent_uat_runs to authenticated;
grant select,insert,update,delete on public.agent_uat_runs to service_role;

drop policy if exists agent_uat_runs_select_own on public.agent_uat_runs;
create policy agent_uat_runs_select_own
on public.agent_uat_runs for select to authenticated
using (owner_id=(select auth.uid()));

drop policy if exists agent_uat_runs_insert_own on public.agent_uat_runs;
create policy agent_uat_runs_insert_own
on public.agent_uat_runs for insert to authenticated
with check (owner_id=(select auth.uid()));

drop policy if exists agent_uat_runs_update_own on public.agent_uat_runs;
create policy agent_uat_runs_update_own
on public.agent_uat_runs for update to authenticated
using (owner_id=(select auth.uid()))
with check (owner_id=(select auth.uid()));

drop policy if exists agent_uat_runs_delete_own on public.agent_uat_runs;
create policy agent_uat_runs_delete_own
on public.agent_uat_runs for delete to authenticated
using (owner_id=(select auth.uid()));
