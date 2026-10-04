-- SignalCore Google Warehouse
-- Persistent, cost-controlled first-party data layer for GSC and GA4.

create table if not exists public.google_sync_states (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null,
  owner_id uuid not null,
  source text not null check (source in ('gsc','ga4')),
  dataset text not null,
  status text not null default 'idle'
    check (status in ('idle','queued','running','succeeded','partial','failed','paused')),
  last_complete_date date,
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  rows_total bigint not null default 0,
  config jsonb not null default '{}'::jsonb,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (project_id, owner_id)
    references public.projects(id, owner_id) on delete cascade,
  unique (project_id, source, dataset)
);

create table if not exists public.google_sync_queue (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null,
  owner_id uuid not null,
  source text not null check (source in ('gsc','ga4')),
  mode text not null default 'incremental'
    check (mode in ('incremental','backfill','repair')),
  start_date date not null,
  end_date date not null,
  cursor_date date,
  status text not null default 'queued'
    check (status in ('queued','running','succeeded','partial','failed','cancelled')),
  priority integer not null default 50,
  result jsonb not null default '{}'::jsonb,
  error text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  foreign key (project_id, owner_id)
    references public.projects(id, owner_id) on delete cascade
);

create table if not exists public.gsc_page_daily (
  project_id uuid not null,
  owner_id uuid not null,
  date date not null,
  search_type text not null default 'web',
  page text not null,
  clicks double precision not null default 0,
  impressions double precision not null default 0,
  ctr double precision not null default 0,
  position double precision not null default 0,
  updated_at timestamptz not null default now(),
  primary key (project_id, date, search_type, page),
  foreign key (project_id, owner_id)
    references public.projects(id, owner_id) on delete cascade
);

create table if not exists public.gsc_query_daily (
  project_id uuid not null,
  owner_id uuid not null,
  date date not null,
  search_type text not null default 'web',
  query text not null,
  clicks double precision not null default 0,
  impressions double precision not null default 0,
  ctr double precision not null default 0,
  position double precision not null default 0,
  updated_at timestamptz not null default now(),
  primary key (project_id, date, search_type, query),
  foreign key (project_id, owner_id)
    references public.projects(id, owner_id) on delete cascade
);

create table if not exists public.ga4_landing_page_daily (
  project_id uuid not null,
  owner_id uuid not null,
  date date not null,
  landing_page text not null,
  channel_group text not null default '(not set)',
  sessions double precision not null default 0,
  active_users double precision not null default 0,
  new_users double precision not null default 0,
  engaged_sessions double precision not null default 0,
  engagement_rate double precision not null default 0,
  key_events double precision not null default 0,
  updated_at timestamptz not null default now(),
  primary key (project_id, date, landing_page, channel_group),
  foreign key (project_id, owner_id)
    references public.projects(id, owner_id) on delete cascade
);

create table if not exists public.ga4_event_daily (
  project_id uuid not null,
  owner_id uuid not null,
  date date not null,
  event_name text not null,
  event_count double precision not null default 0,
  active_users double precision not null default 0,
  key_events double precision not null default 0,
  updated_at timestamptz not null default now(),
  primary key (project_id, date, event_name),
  foreign key (project_id, owner_id)
    references public.projects(id, owner_id) on delete cascade
);

alter table public.project_bindings
  add column if not exists auto_sync_enabled boolean not null default false,
  add column if not exists sync_config jsonb not null default '{}'::jsonb;

-- Indexes, grants and RLS policies are applied in production as part of the same rollout.
