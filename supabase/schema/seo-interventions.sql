-- SEO Intervention Monitoring V1
-- Records implemented SEO changes and evaluates post-change movement at D+7/D+14/D+28.

create table if not exists public.seo_interventions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null,
  owner_id uuid not null,
  title text not null,
  intervention_type text not null default 'content'
    check (intervention_type in (
      'content','title_meta','internal_links','technical','schema',
      'site_structure','migration','other'
    )),
  implemented_at date not null,
  hypothesis text,
  notes text,
  scope_mode text not null default 'targeted'
    check (scope_mode in ('targeted','project')),
  status text not null default 'monitoring'
    check (status in ('monitoring','completed','cancelled')),
  gsc_lag_days integer not null default 3 check (gsc_lag_days between 0 and 14),
  ga4_lag_days integer not null default 1 check (ga4_lag_days between 0 and 14),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key(project_id,owner_id)
    references public.projects(id,owner_id) on delete cascade,
  unique(id,project_id,owner_id)
);

create table if not exists public.seo_intervention_urls (
  id uuid primary key default gen_random_uuid(),
  intervention_id uuid not null,
  project_id uuid not null,
  owner_id uuid not null,
  url text not null,
  url_path text not null default '/',
  created_at timestamptz not null default now(),
  foreign key(intervention_id,project_id,owner_id)
    references public.seo_interventions(id,project_id,owner_id) on delete cascade,
  unique(intervention_id,url)
);

create table if not exists public.seo_intervention_queries (
  id uuid primary key default gen_random_uuid(),
  intervention_id uuid not null,
  project_id uuid not null,
  owner_id uuid not null,
  query text not null,
  created_at timestamptz not null default now(),
  foreign key(intervention_id,project_id,owner_id)
    references public.seo_interventions(id,project_id,owner_id) on delete cascade,
  unique(intervention_id,query)
);

create table if not exists public.seo_intervention_checks (
  id uuid primary key default gen_random_uuid(),
  intervention_id uuid not null,
  project_id uuid not null,
  owner_id uuid not null,
  checkpoint_days integer not null check (checkpoint_days between 1 and 180),
  due_date date not null,
  status text not null default 'pending'
    check (status in ('pending','evaluated','skipped','failed')),
  result_class text
    check (result_class is null or result_class in (
      'improved','declined','mixed','no_change','insufficient_data'
    )),
  metrics jsonb not null default '{}'::jsonb,
  summary text,
  evaluated_at timestamptz,
  last_attempt_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key(intervention_id,project_id,owner_id)
    references public.seo_interventions(id,project_id,owner_id) on delete cascade,
  unique(intervention_id,checkpoint_days)
);

create index if not exists seo_interventions_project_date_idx
  on public.seo_interventions(project_id,implemented_at desc);
create index if not exists seo_interventions_project_owner_fk_idx
  on public.seo_interventions(project_id,owner_id);
create index if not exists seo_intervention_urls_parent_idx
  on public.seo_intervention_urls(intervention_id);
create index if not exists seo_intervention_urls_project_owner_fk_idx
  on public.seo_intervention_urls(project_id,owner_id);
create index if not exists seo_intervention_queries_parent_idx
  on public.seo_intervention_queries(intervention_id);
create index if not exists seo_intervention_queries_project_owner_fk_idx
  on public.seo_intervention_queries(project_id,owner_id);
create index if not exists seo_intervention_checks_due_idx
  on public.seo_intervention_checks(status,due_date);
create index if not exists seo_intervention_checks_project_idx
  on public.seo_intervention_checks(project_id,status,due_date);
create index if not exists seo_intervention_checks_project_owner_fk_idx
  on public.seo_intervention_checks(project_id,owner_id);
create index if not exists seo_int_urls_parent_project_owner_idx
  on public.seo_intervention_urls(intervention_id,project_id,owner_id);
create index if not exists seo_int_queries_parent_project_owner_idx
  on public.seo_intervention_queries(intervention_id,project_id,owner_id);
create index if not exists seo_int_checks_parent_project_owner_idx
  on public.seo_intervention_checks(intervention_id,project_id,owner_id);

grant select,insert,update,delete on public.seo_interventions to authenticated;
grant select,insert,update,delete on public.seo_intervention_urls to authenticated;
grant select,insert,update,delete on public.seo_intervention_queries to authenticated;
grant select,insert,update,delete on public.seo_intervention_checks to authenticated;

alter table public.seo_interventions enable row level security;
alter table public.seo_intervention_urls enable row level security;
alter table public.seo_intervention_queries enable row level security;
alter table public.seo_intervention_checks enable row level security;

drop policy if exists seo_interventions_select_own on public.seo_interventions;
create policy seo_interventions_select_own on public.seo_interventions
  for select to authenticated using ((select auth.uid())=owner_id);
drop policy if exists seo_interventions_insert_own on public.seo_interventions;
create policy seo_interventions_insert_own on public.seo_interventions
  for insert to authenticated with check ((select auth.uid())=owner_id);
