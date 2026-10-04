-- SignalCore V1 Manual Analytics
-- Saved manual report configurations and GA4 funnel definitions.

create table if not exists public.saved_analytics_views (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null,
  owner_id uuid not null,
  data_source text not null check (data_source in ('gsc','ga4')),
  name text not null,
  description text,
  config jsonb not null default '{}'::jsonb,
  is_pinned boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (project_id, owner_id)
    references public.projects(id, owner_id) on delete cascade
);

create table if not exists public.ga4_funnels (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null,
  owner_id uuid not null,
  name text not null,
  description text,
  config jsonb not null default '{}'::jsonb,
  is_pinned boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (project_id, owner_id)
    references public.projects(id, owner_id) on delete cascade
);

create index if not exists saved_views_project_source_idx
  on public.saved_analytics_views(project_id, data_source, updated_at desc);
create index if not exists saved_views_project_owner_fk_idx
  on public.saved_analytics_views(project_id, owner_id);
create index if not exists ga4_funnels_project_idx
  on public.ga4_funnels(project_id, updated_at desc);
create index if not exists ga4_funnels_project_owner_fk_idx
  on public.ga4_funnels(project_id, owner_id);

grant select, insert, update, delete on public.saved_analytics_views to authenticated;
grant select, insert, update, delete on public.ga4_funnels to authenticated;

alter table public.saved_analytics_views enable row level security;
alter table public.ga4_funnels enable row level security;

drop policy if exists saved_views_select_own on public.saved_analytics_views;
create policy saved_views_select_own on public.saved_analytics_views for select to authenticated using ((select auth.uid()) = owner_id);
drop policy if exists saved_views_insert_own on public.saved_analytics_views;
create policy saved_views_insert_own on public.saved_analytics_views for insert to authenticated with check ((select auth.uid()) = owner_id);
drop policy if exists saved_views_update_own on public.saved_analytics_views;
create policy saved_views_update_own on public.saved_analytics_views for update to authenticated using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);
drop policy if exists saved_views_delete_own on public.saved_analytics_views;
create policy saved_views_delete_own on public.saved_analytics_views for delete to authenticated using ((select auth.uid()) = owner_id);

drop policy if exists ga4_funnels_select_own on public.ga4_funnels;
create policy ga4_funnels_select_own on public.ga4_funnels for select to authenticated using ((select auth.uid()) = owner_id);
drop policy if exists ga4_funnels_insert_own on public.ga4_funnels;
create policy ga4_funnels_insert_own on public.ga4_funnels for insert to authenticated with check ((select auth.uid()) = owner_id);
drop policy if exists ga4_funnels_update_own on public.ga4_funnels;
create policy ga4_funnels_update_own on public.ga4_funnels for update to authenticated using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);
drop policy if exists ga4_funnels_delete_own on public.ga4_funnels;
create policy ga4_funnels_delete_own on public.ga4_funnels for delete to authenticated using ((select auth.uid()) = owner_id);
