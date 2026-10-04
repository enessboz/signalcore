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

create table if not exists public.gsc_query_page_daily (
  project_id uuid not null,
  owner_id uuid not null,
  date date not null,
  search_type text not null default 'web',
  query text not null,
  page text not null,
  clicks double precision not null default 0,
  impressions double precision not null default 0,
  ctr double precision not null default 0,
  position double precision not null default 0,
  updated_at timestamptz not null default now(),
  primary key (project_id, date, search_type, query, page),
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

create index if not exists gsc_query_page_project_owner_fk_idx
  on public.gsc_query_page_daily(project_id,owner_id);


create or replace function public.get_gsc_query_page_insights(
  p_project_id uuid,
  p_days integer default 28,
  p_min_impressions integer default 100,
  p_limit integer default 250
)
returns jsonb
language sql
stable
set search_path to 'public'
as $function$
with bounds as (
  select max(date) as current_end
  from public.gsc_query_page_daily
  where project_id=p_project_id
),
dates as (
  select
    current_end,
    (current_end - greatest(p_days-1,0))::date as current_start,
    (current_end - p_days)::date as previous_end,
    (current_end - greatest((p_days*2)-1,0))::date as previous_start
  from bounds
),
period_agg as (
  select
    q.query,
    q.page,
    case
      when q.date between d.current_start and d.current_end then 'current'
      else 'previous'
    end as period,
    sum(q.clicks) as clicks,
    sum(q.impressions) as impressions,
    case when sum(q.impressions)>0 then sum(q.clicks)/sum(q.impressions) else 0 end as ctr,
    case when sum(q.impressions)>0
      then sum(q.position*q.impressions)/sum(q.impressions)
      else 0 end as position
  from public.gsc_query_page_daily q
  cross join dates d
  where q.project_id=p_project_id
    and d.current_end is not null
    and q.date between d.previous_start and d.current_end
  group by q.query,q.page,period
),
ranked as (
  select
    *,
    row_number() over (
      partition by query,period
      order by impressions desc,clicks desc,page
    ) as rn,
    count(*) over (partition by query,period) as page_count,
    sum(impressions) over (partition by query,period) as total_impressions,
    sum(clicks) over (partition by query,period) as total_clicks
  from period_agg
),
current_splits as (
  select
    query,
    max(page_count) as page_count,
    max(total_impressions) as total_impressions,
    max(total_clicks) as total_clicks,
    max(case when rn=1 then impressions else 0 end) as top_page_impressions,
    max(case when rn=1 then page else null end) as top_page,
    jsonb_agg(
      jsonb_build_object(
        'page',page,
        'clicks',clicks,
        'impressions',impressions,
        'ctr',ctr,
        'position',position,
        'share',
          case when total_impressions>0 then impressions/total_impressions else 0 end
      )
      order by rn
    ) filter (where rn<=5) as top_pages
  from ranked
  where period='current'
  group by query
),
ownership_splits as (
  select
    query,
    page_count,
    total_impressions,
    total_clicks,
    top_page,
    case
      when total_impressions>0 then top_page_impressions/total_impressions
      else 0
    end as top_page_share,
    coalesce(top_pages,'[]'::jsonb) as top_pages
  from current_splits
  where page_count>=2
    and total_impressions>=greatest(p_min_impressions,0)
    and (
      case when total_impressions>0
        then top_page_impressions/total_impressions
        else 1
      end
    ) <= 0.80
  order by total_impressions desc
  limit least(greatest(p_limit,1),1000)
),
current_top as (
  select query,page,total_impressions,total_clicks,impressions,clicks,position
  from ranked
  where period='current' and rn=1
),
previous_top as (
  select query,page,total_impressions,total_clicks,impressions,clicks,position
  from ranked
  where period='previous' and rn=1
),
url_switches as (
  select
    c.query,
    p.page as previous_top_page,
    c.page as current_top_page,
    p.total_impressions as previous_total_impressions,
    c.total_impressions as current_total_impressions,
    p.position as previous_top_page_position,
    c.position as current_top_page_position
  from current_top c
  join previous_top p using(query)
  where c.page<>p.page
    and greatest(c.total_impressions,p.total_impressions)>=greatest(p_min_impressions,0)
  order by greatest(c.total_impressions,p.total_impressions) desc
  limit least(greatest(p_limit,1),1000)
)
select jsonb_build_object(
  'available',(select current_end is not null from dates),
  'period',(select jsonb_build_object(
    'current_start',current_start,
    'current_end',current_end,
    'previous_start',previous_start,
    'previous_end',previous_end
  ) from dates),
  'ownership_splits',coalesce(
    (select jsonb_agg(to_jsonb(ownership_splits)) from ownership_splits),
    '[]'::jsonb
  ),
  'url_switches',coalesce(
    (select jsonb_agg(to_jsonb(url_switches)) from url_switches),
    '[]'::jsonb
  )
);
$function$;

create or replace function public.get_warehouse_coverage(
  p_project_id uuid,
  p_days integer default 28
)
returns jsonb
language sql
stable
set search_path to 'public'
as $function$
with gsc_bounds as (
  select max(date) as current_end
  from public.gsc_query_daily
  where project_id=p_project_id
),
gsc_dates as (
  select
    current_end,
    (current_end - greatest(p_days-1,0))::date as current_start,
    (current_end - p_days)::date as previous_end,
    (current_end - greatest((p_days*2)-1,0))::date as previous_start
  from gsc_bounds
),
gsc_coverage as (
  select
    count(distinct q.date) filter (
      where q.date between d.current_start and d.current_end
    ) as current_days,
    count(distinct q.date) filter (
      where q.date between d.previous_start and d.previous_end
    ) as previous_days,
    min(q.date) as min_date,
    max(q.date) as max_date
  from public.gsc_query_daily q
  cross join gsc_dates d
  where q.project_id=p_project_id
    and d.current_end is not null
    and q.date between d.previous_start and d.current_end
),
gsc_qp_coverage as (
  select
    count(distinct q.date) filter (
      where q.date between d.current_start and d.current_end
    ) as current_days,
    count(distinct q.date) filter (
      where q.date between d.previous_start and d.previous_end
    ) as previous_days,
    min(q.date) as min_date,
    max(q.date) as max_date
  from public.gsc_query_page_daily q
  cross join gsc_dates d
  where q.project_id=p_project_id
    and d.current_end is not null
    and q.date between d.previous_start and d.current_end
),
ga4_bounds as (
  select max(date) as current_end
  from public.ga4_landing_page_daily
  where project_id=p_project_id
),
ga4_dates as (
  select
    current_end,
    (current_end - greatest(p_days-1,0))::date as current_start,
    (current_end - p_days)::date as previous_end,
    (current_end - greatest((p_days*2)-1,0))::date as previous_start
  from ga4_bounds
),
ga4_coverage as (
  select
    count(distinct g.date) filter (
      where g.date between d.current_start and d.current_end
    ) as current_days,
    count(distinct g.date) filter (
      where g.date between d.previous_start and d.previous_end
    ) as previous_days,
    min(g.date) as min_date,
    max(g.date) as max_date
  from public.ga4_landing_page_daily g
  cross join ga4_dates d
  where g.project_id=p_project_id
    and d.current_end is not null
    and g.date between d.previous_start and d.current_end
)
select jsonb_build_object(
  'window_days',p_days,
  'gsc',jsonb_build_object(
    'current_days',coalesce((select current_days from gsc_coverage),0),
    'previous_days',coalesce((select previous_days from gsc_coverage),0),
    'min_date',(select min_date from gsc_coverage),
    'max_date',(select max_date from gsc_coverage)
  ),
  'gsc_query_page',jsonb_build_object(
    'current_days',coalesce((select current_days from gsc_qp_coverage),0),
    'previous_days',coalesce((select previous_days from gsc_qp_coverage),0),
    'min_date',(select min_date from gsc_qp_coverage),
    'max_date',(select max_date from gsc_qp_coverage)
  ),
  'ga4',jsonb_build_object(
    'current_days',coalesce((select current_days from ga4_coverage),0),
    'previous_days',coalesce((select previous_days from ga4_coverage),0),
    'min_date',(select min_date from ga4_coverage),
    'max_date',(select max_date from ga4_coverage)
  )
);
$function$;

-- Production grants EXECUTE on these RLS-respecting SQL functions to
-- authenticated and service_role, while revoking PUBLIC/anon access.
