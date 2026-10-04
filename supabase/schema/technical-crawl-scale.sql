-- SignalCore Technical Crawl scale layer.
-- Queue-based distributed crawling, robots audit, near-duplicate fingerprints
-- and selective performance auditing.

alter table public.crawl_runs
  drop constraint if exists crawl_runs_max_urls_check;
alter table public.crawl_runs
  add constraint crawl_runs_max_urls_check
  check (max_urls between 1 and 100000);

alter table public.crawl_runs
  add column if not exists execution_mode text not null default 'inline'
    check (execution_mode in ('inline','queue')),
  add column if not exists queue_started_at timestamptz,
  add column if not exists queue_completed_at timestamptz,
  add column if not exists robots_compliant boolean not null default true,
  add column if not exists js_render_mode text not null default 'off'
    check (js_render_mode in ('off','auto','always'));

alter table public.technical_crawl_schedules
  drop constraint if exists technical_crawl_schedules_max_urls_check;
alter table public.technical_crawl_schedules
  add constraint technical_crawl_schedules_max_urls_check
  check (max_urls between 1 and 100000);

alter table public.technical_crawl_schedules
  add column if not exists batch_size integer not null default 50
    check (batch_size between 5 and 100),
  add column if not exists min_delay_ms integer not null default 250
    check (min_delay_ms between 0 and 10000),
  add column if not exists respect_robots boolean not null default true,
  add column if not exists js_render_mode text not null default 'off'
    check (js_render_mode in ('off','auto','always')),
  add column if not exists pagespeed_enabled boolean not null default false,
  add column if not exists pagespeed_sample_size integer not null default 20
    check (pagespeed_sample_size between 0 and 100);

create table if not exists public.crawl_url_queue (
  id uuid primary key default gen_random_uuid(),
  crawl_run_id uuid not null references public.crawl_runs(id) on delete cascade,
  project_id uuid not null,
  owner_id uuid not null,
  url text not null,
  normalized_url text not null,
  depth integer not null default 0 check (depth between 0 and 1000),
  source text not null default 'link'
    check (source in ('seed','sitemap','link','redirect','manual')),
  discovered_from text,
  priority integer not null default 50,
  status text not null default 'queued'
    check (status in ('queued','claimed','succeeded','failed','skipped')),
  attempts integer not null default 0 check (attempts between 0 and 20),
  max_attempts integer not null default 3 check (max_attempts between 1 and 20),
  available_at timestamptz not null default now(),
  claimed_at timestamptz,
  claim_token uuid,
  robots_allowed boolean,
  render_mode text not null default 'http'
    check (render_mode in ('http','js')),
  last_error text,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (project_id,owner_id)
    references public.projects(id,owner_id) on delete cascade,
  unique(crawl_run_id,normalized_url)
);

create index if not exists crawl_url_queue_claim_idx
  on public.crawl_url_queue(crawl_run_id,status,available_at,priority desc,depth,created_at);
create index if not exists crawl_url_queue_owner_run_idx
  on public.crawl_url_queue(owner_id,crawl_run_id,status);
create index if not exists crawl_url_queue_project_owner_fk_idx
  on public.crawl_url_queue(project_id,owner_id);

alter table public.crawl_url_queue enable row level security;
grant select on public.crawl_url_queue to authenticated;
grant select,insert,update,delete on public.crawl_url_queue to service_role;

drop policy if exists crawl_url_queue_select_own on public.crawl_url_queue;
create policy crawl_url_queue_select_own
on public.crawl_url_queue for select to authenticated
using (owner_id=(select auth.uid()));

create table if not exists public.crawl_robots_audits (
  id uuid primary key default gen_random_uuid(),
  crawl_run_id uuid not null unique references public.crawl_runs(id) on delete cascade,
  project_id uuid not null,
  owner_id uuid not null,
  robots_url text not null,
  status_code integer,
  fetch_status text not null
    check (fetch_status in ('succeeded','missing','failed')),
  content_hash text,
  rules jsonb not null default '{}'::jsonb,
  sitemap_urls jsonb not null default '[]'::jsonb,
  crawl_delay_ms integer,
  blocks_all boolean not null default false,
  error text,
  fetched_at timestamptz not null default now(),
  foreign key (project_id,owner_id)
    references public.projects(id,owner_id) on delete cascade
);

create index if not exists crawl_robots_audits_project_owner_fk_idx
  on public.crawl_robots_audits(project_id,owner_id);

alter table public.crawl_robots_audits enable row level security;
grant select on public.crawl_robots_audits to authenticated;
grant select,insert,update,delete on public.crawl_robots_audits to service_role;

drop policy if exists crawl_robots_audits_select_own on public.crawl_robots_audits;
create policy crawl_robots_audits_select_own
on public.crawl_robots_audits for select to authenticated
using (owner_id=(select auth.uid()));

