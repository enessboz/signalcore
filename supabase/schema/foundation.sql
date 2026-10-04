-- SignalCore V1 Foundation Schema
-- Prepared for a fresh Supabase project. This file is intentionally not a
-- migration history entry yet; once the target project is selected we will
-- apply/verify the schema, run advisors, then generate the canonical migration.

create extension if not exists pgcrypto;

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  slug text not null,
  domain text,
  project_type text not null check (project_type in ('owned','client','lead_prospect')),
  status text not null default 'active' check (status in ('active','paused','archived')),
  description text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, slug),
  unique (id, owner_id)
);

create table if not exists public.project_sources (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null,
  owner_id uuid not null,
  source_type text not null,
  title text not null,
  uri text,
  source_status text not null default 'active',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (project_id, owner_id) references public.projects(id, owner_id) on delete cascade,
  unique (id, project_id, owner_id)
);

create table if not exists public.project_facts (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null,
  owner_id uuid not null,
  fact_key text not null,
  fact_value jsonb not null,
  knowledge_type text not null check (knowledge_type in ('fact','measurement','work_performed','decision','estimate','hypothesis','recommendation')),
  confidence text check (confidence in ('high','medium','low')),
  source_id uuid,
  valid_from timestamptz,
  valid_to timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (project_id, owner_id) references public.projects(id, owner_id) on delete cascade,
  foreign key (source_id, project_id, owner_id) references public.project_sources(id, project_id, owner_id) on delete set null (source_id)
);

create table if not exists public.jobs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null,
  owner_id uuid not null,
  job_type text not null,
  trigger_type text not null check (trigger_type in ('manual','scheduled','condition_watch','system')),
  status text not null default 'queued' check (status in ('queued','running','succeeded','failed','partial','cancelled','blocked')),
  idempotency_key text,
  payload jsonb not null default '{}'::jsonb,
  result_summary jsonb not null default '{}'::jsonb,
  estimated_cost numeric(12,6),
  actual_cost numeric(12,6),
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (project_id, owner_id) references public.projects(id, owner_id) on delete cascade,
  unique (project_id, idempotency_key)
);

create table if not exists public.findings (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null,
  owner_id uuid not null,
  finding_type text not null check (finding_type in ('issue','opportunity','strategy_discovery','regression','observation','experiment_update','data_health')),
  title text not null,
  summary text not null,
  why_it_matters text,
  importance text not null check (importance in ('critical','high','medium','low')),
  confidence text not null check (confidence in ('high','medium','low')),
  status text not null default 'open' check (status in ('open','monitoring','resolved','dismissed','blocked')),
  fingerprint text not null,
  affected_scope jsonb not null default '{}'::jsonb,
  recommended_action text,
  metadata jsonb not null default '{}'::jsonb,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  next_review_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (project_id, owner_id) references public.projects(id, owner_id) on delete cascade,
  unique (project_id, fingerprint),
  unique (id, project_id, owner_id)
);

create table if not exists public.finding_evidence (
  id uuid primary key default gen_random_uuid(),
  finding_id uuid not null,
  project_id uuid not null,
  owner_id uuid not null,
  evidence_type text not null,
  source_class text not null check (source_class in ('first_party','direct_public','third_party_estimate','user_supplied')),
  title text,
  uri text,
  observed_at timestamptz,
  extract jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  foreign key (project_id, owner_id) references public.projects(id, owner_id) on delete cascade,
  foreign key (finding_id, project_id, owner_id) references public.findings(id, project_id, owner_id) on delete cascade
);

create table if not exists public.approvals (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null,
  owner_id uuid not null,
  action_type text not null,
  status text not null default 'pending' check (status in ('pending','approved','rejected','expired','cancelled')),
  payload jsonb not null default '{}'::jsonb,
  requested_at timestamptz not null default now(),
  decided_at timestamptz,
  foreign key (project_id, owner_id) references public.projects(id, owner_id) on delete cascade
);

create table if not exists public.usage_events (
  id bigint generated always as identity primary key,
  project_id uuid not null,
  owner_id uuid not null,
  category text not null,
  provider text,
  units numeric(18,6),
  estimated_cost numeric(12,6),
  actual_cost numeric(12,6),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  foreign key (project_id, owner_id) references public.projects(id, owner_id) on delete cascade
);

create table if not exists public.budget_limits (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null,
  owner_id uuid not null,
  category text not null,
  monthly_limit numeric(12,2) not null check (monthly_limit >= 0),
  soft_warning_percent integer not null default 80 check (soft_warning_percent between 1 and 100),
  hard_stop boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (project_id, owner_id) references public.projects(id, owner_id) on delete cascade,
  unique (project_id, category)
);

