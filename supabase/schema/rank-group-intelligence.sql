-- Dynamic GSC query groups for Rank Tracker.

create or replace function public.get_gsc_top_queries(
  p_project_id uuid,
  p_days integer default 28,
  p_metric text default 'clicks',
  p_limit integer default 20
)
returns jsonb
language sql
stable
security invoker
set search_path to 'public'
as $function$
with bounds as (
  select max(date) as current_end
  from public.google_sync_date_log
  where project_id=p_project_id
    and source='gsc'
    and status='succeeded'
),
dates as (
  select
    current_end,
    case when current_end is null then null
      else (current_end - greatest(least(p_days,480)-1,0))::date
    end as current_start
  from bounds
),
coverage as (
  select count(distinct l.date)::integer as days
  from public.google_sync_date_log l
  cross join dates d
  where l.project_id=p_project_id
    and l.source='gsc'
    and l.status='succeeded'
    and d.current_end is not null
    and l.date between d.current_start and d.current_end
),
agg as (
  select
    q.query,
    sum(q.clicks)::numeric as clicks,
    sum(q.impressions)::numeric as impressions,
    case when sum(q.impressions)>0
      then (sum(q.clicks)/sum(q.impressions))::numeric
      else 0::numeric
    end as ctr,
    case when sum(q.impressions)>0
      then (sum(q.position*q.impressions)/sum(q.impressions))::numeric
      else 0::numeric
    end as position
  from public.gsc_query_daily q
  cross join dates d
  where q.project_id=p_project_id
    and d.current_end is not null
    and q.date between d.current_start and d.current_end
  group by q.query
),
ranked as (
  select
    *,
    row_number() over (
      order by
        case when p_metric='impressions' then impressions else clicks end desc,
        case when p_metric='impressions' then clicks else impressions end desc,
        query
    )::integer as rank_order
  from agg
)
select jsonb_build_object(
  'available',
    (select current_end is not null from dates)
    and coalesce((select days from coverage),0) >= least(greatest(p_days,1),480),
  'metric',case when p_metric='impressions' then 'impressions' else 'clicks' end,
  'requested_days',least(greatest(p_days,1),480),
  'coverage_days',coalesce((select days from coverage),0),
  'current_start',(select current_start from dates),
  'current_end',(select current_end from dates),
  'rows',coalesce(
    (
      select jsonb_agg(
        jsonb_build_object(
          'query',query,
          'clicks',clicks,
          'impressions',impressions,
          'ctr',ctr,
          'position',position,
          'rank_order',rank_order
        )
        order by rank_order
      )
      from ranked
      where rank_order <= least(greatest(p_limit,1),100)
    ),
    '[]'::jsonb
  )
);
$function$;

revoke all on function public.get_gsc_top_queries(uuid,integer,text,integer)
  from public,anon;
grant execute on function public.get_gsc_top_queries(uuid,integer,text,integer)
  to authenticated,service_role;
