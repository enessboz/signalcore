-- SignalCore V1 Technical Crawl evidence layer.

create table if not exists public.crawl_runs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null,
  owner_id uuid not null,
  crawl_type text not null default 'http' check (crawl_type in ('http','prospect_audit','delta')),
  status text not null default 'queued' check (status in ('queued','running','succeeded','partial','failed','cancelled')),
  seed_url text not null,
  max_urls integer not null default 100 check (max_urls between 1 and 5000),
  pages_discovered integer not null default 0,
  pages_crawled integer not null default 0,
  error_count integer not null default 0,
  summary jsonb not null default '{}'::jsonb,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (project_id, owner_id)
    references public.projects(id, owner_id) on delete cascade
);

create table if not exists public.crawl_pages (
  id uuid primary key default gen_random_uuid(),
  crawl_run_id uuid not null references public.crawl_runs(id) on delete cascade,
  project_id uuid not null,
  owner_id uuid not null,
  url text not null,
  status_code integer,
  response_ms integer,
  content_type text,
  title text,
  meta_description text,
  canonical text,
  robots_meta text,
  h1s jsonb not null default '[]'::jsonb,
  h2s jsonb not null default '[]'::jsonb,
  word_count integer not null default 0,
  internal_link_count integer not null default 0,
  external_link_count integer not null default 0,
  image_count integer not null default 0,
  missing_alt_count integer not null default 0,
  structured_data_count integer not null default 0,
  content_hash text,
  fetch_error text,
  metadata jsonb not null default '{}'::jsonb,
  crawled_at timestamptz not null default now(),
  foreign key (project_id, owner_id)
    references public.projects(id, owner_id) on delete cascade,
  unique (crawl_run_id, url)
);

create index if not exists crawl_runs_project_created_idx on public.crawl_runs(project_id, created_at desc);
create index if not exists crawl_runs_project_owner_fk_idx on public.crawl_runs(project_id, owner_id);
create index if not exists crawl_pages_run_idx on public.crawl_pages(crawl_run_id);
create index if not exists crawl_pages_project_url_idx on public.crawl_pages(project_id, url);
create index if not exists crawl_pages_project_owner_fk_idx on public.crawl_pages(project_id, owner_id);

grant select, insert, update, delete on public.crawl_runs to authenticated;
grant select, insert, update, delete on public.crawl_pages to authenticated;

alter table public.crawl_runs enable row level security;
alter table public.crawl_pages enable row level security;

drop policy if exists crawl_runs_select_own on public.crawl_runs;
create policy crawl_runs_select_own on public.crawl_runs for select to authenticated using ((select auth.uid()) = owner_id);
drop policy if exists crawl_runs_insert_own on public.crawl_runs;
create policy crawl_runs_insert_own on public.crawl_runs for insert to authenticated with check ((select auth.uid()) = owner_id);
drop policy if exists crawl_runs_update_own on public.crawl_runs;
create policy crawl_runs_update_own on public.crawl_runs for update to authenticated using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);
drop policy if exists crawl_runs_delete_own on public.crawl_runs;
create policy crawl_runs_delete_own on public.crawl_runs for delete to authenticated using ((select auth.uid()) = owner_id);

drop policy if exists crawl_pages_select_own on public.crawl_pages;
create policy crawl_pages_select_own on public.crawl_pages for select to authenticated using ((select auth.uid()) = owner_id);
drop policy if exists crawl_pages_insert_own on public.crawl_pages;
create policy crawl_pages_insert_own on public.crawl_pages for insert to authenticated with check ((select auth.uid()) = owner_id);
drop policy if exists crawl_pages_update_own on public.crawl_pages;
create policy crawl_pages_update_own on public.crawl_pages for update to authenticated using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);
drop policy if exists crawl_pages_delete_own on public.crawl_pages;
create policy crawl_pages_delete_own on public.crawl_pages for delete to authenticated using ((select auth.uid()) = owner_id);


-- Technical Crawl V2: redirect evidence, document metadata and link graph.
alter table public.crawl_pages
  add column if not exists requested_url text,
  add column if not exists final_url text,
  add column if not exists redirect_chain jsonb not null default '[]'::jsonb,
  add column if not exists x_robots_tag text,
  add column if not exists hreflangs jsonb not null default '[]'::jsonb,
  add column if not exists html_lang text,
  add column if not exists meta_refresh text,
  add column if not exists h3s jsonb not null default '[]'::jsonb,
  add column if not exists h4s jsonb not null default '[]'::jsonb,
  add column if not exists h5s jsonb not null default '[]'::jsonb,
  add column if not exists h6s jsonb not null default '[]'::jsonb,
  add column if not exists content_length_bytes integer,
  add column if not exists invalid_structured_data_count integer not null default 0,
  add column if not exists indexable boolean,
  add column if not exists indexability_reason text,
  add column if not exists crawl_depth integer,
  add column if not exists inlink_count integer not null default 0,
  add column if not exists sitemap_present boolean not null default false,
  add column if not exists orphan_candidate boolean not null default false;