create table if not exists public.audit_events (
  id bigint generated always as identity primary key,
  project_id uuid,
  owner_id uuid not null references auth.users(id) on delete cascade,
  actor_type text not null check (actor_type in ('user','system','agent','service')),
  event_type text not null,
  entity_type text,
  entity_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  foreign key (project_id, owner_id) references public.projects(id, owner_id) on delete cascade
);

create index if not exists projects_owner_status_idx on public.projects(owner_id, status);
create index if not exists project_sources_project_idx on public.project_sources(project_id, created_at desc);
create index if not exists project_facts_project_key_idx on public.project_facts(project_id, fact_key);
create index if not exists jobs_project_status_idx on public.jobs(project_id, status, created_at desc);
create index if not exists findings_project_status_idx on public.findings(project_id, status, importance, updated_at desc);
create index if not exists evidence_finding_idx on public.finding_evidence(finding_id, created_at);
create index if not exists usage_project_created_idx on public.usage_events(project_id, created_at desc);
create index if not exists audit_owner_created_idx on public.audit_events(owner_id, created_at desc);

create index if not exists approvals_project_owner_fk_idx on public.approvals(project_id, owner_id);
create index if not exists audit_project_owner_fk_idx on public.audit_events(project_id, owner_id);
create index if not exists budgets_project_owner_fk_idx on public.budget_limits(project_id, owner_id);
create index if not exists evidence_project_owner_fk_idx on public.finding_evidence(project_id, owner_id);
create index if not exists evidence_finding_project_owner_fk_idx on public.finding_evidence(finding_id, project_id, owner_id);
create index if not exists findings_project_owner_fk_idx on public.findings(project_id, owner_id);
create index if not exists jobs_project_owner_fk_idx on public.jobs(project_id, owner_id);
create index if not exists facts_project_owner_fk_idx on public.project_facts(project_id, owner_id);
create index if not exists facts_source_project_owner_fk_idx on public.project_facts(source_id, project_id, owner_id);
create index if not exists sources_project_owner_fk_idx on public.project_sources(project_id, owner_id);
create index if not exists usage_project_owner_fk_idx on public.usage_events(project_id, owner_id);

grant select, insert, update, delete on public.projects to authenticated;
grant select, insert, update, delete on public.project_sources to authenticated;
grant select, insert, update, delete on public.project_facts to authenticated;
grant select, insert, update, delete on public.jobs to authenticated;
grant select, insert, update, delete on public.findings to authenticated;
grant select, insert, update, delete on public.finding_evidence to authenticated;
grant select, insert, update, delete on public.approvals to authenticated;
grant select, insert on public.usage_events to authenticated;
grant select, insert, update, delete on public.budget_limits to authenticated;
grant select, insert on public.audit_events to authenticated;
grant usage, select on all sequences in schema public to authenticated;

alter table public.projects enable row level security;
alter table public.project_sources enable row level security;
alter table public.project_facts enable row level security;
alter table public.jobs enable row level security;
alter table public.findings enable row level security;
alter table public.finding_evidence enable row level security;
alter table public.approvals enable row level security;
alter table public.usage_events enable row level security;
alter table public.budget_limits enable row level security;
alter table public.audit_events enable row level security;

drop policy if exists projects_select_own on public.projects;
create policy projects_select_own on public.projects for select to authenticated using ((select auth.uid()) = owner_id);
drop policy if exists projects_insert_own on public.projects;
create policy projects_insert_own on public.projects for insert to authenticated with check ((select auth.uid()) = owner_id);
drop policy if exists projects_update_own on public.projects;
create policy projects_update_own on public.projects for update to authenticated using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);
drop policy if exists projects_delete_own on public.projects;
create policy projects_delete_own on public.projects for delete to authenticated using ((select auth.uid()) = owner_id);

drop policy if exists sources_select_own on public.project_sources;
create policy sources_select_own on public.project_sources for select to authenticated using ((select auth.uid()) = owner_id);
drop policy if exists sources_insert_own on public.project_sources;
create policy sources_insert_own on public.project_sources for insert to authenticated with check ((select auth.uid()) = owner_id);
drop policy if exists sources_update_own on public.project_sources;
create policy sources_update_own on public.project_sources for update to authenticated using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);
drop policy if exists sources_delete_own on public.project_sources;
create policy sources_delete_own on public.project_sources for delete to authenticated using ((select auth.uid()) = owner_id);