alter table public.crawl_pages
  add column if not exists content_simhash text,
  add column if not exists near_duplicate_group text,
  add column if not exists rendered boolean not null default false,
  add column if not exists render_reason text;

create index if not exists crawl_pages_run_simhash_idx
  on public.crawl_pages(crawl_run_id,content_simhash)
  where content_simhash is not null;

create table if not exists public.crawl_performance_queue (
  id uuid primary key default gen_random_uuid(),
  crawl_run_id uuid not null references public.crawl_runs(id) on delete cascade,
  project_id uuid not null,
  owner_id uuid not null,
  url text not null,
  strategy text not null default 'mobile'
    check (strategy in ('mobile','desktop')),
  status text not null default 'queued'
    check (status in ('queued','running','succeeded','failed','skipped')),
  attempts integer not null default 0,
  available_at timestamptz not null default now(),
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(crawl_run_id,url,strategy),
  foreign key (project_id,owner_id)
    references public.projects(id,owner_id) on delete cascade
);

create table if not exists public.crawl_performance_results (
  id uuid primary key default gen_random_uuid(),
  crawl_run_id uuid not null references public.crawl_runs(id) on delete cascade,
  project_id uuid not null,
  owner_id uuid not null,
  url text not null,
  strategy text not null check (strategy in ('mobile','desktop')),
  performance_score numeric(6,3),
  lcp_ms numeric(12,2),
  cls numeric(12,5),
  inp_ms numeric(12,2),
  fcp_ms numeric(12,2),
  tbt_ms numeric(12,2),
  field_data jsonb not null default '{}'::jsonb,
  lab_data jsonb not null default '{}'::jsonb,
  raw_category jsonb not null default '{}'::jsonb,
  fetched_at timestamptz not null default now(),
  unique(crawl_run_id,url,strategy),
  foreign key (project_id,owner_id)
    references public.projects(id,owner_id) on delete cascade
);

create index if not exists crawl_performance_queue_claim_idx
  on public.crawl_performance_queue(status,available_at,created_at);
create index if not exists crawl_performance_queue_project_owner_fk_idx
  on public.crawl_performance_queue(project_id,owner_id);
create index if not exists crawl_performance_results_run_idx
  on public.crawl_performance_results(crawl_run_id,strategy);
create index if not exists crawl_performance_results_project_owner_fk_idx
  on public.crawl_performance_results(project_id,owner_id);

alter table public.crawl_performance_queue enable row level security;
alter table public.crawl_performance_results enable row level security;

grant select on public.crawl_performance_queue to authenticated;
grant select on public.crawl_performance_results to authenticated;
grant select,insert,update,delete on public.crawl_performance_queue to service_role;
grant select,insert,update,delete on public.crawl_performance_results to service_role;

drop policy if exists crawl_performance_queue_select_own on public.crawl_performance_queue;
create policy crawl_performance_queue_select_own
on public.crawl_performance_queue for select to authenticated
using (owner_id=(select auth.uid()));

drop policy if exists crawl_performance_results_select_own on public.crawl_performance_results;
create policy crawl_performance_results_select_own
on public.crawl_performance_results for select to authenticated
using (owner_id=(select auth.uid()));

create or replace function public.claim_crawl_url_batch(
  p_run_id uuid,
  p_batch_size integer,
  p_claim_token uuid
)
returns table(
  id uuid,
  url text,
  normalized_url text,
  depth integer,
  source text,
  discovered_from text,
  attempts integer,
  max_attempts integer,
  render_mode text
)
language plpgsql
security invoker
set search_path to 'public'
as $function$
begin
  return query
  with picked as (
    select q.id
    from public.crawl_url_queue q
    where q.crawl_run_id=p_run_id
      and q.status='queued'
      and q.available_at <= now()
    order by q.priority desc,q.depth asc,q.created_at asc
    for update skip locked
    limit greatest(1,least(coalesce(p_batch_size,50),100))
  )
  update public.crawl_url_queue q
  set
    status='claimed',
    claim_token=p_claim_token,
    claimed_at=now(),
    attempts=q.attempts+1,
    updated_at=now()
  from picked
  where q.id=picked.id
  returning
    q.id,q.url,q.normalized_url,q.depth,q.source,q.discovered_from,
    q.attempts,q.max_attempts,q.render_mode;
end;
$function$;

revoke all on function public.claim_crawl_url_batch(uuid,integer,uuid) from public;
revoke all on function public.claim_crawl_url_batch(uuid,integer,uuid) from anon;
revoke all on function public.claim_crawl_url_batch(uuid,integer,uuid) from authenticated;
grant execute on function public.claim_crawl_url_batch(uuid,integer,uuid) to service_role;
