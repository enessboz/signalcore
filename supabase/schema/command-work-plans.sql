-- SignalCore persistent Chief Operator work plans.

create table if not exists public.command_plans (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null,
  source_message_id uuid,
  owner_id uuid not null,
  project_id uuid,
  title text not null,
  objective text not null,
  status text not null default 'planned'
    check (status in (
      'planned','running','waiting_data','waiting_user',
      'blocked_tool','completed','failed','cancelled'
    )),
  current_step integer not null default 0,
  total_steps integer not null default 0,
  continuation_of uuid references public.command_plans(id) on delete set null,
  planner_model text,
  planner_usage jsonb not null default '{}'::jsonb,
  context jsonb not null default '{}'::jsonb,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  foreign key(thread_id,owner_id)
    references public.command_threads(id,owner_id) on delete cascade,
  foreign key(project_id,owner_id)
    references public.projects(id,owner_id) on delete set null,
  foreign key(source_message_id)
    references public.command_messages(id) on delete set null
);

create table if not exists public.command_plan_steps (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.command_plans(id) on delete cascade,
  owner_id uuid not null,
  sequence integer not null check (sequence > 0),
  title text not null,
  action_type text not null,
  status text not null default 'pending'
    check (status in (
      'pending','running','completed','waiting_data','waiting_user',
      'blocked_tool','failed','skipped','cancelled'
    )),
  arguments jsonb not null default '{}'::jsonb,
  result jsonb not null default '{}'::jsonb,
  blocker_type text,
  blocker_message text,
  required_input jsonb not null default '{}'::jsonb,
  attempt_count integer not null default 0,
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now(),
  unique(plan_id,sequence)
);

create index if not exists command_plans_thread_owner_idx
  on public.command_plans(thread_id,owner_id,created_at desc);
create index if not exists command_plans_status_idx
  on public.command_plans(owner_id,status,updated_at desc);
create index if not exists command_plan_steps_plan_status_idx
  on public.command_plan_steps(plan_id,status,sequence);

alter table public.command_plans enable row level security;
alter table public.command_plan_steps enable row level security;

grant select,insert,update,delete on public.command_plans to authenticated;
grant select,insert,update,delete on public.command_plans to service_role;
grant select,insert,update,delete on public.command_plan_steps to authenticated;
grant select,insert,update,delete on public.command_plan_steps to service_role;

drop policy if exists command_plans_own on public.command_plans;
create policy command_plans_own
on public.command_plans
for all to authenticated
using (owner_id=(select auth.uid()))
with check (owner_id=(select auth.uid()));

drop policy if exists command_plan_steps_own on public.command_plan_steps;
create policy command_plan_steps_own
on public.command_plan_steps
for all to authenticated
using (owner_id=(select auth.uid()))
with check (owner_id=(select auth.uid()));




create index if not exists command_plans_continuation_fk_idx
  on public.command_plans(continuation_of);
create index if not exists command_plans_project_owner_fk_idx
  on public.command_plans(project_id,owner_id);
create index if not exists command_plans_source_message_fk_idx
  on public.command_plans(source_message_id);