drop policy if exists seo_interventions_update_own on public.seo_interventions;
create policy seo_interventions_update_own on public.seo_interventions
  for update to authenticated using ((select auth.uid())=owner_id)
  with check ((select auth.uid())=owner_id);
drop policy if exists seo_interventions_delete_own on public.seo_interventions;
create policy seo_interventions_delete_own on public.seo_interventions
  for delete to authenticated using ((select auth.uid())=owner_id);

drop policy if exists seo_intervention_urls_select_own on public.seo_intervention_urls;
create policy seo_intervention_urls_select_own on public.seo_intervention_urls
  for select to authenticated using ((select auth.uid())=owner_id);
drop policy if exists seo_intervention_urls_insert_own on public.seo_intervention_urls;
create policy seo_intervention_urls_insert_own on public.seo_intervention_urls
  for insert to authenticated with check ((select auth.uid())=owner_id);
drop policy if exists seo_intervention_urls_update_own on public.seo_intervention_urls;
create policy seo_intervention_urls_update_own on public.seo_intervention_urls
  for update to authenticated using ((select auth.uid())=owner_id)
  with check ((select auth.uid())=owner_id);
drop policy if exists seo_intervention_urls_delete_own on public.seo_intervention_urls;
create policy seo_intervention_urls_delete_own on public.seo_intervention_urls
  for delete to authenticated using ((select auth.uid())=owner_id);

drop policy if exists seo_intervention_queries_select_own on public.seo_intervention_queries;
create policy seo_intervention_queries_select_own on public.seo_intervention_queries
  for select to authenticated using ((select auth.uid())=owner_id);
drop policy if exists seo_intervention_queries_insert_own on public.seo_intervention_queries;
create policy seo_intervention_queries_insert_own on public.seo_intervention_queries
  for insert to authenticated with check ((select auth.uid())=owner_id);
drop policy if exists seo_intervention_queries_update_own on public.seo_intervention_queries;
create policy seo_intervention_queries_update_own on public.seo_intervention_queries
  for update to authenticated using ((select auth.uid())=owner_id)
  with check ((select auth.uid())=owner_id);
drop policy if exists seo_intervention_queries_delete_own on public.seo_intervention_queries;
create policy seo_intervention_queries_delete_own on public.seo_intervention_queries
  for delete to authenticated using ((select auth.uid())=owner_id);

drop policy if exists seo_intervention_checks_select_own on public.seo_intervention_checks;
create policy seo_intervention_checks_select_own on public.seo_intervention_checks
  for select to authenticated using ((select auth.uid())=owner_id);
drop policy if exists seo_intervention_checks_insert_own on public.seo_intervention_checks;
create policy seo_intervention_checks_insert_own on public.seo_intervention_checks
  for insert to authenticated with check ((select auth.uid())=owner_id);
drop policy if exists seo_intervention_checks_update_own on public.seo_intervention_checks;
create policy seo_intervention_checks_update_own on public.seo_intervention_checks
  for update to authenticated using ((select auth.uid())=owner_id)
  with check ((select auth.uid())=owner_id);
drop policy if exists seo_intervention_checks_delete_own on public.seo_intervention_checks;
create policy seo_intervention_checks_delete_own on public.seo_intervention_checks
  for delete to authenticated using ((select auth.uid())=owner_id);

