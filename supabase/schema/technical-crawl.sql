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
