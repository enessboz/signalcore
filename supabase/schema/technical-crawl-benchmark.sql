-- SignalCore technical crawl production benchmark and finding review layer.

create table if not exists public.crawl_finding_reviews (
  id uuid primary key default gen_random_uuid(),
  crawl_run_id uuid not null references public.crawl_runs(id) on delete cascade,
  finding_id uuid not null references public.findings(id) on delete cascade,
  project_id uuid not null,
  owner_id uuid not null,
  verdict text not null
    check (verdict in ('confirmed','false_positive','needs_context')),
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (project_id,owner_id)
    references public.projects(id,owner_id) on delete cascade,
  unique(crawl_run_id,finding_id,owner_id)
);

create index if not exists crawl_finding_reviews_run_idx
  on public.crawl_finding_reviews(crawl_run_id,verdict);
create index if not exists crawl_finding_reviews_finding_idx
  on public.crawl_finding_reviews(finding_id);
create index if not exists crawl_finding_reviews_project_owner_fk_idx
  on public.crawl_finding_reviews(project_id,owner_id);

alter table public.crawl_finding_reviews enable row level security;
grant select,insert,update,delete on public.crawl_finding_reviews to authenticated;
grant select,insert,update,delete on public.crawl_finding_reviews to service_role;

drop policy if exists crawl_finding_reviews_select_own on public.crawl_finding_reviews;
create policy crawl_finding_reviews_select_own
on public.crawl_finding_reviews for select to authenticated
using (owner_id=(select auth.uid()));

drop policy if exists crawl_finding_reviews_insert_own on public.crawl_finding_reviews;
create policy crawl_finding_reviews_insert_own
on public.crawl_finding_reviews for insert to authenticated
with check (owner_id=(select auth.uid()));

drop policy if exists crawl_finding_reviews_update_own on public.crawl_finding_reviews;
create policy crawl_finding_reviews_update_own
on public.crawl_finding_reviews for update to authenticated
using (owner_id=(select auth.uid()))
with check (owner_id=(select auth.uid()));

drop policy if exists crawl_finding_reviews_delete_own on public.crawl_finding_reviews;
create policy crawl_finding_reviews_delete_own
on public.crawl_finding_reviews for delete to authenticated
using (owner_id=(select auth.uid()));

create or replace function public.get_crawl_run_benchmark(p_run_id uuid)
returns jsonb
language sql
stable
set search_path to 'public'
as $function$
with run_row as (
  select r.*
  from public.crawl_runs r
  where r.id=p_run_id
    and (r.owner_id=(select auth.uid()) or (select auth.role())='service_role')
),
page_stats as (
  select
    count(*)::bigint as page_count,
    coalesce(sum(pg_column_size(p)),0)::bigint as page_bytes,
    count(*) filter (where p.rendered)::bigint as rendered_pages
  from public.crawl_pages p
  join run_row r on r.id=p.crawl_run_id
),
link_stats as (
  select
    count(*)::bigint as link_count,
    coalesce(sum(pg_column_size(l)),0)::bigint as link_bytes
  from public.crawl_links l
  join run_row r on r.id=l.crawl_run_id
),
finding_stats as (
  select count(*)::bigint as finding_count
  from public.findings f
  join run_row r
    on f.project_id=r.project_id
   and f.owner_id=r.owner_id
  where f.metadata->>'crawl_run_id'=r.id::text
),
review_stats as (
  select
    count(*)::bigint as reviewed_count,
    count(*) filter (where verdict='confirmed')::bigint as confirmed_count,
    count(*) filter (where verdict='false_positive')::bigint as false_positive_count,
    count(*) filter (where verdict='needs_context')::bigint as needs_context_count
  from public.crawl_finding_reviews v
  join run_row r on r.id=v.crawl_run_id
),
performance_stats as (
  select count(*)::bigint as performance_samples
  from public.crawl_performance_results p
  join run_row r on r.id=p.crawl_run_id
)
select jsonb_build_object(
  'run_id',r.id,
  'status',r.status,
  'execution_mode',r.execution_mode,
  'max_urls',r.max_urls,
  'pages_discovered',r.pages_discovered,
  'pages_crawled',r.pages_crawled,
  'error_count',r.error_count,
  'started_at',r.started_at,
  'completed_at',r.completed_at,
  'duration_ms',
    case
      when r.started_at is null then null
      else round(
        extract(epoch from (coalesce(r.completed_at,now())-r.started_at))*1000
      )::bigint
    end,
  'pages_per_minute',
    case
      when r.started_at is null
        or extract(epoch from (coalesce(r.completed_at,now())-r.started_at)) <= 0
      then null
      else round(
        ps.page_count::numeric /
        (extract(epoch from (coalesce(r.completed_at,now())-r.started_at))/60.0),
        2
      )
    end,
  'page_rows',ps.page_count,
  'page_bytes',ps.page_bytes,
  'link_rows',ls.link_count,
  'link_bytes',ls.link_bytes,
  'estimated_run_bytes',ps.page_bytes+ls.link_bytes,
  'rendered_pages',ps.rendered_pages,
  'performance_samples',perf.performance_samples,
  'finding_count',fs.finding_count,
  'reviewed_findings',rs.reviewed_count,
  'confirmed_findings',rs.confirmed_count,
  'false_positive_findings',rs.false_positive_count,
  'needs_context_findings',rs.needs_context_count,
  'false_positive_ratio',
    case when rs.reviewed_count=0 then null
    else round(rs.false_positive_count::numeric/rs.reviewed_count::numeric*100,2)
    end
)
from run_row r
cross join page_stats ps
cross join link_stats ls
cross join finding_stats fs
cross join review_stats rs
cross join performance_stats perf;
$function$;