create or replace function public.get_seo_intervention_metrics(
  p_intervention_id uuid,
  p_checkpoint_days integer
)
returns jsonb
language sql
stable
set search_path to 'public'
as $function$
with intervention as (
  select id,project_id,owner_id,implemented_at,scope_mode
  from public.seo_interventions
  where id=p_intervention_id
),
bounds as (
  select
    *,
    (implemented_at-p_checkpoint_days)::date as baseline_start,
    (implemented_at-1)::date as baseline_end,
    (implemented_at+1)::date as post_start,
    (implemented_at+p_checkpoint_days)::date as post_end
  from intervention
),
target_queries as (
  select lower(trim(query)) as query
  from public.seo_intervention_queries
  where intervention_id=p_intervention_id
),
target_urls as (
  select regexp_replace(url,'/+$','') as url_key,url_path
  from public.seo_intervention_urls
  where intervention_id=p_intervention_id
),
counts as (
  select
    (select count(*) from target_queries) as query_count,
    (select count(*) from target_urls) as url_count
),
gsc_query_period as (
  select
    case when q.date between b.baseline_start and b.baseline_end
      then 'baseline' else 'post' end as period,
    sum(q.clicks) as clicks,
    sum(q.impressions) as impressions,
    case when sum(q.impressions)>0 then sum(q.clicks)/sum(q.impressions) else 0 end as ctr,
    case when sum(q.impressions)>0
      then sum(q.position*q.impressions)/sum(q.impressions)
      else 0 end as position
  from public.gsc_query_daily q
  cross join bounds b
  cross join counts c
  where q.project_id=b.project_id
    and q.date between b.baseline_start and b.post_end
    and (
      c.query_count=0
      or lower(trim(q.query)) in (select query from target_queries)
    )
  group by period
),
gsc_page_period as (
  select
    case when p.date between b.baseline_start and b.baseline_end
      then 'baseline' else 'post' end as period,
    sum(p.clicks) as clicks,
    sum(p.impressions) as impressions,
    case when sum(p.impressions)>0 then sum(p.clicks)/sum(p.impressions) else 0 end as ctr,
    case when sum(p.impressions)>0
      then sum(p.position*p.impressions)/sum(p.impressions)
      else 0 end as position
  from public.gsc_page_daily p
  cross join bounds b
  cross join counts c
  where p.project_id=b.project_id
    and p.date between b.baseline_start and b.post_end
    and (
      b.scope_mode='project'
      or c.url_count=0
      or regexp_replace(p.page,'/+$','') in (select url_key from target_urls)
    )
  group by period
),
ga4_period as (
  select
    case when g.date between b.baseline_start and b.baseline_end
      then 'baseline' else 'post' end as period,
    sum(g.sessions) as sessions,
    sum(g.active_users) as active_users,
    sum(g.key_events) as key_events,
    case when sum(g.sessions)>0
      then sum(g.engaged_sessions)/sum(g.sessions)
      else 0 end as engagement_rate
  from public.ga4_landing_page_daily g
  cross join bounds b
  cross join counts c
  where g.project_id=b.project_id
    and g.date between b.baseline_start and b.post_end
    and lower(g.channel_group) in (
      'organic search','organic social','organic video','organic shopping'
    )
    and (
      b.scope_mode='project'
      or c.url_count=0
      or split_part(g.landing_page,'?',1) in (select url_path from target_urls)
    )
  group by period
),
coverage as (
  select jsonb_build_object(
    'gsc_query_baseline_days',(
      select count(distinct q.date)
      from public.gsc_query_daily q cross join bounds b
      where q.project_id=b.project_id
        and q.date between b.baseline_start and b.baseline_end
    ),
    'gsc_query_post_days',(
      select count(distinct q.date)
      from public.gsc_query_daily q cross join bounds b
      where q.project_id=b.project_id
        and q.date between b.post_start and b.post_end
    ),
    'gsc_page_baseline_days',(
      select count(distinct p.date)
      from public.gsc_page_daily p cross join bounds b
      where p.project_id=b.project_id
        and p.date between b.baseline_start and b.baseline_end
    ),
    'gsc_page_post_days',(
      select count(distinct p.date)
      from public.gsc_page_daily p cross join bounds b
      where p.project_id=b.project_id
        and p.date between b.post_start and b.post_end
    ),
    'ga4_baseline_days',(
      select count(distinct g.date)
      from public.ga4_landing_page_daily g cross join bounds b
      where g.project_id=b.project_id
        and g.date between b.baseline_start and b.baseline_end
    ),
    'ga4_post_days',(
      select count(distinct g.date)
      from public.ga4_landing_page_daily g cross join bounds b
      where g.project_id=b.project_id
        and g.date between b.post_start and b.post_end
    )
  ) as data
)
select jsonb_build_object(
  'intervention_id',p_intervention_id,
  'checkpoint_days',p_checkpoint_days,
  'period',(select jsonb_build_object(
    'baseline_start',baseline_start,
    'baseline_end',baseline_end,
    'post_start',post_start,
    'post_end',post_end
  ) from bounds),
  'scope',(select jsonb_build_object(
    'mode',scope_mode,
    'query_count',query_count,
    'url_count',url_count
  ) from bounds cross join counts),
  'coverage',(select data from coverage),
  'gsc_query',jsonb_build_object(
    'baseline',coalesce(
      (select to_jsonb(x) from gsc_query_period x where period='baseline'),
      '{"clicks":0,"impressions":0,"ctr":0,"position":0}'::jsonb
    ),
    'post',coalesce(
      (select to_jsonb(x) from gsc_query_period x where period='post'),
      '{"clicks":0,"impressions":0,"ctr":0,"position":0}'::jsonb
    )
  ),
  'gsc_page',jsonb_build_object(
    'baseline',coalesce(
      (select to_jsonb(x) from gsc_page_period x where period='baseline'),
      '{"clicks":0,"impressions":0,"ctr":0,"position":0}'::jsonb
    ),
    'post',coalesce(
      (select to_jsonb(x) from gsc_page_period x where period='post'),
      '{"clicks":0,"impressions":0,"ctr":0,"position":0}'::jsonb
    )
  ),
  'ga4',jsonb_build_object(
    'baseline',coalesce(
      (select to_jsonb(x) from ga4_period x where period='baseline'),
      '{"sessions":0,"active_users":0,"key_events":0,"engagement_rate":0}'::jsonb
    ),
    'post',coalesce(
      (select to_jsonb(x) from ga4_period x where period='post'),
      '{"sessions":0,"active_users":0,"key_events":0,"engagement_rate":0}'::jsonb
    )
  )
);
$function$;

revoke all on function public.get_seo_intervention_metrics(uuid,integer) from public;
revoke all on function public.get_seo_intervention_metrics(uuid,integer) from anon;
grant execute on function public.get_seo_intervention_metrics(uuid,integer) to authenticated;
grant execute on function public.get_seo_intervention_metrics(uuid,integer) to service_role;
