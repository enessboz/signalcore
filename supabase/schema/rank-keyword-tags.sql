-- Manual Rank Tracker tags.

create table if not exists public.rank_keyword_tags (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null,
  owner_id uuid not null,
  name text not null,
  slug text not null,
  color_key text not null default 'purple'
    check (color_key in ('purple','green','blue','amber','red','gray')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key(project_id,owner_id)
    references public.projects(id,owner_id) on delete cascade,
  unique(project_id,owner_id,slug)
);

create table if not exists public.rank_keyword_tag_members (
  tag_id uuid not null references public.rank_keyword_tags(id) on delete cascade,
  tracked_keyword_id uuid not null references public.tracked_keywords(id) on delete cascade,
  project_id uuid not null,
  owner_id uuid not null,
  created_at timestamptz not null default now(),
  primary key(tag_id,tracked_keyword_id),
  foreign key(project_id,owner_id)
    references public.projects(id,owner_id) on delete cascade
);

create index if not exists rank_keyword_tags_project_owner_idx
  on public.rank_keyword_tags(project_id,owner_id,name);
create index if not exists rank_keyword_tag_members_project_owner_idx
  on public.rank_keyword_tag_members(project_id,owner_id);
create index if not exists rank_keyword_tag_members_keyword_idx
  on public.rank_keyword_tag_members(tracked_keyword_id);

alter table public.rank_keyword_tags enable row level security;
alter table public.rank_keyword_tag_members enable row level security;

grant select,insert,update,delete on public.rank_keyword_tags to authenticated;
grant select,insert,update,delete on public.rank_keyword_tags to service_role;
grant select,insert,update,delete on public.rank_keyword_tag_members to authenticated;
grant select,insert,update,delete on public.rank_keyword_tag_members to service_role;

drop policy if exists rank_keyword_tags_own on public.rank_keyword_tags;
create policy rank_keyword_tags_own
on public.rank_keyword_tags
for all to authenticated
using (owner_id=(select auth.uid()))
with check (owner_id=(select auth.uid()));

drop policy if exists rank_keyword_tag_members_own on public.rank_keyword_tag_members;
create policy rank_keyword_tag_members_own
on public.rank_keyword_tag_members
for all to authenticated
using (owner_id=(select auth.uid()))
with check (owner_id=(select auth.uid()));