alter table public.crawl_pages
  drop constraint if exists crawl_pages_crawl_run_id_url_key;

create unique index if not exists crawl_pages_run_requested_unique
  on public.crawl_pages(crawl_run_id, requested_url)
  where requested_url is not null;
create index if not exists crawl_pages_run_final_url_idx
  on public.crawl_pages(crawl_run_id, final_url);
create index if not exists crawl_pages_run_indexable_idx
  on public.crawl_pages(crawl_run_id,indexable);
create index if not exists crawl_pages_run_depth_idx
  on public.crawl_pages(crawl_run_id,crawl_depth);
create index if not exists crawl_pages_run_sitemap_idx
  on public.crawl_pages(crawl_run_id,sitemap_present,orphan_candidate);

create table if not exists public.crawl_links (
  id uuid primary key default gen_random_uuid(),
  crawl_run_id uuid not null references public.crawl_runs(id) on delete cascade,
  project_id uuid not null,
  owner_id uuid not null,
  source_url text not null,
  target_url text not null,
  link_scope text not null check (link_scope in ('internal','external')),
  anchor_text text,
  rel text,
  nofollow boolean not null default false,
  target_crawled boolean not null default false,
  created_at timestamptz not null default now(),
  foreign key (project_id, owner_id)
    references public.projects(id, owner_id) on delete cascade
);

create index if not exists crawl_links_run_source_idx
  on public.crawl_links(crawl_run_id,source_url);
create index if not exists crawl_links_run_target_idx
  on public.crawl_links(crawl_run_id,target_url);
create index if not exists crawl_links_project_owner_fk_idx
  on public.crawl_links(project_id,owner_id);
create index if not exists crawl_links_project_run_idx
  on public.crawl_links(project_id,crawl_run_id);

grant select,insert,update,delete on public.crawl_links to authenticated;
alter table public.crawl_links enable row level security;

drop policy if exists crawl_links_select_own on public.crawl_links;
create policy crawl_links_select_own on public.crawl_links
  for select to authenticated using ((select auth.uid())=owner_id);
drop policy if exists crawl_links_insert_own on public.crawl_links;
create policy crawl_links_insert_own on public.crawl_links
  for insert to authenticated with check ((select auth.uid())=owner_id);
drop policy if exists crawl_links_update_own on public.crawl_links;
create policy crawl_links_update_own on public.crawl_links
  for update to authenticated using ((select auth.uid())=owner_id)
  with check ((select auth.uid())=owner_id);
drop policy if exists crawl_links_delete_own on public.crawl_links;
create policy crawl_links_delete_own on public.crawl_links
  for delete to authenticated using ((select auth.uid())=owner_id);


create table if not exists public.technical_crawl_schedules (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid not null,
  name text not null,
  crawl_type text not null default 'http'
    check (crawl_type in ('http','delta')),
  max_urls integer not null default 100
    check (max_urls between 1 and 500),
  schedule_kind text not null
    check (schedule_kind in ('daily','weekly','monthly')),
  schedule_config jsonb not null default '{}'::jsonb,
  timezone text not null default 'Europe/Istanbul',
  status text not null default 'active'
    check (status in ('active','paused','running','failed','cancelled')),
  last_run_at timestamptz,
  last_crawl_run_id uuid references public.crawl_runs(id) on delete set null,
  last_status text not null default 'idle'
    check (last_status in ('idle','running','succeeded','partial','failed','paused')),
  last_error text,
  failure_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (project_id,owner_id)
    references public.projects(id,owner_id) on delete cascade,
  unique(project_id,name)
);

create index if not exists technical_crawl_schedules_owner_status_idx
  on public.technical_crawl_schedules(owner_id,status,last_run_at);
create index if not exists technical_crawl_schedules_project_owner_fk_idx
  on public.technical_crawl_schedules(project_id,owner_id);
create index if not exists technical_crawl_schedules_last_run_fk_idx
  on public.technical_crawl_schedules(last_crawl_run_id);

grant select,insert,update,delete on public.technical_crawl_schedules to authenticated;
alter table public.technical_crawl_schedules enable row level security;

drop policy if exists technical_crawl_schedules_select_own on public.technical_crawl_schedules;
create policy technical_crawl_schedules_select_own
  on public.technical_crawl_schedules for select to authenticated
  using ((select auth.uid())=owner_id);
drop policy if exists technical_crawl_schedules_insert_own on public.technical_crawl_schedules;
create policy technical_crawl_schedules_insert_own
  on public.technical_crawl_schedules for insert to authenticated
  with check ((select auth.uid())=owner_id);
drop policy if exists technical_crawl_schedules_update_own on public.technical_crawl_schedules;
create policy technical_crawl_schedules_update_own
  on public.technical_crawl_schedules for update to authenticated
  using ((select auth.uid())=owner_id)
  with check ((select auth.uid())=owner_id);
drop policy if exists technical_crawl_schedules_delete_own on public.technical_crawl_schedules;
create policy technical_crawl_schedules_delete_own
  on public.technical_crawl_schedules for delete to authenticated
  using ((select auth.uid())=owner_id);