drop policy if exists facts_select_own on public.project_facts;
create policy facts_select_own on public.project_facts for select to authenticated using ((select auth.uid()) = owner_id);
drop policy if exists facts_insert_own on public.project_facts;
create policy facts_insert_own on public.project_facts for insert to authenticated with check ((select auth.uid()) = owner_id);
drop policy if exists facts_update_own on public.project_facts;
create policy facts_update_own on public.project_facts for update to authenticated using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);
drop policy if exists facts_delete_own on public.project_facts;
create policy facts_delete_own on public.project_facts for delete to authenticated using ((select auth.uid()) = owner_id);

drop policy if exists jobs_select_own on public.jobs;
create policy jobs_select_own on public.jobs for select to authenticated using ((select auth.uid()) = owner_id);
drop policy if exists jobs_insert_own on public.jobs;
create policy jobs_insert_own on public.jobs for insert to authenticated with check ((select auth.uid()) = owner_id);
drop policy if exists jobs_update_own on public.jobs;
create policy jobs_update_own on public.jobs for update to authenticated using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);
drop policy if exists jobs_delete_own on public.jobs;
create policy jobs_delete_own on public.jobs for delete to authenticated using ((select auth.uid()) = owner_id);

drop policy if exists findings_select_own on public.findings;
create policy findings_select_own on public.findings for select to authenticated using ((select auth.uid()) = owner_id);
drop policy if exists findings_insert_own on public.findings;
create policy findings_insert_own on public.findings for insert to authenticated with check ((select auth.uid()) = owner_id);
drop policy if exists findings_update_own on public.findings;
create policy findings_update_own on public.findings for update to authenticated using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);
drop policy if exists findings_delete_own on public.findings;
create policy findings_delete_own on public.findings for delete to authenticated using ((select auth.uid()) = owner_id);

drop policy if exists evidence_select_own on public.finding_evidence;
create policy evidence_select_own on public.finding_evidence for select to authenticated using ((select auth.uid()) = owner_id);
drop policy if exists evidence_insert_own on public.finding_evidence;
create policy evidence_insert_own on public.finding_evidence for insert to authenticated with check ((select auth.uid()) = owner_id);
drop policy if exists evidence_update_own on public.finding_evidence;
create policy evidence_update_own on public.finding_evidence for update to authenticated using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);
drop policy if exists evidence_delete_own on public.finding_evidence;
create policy evidence_delete_own on public.finding_evidence for delete to authenticated using ((select auth.uid()) = owner_id);

drop policy if exists approvals_select_own on public.approvals;
create policy approvals_select_own on public.approvals for select to authenticated using ((select auth.uid()) = owner_id);
drop policy if exists approvals_insert_own on public.approvals;
create policy approvals_insert_own on public.approvals for insert to authenticated with check ((select auth.uid()) = owner_id);
drop policy if exists approvals_update_own on public.approvals;
create policy approvals_update_own on public.approvals for update to authenticated using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);
drop policy if exists approvals_delete_own on public.approvals;
create policy approvals_delete_own on public.approvals for delete to authenticated using ((select auth.uid()) = owner_id);

drop policy if exists usage_select_own on public.usage_events;
create policy usage_select_own on public.usage_events for select to authenticated using ((select auth.uid()) = owner_id);
drop policy if exists usage_insert_own on public.usage_events;
create policy usage_insert_own on public.usage_events for insert to authenticated with check ((select auth.uid()) = owner_id);

drop policy if exists budgets_select_own on public.budget_limits;
create policy budgets_select_own on public.budget_limits for select to authenticated using ((select auth.uid()) = owner_id);
drop policy if exists budgets_insert_own on public.budget_limits;
create policy budgets_insert_own on public.budget_limits for insert to authenticated with check ((select auth.uid()) = owner_id);
drop policy if exists budgets_update_own on public.budget_limits;
create policy budgets_update_own on public.budget_limits for update to authenticated using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);
drop policy if exists budgets_delete_own on public.budget_limits;
create policy budgets_delete_own on public.budget_limits for delete to authenticated using ((select auth.uid()) = owner_id);

drop policy if exists audit_select_own on public.audit_events;
create policy audit_select_own on public.audit_events for select to authenticated using ((select auth.uid()) = owner_id);
drop policy if exists audit_insert_own on public.audit_events;
create policy audit_insert_own on public.audit_events for insert to authenticated with check ((select auth.uid()) = owner_id);
