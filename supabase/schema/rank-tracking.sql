-- SignalCore Rank Tracking and Opportunity Automation V1.

create table if not exists public.rank_tracking_settings (
  project_id uuid primary key,
  owner_id uuid not null,
  active boolean not null default true,
  auto_discover_enabled boolean not null default false,
  auto_findings_enabled boolean not null default true,
  max_auto_keywords integer not null default 100,
  min_impressions_28d integer not null default 100,
  position_min double precision not null default 1,
  position_max double precision not null default 30,
  default_location_code integer not null default 2840,
  default_language_code text not null default 'en',
  default_device text not null default 'desktop',
  daily_high_priority_limit integer not null default 20,
  last_seeded_at timestamptz,
  last_worker_run_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key(project_id,owner_id)
    references public.projects(id,owner_id) on delete cascade
);

create table if not exists public.tracked_keywords (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null,
  owner_id uuid not null,
  keyword text not null,
  target_url text,
  source text not null default 'manual',
  priority text not null default 'normal',
  cadence text not null default 'weekly',
  depth integer not null default 30,
  location_code integer not null default 2840,
  language_code text not null default 'en',
  device text not null default 'desktop',
  active boolean not null default true,
  last_checked_at timestamptz,
  last_position integer,
  last_ranking_url text,
  last_status text not null default 'idle',
  last_error text,
  consecutive_failures integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key(project_id,owner_id)
    references public.projects(id,owner_id) on delete cascade,
  unique(project_id,keyword,location_code,language_code,device)
);

create table if not exists public.rank_history (
  id bigint generated always as identity primary key,
  tracked_keyword_id uuid not null references public.tracked_keywords(id) on delete cascade,
  project_id uuid not null,
  owner_id uuid not null,
  checked_at timestamptz not null default now(),
  provider text not null default 'dataforseo',
  position integer,
  ranking_url text,
  ranking_title text,
  matched_domain text,
  organic_result_count integer not null default 0,
  serp_features jsonb not null default '[]'::jsonb,
  top_competitors jsonb not null default '[]'::jsonb,
  cost numeric(12,6),
  metadata jsonb not null default '{}'::jsonb,
  foreign key(project_id,owner_id)
    references public.projects(id,owner_id) on delete cascade
);

create table if not exists public.rank_tracking_runs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null,
  owner_id uuid not null,
  trigger_type text not null default 'cron',
  status text not null default 'running',
  keywords_requested integer not null default 0,
  keywords_completed integer not null default 0,
  succeeded integer not null default 0,
  failed integer not null default 0,
  actual_cost numeric(12,6) not null default 0,
  result jsonb not null default '{}'::jsonb,
  error text,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  foreign key(project_id,owner_id)
    references public.projects(id,owner_id) on delete cascade
);

create table if not exists public.opportunity_scan_settings (
  project_id uuid primary key,
  owner_id uuid not null,
  enabled boolean not null default false,
  scan_gsc boolean not null default true,
  scan_ga4 boolean not null default true,
  scan_rank boolean not null default true,
  cadence text not null default 'daily',
  last_run_at timestamptz,
  last_data_date date,
  last_status text not null default 'idle',
  last_error text,
  consecutive_failures integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key(project_id,owner_id)
    references public.projects(id,owner_id) on delete cascade
);

create index if not exists tracked_keywords_project_owner_fk_idx
  on public.tracked_keywords(project_id,owner_id);

-- Production rollout also defines owner-scoped RLS, grants, indexes,
-- get_gsc_tracking_candidates(...) and get_gsc_opportunity_dataset(...).
