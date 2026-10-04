-- SignalCore V1 Project Brain MVP
-- Adds source text persistence and deterministic full-text searchable chunks.

alter table public.project_sources
  add column if not exists content_text text;

create table if not exists public.background_chunks (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null,
  project_id uuid not null,
  owner_id uuid not null,
  chunk_index integer not null check (chunk_index >= 0),
  content text not null,
  search_tsv tsvector generated always as (to_tsvector('simple', coalesce(content, ''))) stored,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  foreign key (project_id, owner_id) references public.projects(id, owner_id) on delete cascade,
  foreign key (source_id, project_id, owner_id) references public.project_sources(id, project_id, owner_id) on delete cascade,
  unique (source_id, chunk_index)
);

create index if not exists background_chunks_project_source_idx
  on public.background_chunks(project_id, source_id, chunk_index);
create index if not exists background_chunks_project_owner_fk_idx
  on public.background_chunks(project_id, owner_id);
create index if not exists background_chunks_source_project_owner_fk_idx
  on public.background_chunks(source_id, project_id, owner_id);
create index if not exists background_chunks_search_idx
  on public.background_chunks using gin(search_tsv);

grant select, insert, update, delete on public.background_chunks to authenticated;

alter table public.background_chunks enable row level security;

drop policy if exists chunks_select_own on public.background_chunks;
create policy chunks_select_own on public.background_chunks
  for select to authenticated
  using ((select auth.uid()) = owner_id);

drop policy if exists chunks_insert_own on public.background_chunks;
create policy chunks_insert_own on public.background_chunks
  for insert to authenticated
  with check ((select auth.uid()) = owner_id);

drop policy if exists chunks_update_own on public.background_chunks;
create policy chunks_update_own on public.background_chunks
  for update to authenticated
  using ((select auth.uid()) = owner_id)
  with check ((select auth.uid()) = owner_id);

drop policy if exists chunks_delete_own on public.background_chunks;
create policy chunks_delete_own on public.background_chunks
  for delete to authenticated
  using ((select auth.uid()) = owner_id);
