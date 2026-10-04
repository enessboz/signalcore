-- SignalCore V1 Executive Command + Agent Organization
-- Live schema is already applied. This file keeps the repository aligned with production.

alter table public.agent_definitions
  add column if not exists reports_to text references public.agent_definitions(agent_key),
  add column if not exists team_level integer not null default 2,
  add column if not exists sort_order integer not null default 100;

create table if not exists public.command_threads (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  title text not null default 'New command thread',
  status text not null default 'active' check (status in ('active','archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, owner_id)
);

create table if not exists public.command_messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null,
  owner_id uuid not null,
  role text not null check (role in ('user','assistant','system')),
  content text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  foreign key (thread_id, owner_id)
    references public.command_threads(id, owner_id) on delete cascade
);

create table if not exists public.command_actions (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null,
  message_id uuid,
  owner_id uuid not null,
  action_type text not null,
  status text not null default 'planned'
    check (status in ('planned','executing','completed','failed','awaiting_approval','cancelled')),
  project_id uuid,
  target_agent_key text references public.agent_definitions(agent_key),
  arguments jsonb not null default '{}'::jsonb,
  result jsonb not null default '{}'::jsonb,
  error text,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  foreign key (thread_id, owner_id)
    references public.command_threads(id, owner_id) on delete cascade,
  foreign key (project_id, owner_id)
    references public.projects(id, owner_id) on delete set null
);

create table if not exists public.scheduled_tasks (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid,
  title text not null,
  instruction text not null,
  target_agent_key text not null references public.agent_definitions(agent_key),
  schedule_kind text not null check (schedule_kind in ('once','daily','weekly','monthly')),
  schedule_config jsonb not null default '{}'::jsonb,
  post_run_config jsonb not null default '{}'::jsonb,
  timezone text not null default 'Europe/Istanbul',
  status text not null default 'active'
    check (status in ('active','paused','running','completed','failed','cancelled')),
  last_run_at timestamptz,
  next_run_at timestamptz,
  last_run_id uuid references public.agent_runs(id) on delete set null,
  failure_count integer not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (project_id, owner_id)
    references public.projects(id, owner_id) on delete cascade
);

create index if not exists agent_definitions_reports_to_idx on public.agent_definitions(reports_to);
create index if not exists command_threads_owner_updated_idx on public.command_threads(owner_id, updated_at desc);
create index if not exists command_messages_thread_created_idx on public.command_messages(thread_id, created_at);
create index if not exists command_messages_thread_owner_fk_idx on public.command_messages(thread_id, owner_id);
create index if not exists command_actions_thread_created_idx on public.command_actions(thread_id, created_at desc);
create index if not exists command_actions_thread_owner_fk_idx on public.command_actions(thread_id, owner_id);
create index if not exists command_actions_project_owner_fk_idx on public.command_actions(project_id, owner_id);
create index if not exists command_actions_target_agent_idx on public.command_actions(target_agent_key);
create index if not exists scheduled_tasks_owner_status_idx on public.scheduled_tasks(owner_id, status, next_run_at);
create index if not exists scheduled_tasks_project_owner_fk_idx on public.scheduled_tasks(project_id, owner_id);
create index if not exists scheduled_tasks_target_agent_idx on public.scheduled_tasks(target_agent_key);
create index if not exists scheduled_tasks_last_run_idx on public.scheduled_tasks(last_run_id);
create index if not exists scheduled_tasks_post_run_gin_idx on public.scheduled_tasks using gin(post_run_config);

grant select, insert, update, delete on public.command_threads to authenticated;
grant select, insert, update, delete on public.command_messages to authenticated;
grant select, insert, update, delete on public.command_actions to authenticated;
grant select, insert, update, delete on public.scheduled_tasks to authenticated;

alter table public.command_threads enable row level security;
alter table public.command_messages enable row level security;
alter table public.command_actions enable row level security;
alter table public.scheduled_tasks enable row level security;

drop policy if exists command_threads_select_own on public.command_threads;
create policy command_threads_select_own on public.command_threads
  for select to authenticated using ((select auth.uid()) = owner_id);
drop policy if exists command_threads_insert_own on public.command_threads;
create policy command_threads_insert_own on public.command_threads
  for insert to authenticated with check ((select auth.uid()) = owner_id);
drop policy if exists command_threads_update_own on public.command_threads;
create policy command_threads_update_own on public.command_threads
  for update to authenticated using ((select auth.uid()) = owner_id)
  with check ((select auth.uid()) = owner_id);
drop policy if exists command_threads_delete_own on public.command_threads;
create policy command_threads_delete_own on public.command_threads
  for delete to authenticated using ((select auth.uid()) = owner_id);

drop policy if exists command_messages_select_own on public.command_messages;
create policy command_messages_select_own on public.command_messages
  for select to authenticated using ((select auth.uid()) = owner_id);
drop policy if exists command_messages_insert_own on public.command_messages;
create policy command_messages_insert_own on public.command_messages
  for insert to authenticated with check ((select auth.uid()) = owner_id);
drop policy if exists command_messages_update_own on public.command_messages;
create policy command_messages_update_own on public.command_messages
  for update to authenticated using ((select auth.uid()) = owner_id)
  with check ((select auth.uid()) = owner_id);
drop policy if exists command_messages_delete_own on public.command_messages;
create policy command_messages_delete_own on public.command_messages
  for delete to authenticated using ((select auth.uid()) = owner_id);

drop policy if exists command_actions_select_own on public.command_actions;
create policy command_actions_select_own on public.command_actions
  for select to authenticated using ((select auth.uid()) = owner_id);
drop policy if exists command_actions_insert_own on public.command_actions;
create policy command_actions_insert_own on public.command_actions
  for insert to authenticated with check ((select auth.uid()) = owner_id);
drop policy if exists command_actions_update_own on public.command_actions;
create policy command_actions_update_own on public.command_actions
  for update to authenticated using ((select auth.uid()) = owner_id)
  with check ((select auth.uid()) = owner_id);
drop policy if exists command_actions_delete_own on public.command_actions;
create policy command_actions_delete_own on public.command_actions
  for delete to authenticated using ((select auth.uid()) = owner_id);

drop policy if exists scheduled_tasks_select_own on public.scheduled_tasks;
create policy scheduled_tasks_select_own on public.scheduled_tasks
  for select to authenticated using ((select auth.uid()) = owner_id);
drop policy if exists scheduled_tasks_insert_own on public.scheduled_tasks;
create policy scheduled_tasks_insert_own on public.scheduled_tasks
  for insert to authenticated with check ((select auth.uid()) = owner_id);
drop policy if exists scheduled_tasks_update_own on public.scheduled_tasks;
create policy scheduled_tasks_update_own on public.scheduled_tasks
  for update to authenticated using ((select auth.uid()) = owner_id)
  with check ((select auth.uid()) = owner_id);
drop policy if exists scheduled_tasks_delete_own on public.scheduled_tasks;
create policy scheduled_tasks_delete_own on public.scheduled_tasks
  for delete to authenticated using ((select auth.uid()) = owner_id);
