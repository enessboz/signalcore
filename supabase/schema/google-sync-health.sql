-- SignalCore Google sync health ledger.
-- Tracks date-level ingestion independently of whether a valid date returned zero rows.

create table if not exists public.google_sync_date_log (
  project_id uuid not null,
  owner_id uuid not null,
  source text not null check (source in ('gsc','ga4')),
  date date not null,
  status text not null check (status in ('succeeded','failed')),
  total_rows bigint not null default 0,
  dataset_rows jsonb not null default '{}'::jsonb,
  attempt_count integer not null default 0,
  last_error text,
  first_attempt_at timestamptz not null default now(),
  last_attempt_at timestamptz not null default now(),
  succeeded_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (project_id,source,date),
  foreign key (project_id,owner_id)
    references public.projects(id,owner_id) on delete cascade
);

create index if not exists google_sync_date_log_project_source_date_idx
  on public.google_sync_date_log(project_id,source,date desc);

create index if not exists google_sync_date_log_failed_idx
  on public.google_sync_date_log(project_id,source,status,date desc);

create index if not exists google_sync_date_log_project_owner_fk_idx
  on public.google_sync_date_log(project_id,owner_id);

alter table public.google_sync_date_log enable row level security;

drop policy if exists "google_sync_date_log_select_own" on public.google_sync_date_log;
create policy "google_sync_date_log_select_own"
on public.google_sync_date_log
for select
to authenticated
using (owner_id = auth.uid());

grant select on public.google_sync_date_log to authenticated;
grant select,insert,update,delete on public.google_sync_date_log to service_role;

create or replace function public.get_google_warehouse_health(p_project_id uuid)
returns jsonb
language sql
stable
set search_path to 'public'
as $function$
with project_row as (
  select id,owner_id
  from public.projects
  where id=p_project_id
    and (owner_id=auth.uid() or auth.role()='service_role')
),
sources(source) as (
  values ('gsc'::text),('ga4'::text)
),
targets as (
  select
    q.source,
    min(q.start_date)::date as target_start,
    max(q.end_date)::date as target_end,
    count(*) filter (where q.status='queued')::int as queued_jobs,
    count(*) filter (where q.status='running')::int as running_jobs,
    count(*) filter (where q.status='failed')::int as failed_jobs
  from public.google_sync_queue q
  join project_row p on p.id=q.project_id and p.owner_id=q.owner_id
  where q.status <> 'cancelled'
  group by q.source
),
logs as (
  select
    l.source,
    min(l.date) filter (where l.status='succeeded') as min_success_date,
    max(l.date) filter (where l.status='succeeded') as max_success_date,
    count(*) filter (where l.status='succeeded')::int as succeeded_dates,
    count(*) filter (where l.status='failed')::int as failed_dates,
    max(l.last_attempt_at) as last_attempt_at
  from public.google_sync_date_log l
  join project_row p on p.id=l.project_id and p.owner_id=l.owner_id
  group by l.source
),
source_health as (
  select
    s.source,
    t.target_start,
    t.target_end,
    coalesce(t.queued_jobs,0) as queued_jobs,
    coalesce(t.running_jobs,0) as running_jobs,
    coalesce(t.failed_jobs,0) as failed_jobs,
    l.min_success_date,
    l.max_success_date,
    coalesce(l.succeeded_dates,0) as succeeded_dates,
    coalesce(l.failed_dates,0) as failed_dates,
    l.last_attempt_at,
    case
      when t.target_start is null or t.target_end is null then 0
      else greatest((t.target_end - t.target_start) + 1,0)
    end::int as target_days
  from sources s
  left join targets t on t.source=s.source
  left join logs l on l.source=s.source
),
with_missing as (
  select
    h.*,
    case
      when h.target_days=0 then 0
      else greatest(h.target_days-h.succeeded_dates,0)
    end::int as missing_days,
    case
      when h.target_days=0 then 0::numeric
      else round((h.succeeded_dates::numeric/h.target_days::numeric)*100,2)
    end as coverage_percent,
    case
      when h.max_success_date is null then null
      else (current_date-h.max_success_date)::int
    end as freshness_days
  from source_health h
),
missing_samples as (
  select
    h.source,
    coalesce(
      (
        select jsonb_agg(d order by d)
        from (
          select gs::date as d
          from generate_series(h.target_start,h.target_end,interval '1 day') gs
          where h.target_start is not null
            and h.target_end is not null
            and not exists (
              select 1
              from public.google_sync_date_log l
              join project_row p on p.id=l.project_id and p.owner_id=l.owner_id
              where l.project_id=p_project_id
                and l.source=h.source
                and l.date=gs::date
                and l.status='succeeded'
            )
          order by gs
          limit 10
        ) gaps
      ),
      '[]'::jsonb
    ) as missing_date_sample
  from with_missing h
)
select jsonb_build_object(
  'project_id',p_project_id,
  'generated_at',now(),
  'sources',
  coalesce(
    (
      select jsonb_object_agg(
        h.source,
        jsonb_build_object(
          'target_start',h.target_start,
          'target_end',h.target_end,
          'target_days',h.target_days,
          'succeeded_dates',h.succeeded_dates,
          'failed_dates',h.failed_dates,
          'missing_days',h.missing_days,
          'coverage_percent',h.coverage_percent,
          'min_success_date',h.min_success_date,
          'max_success_date',h.max_success_date,
          'freshness_days',h.freshness_days,
          'queued_jobs',h.queued_jobs,
          'running_jobs',h.running_jobs,
          'failed_jobs',h.failed_jobs,
          'last_attempt_at',h.last_attempt_at,
          'missing_date_sample',m.missing_date_sample
        )
      )
      from with_missing h
      join missing_samples m on m.source=h.source
    ),
    '{}'::jsonb
  )
)
from project_row;
$function$;
