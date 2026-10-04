-- SignalCore strict Output Profiles.

create table if not exists public.output_profiles (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  profile_key text not null,
  name text not null,
  output_type text not null
    check (output_type in ('summary','document','presentation','task','email')),
  description text,
  strict_mode boolean not null default true,
  is_default boolean not null default false,
  active boolean not null default true,
  rules jsonb not null default '{}'::jsonb,
  template_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(owner_id,profile_key)
);

create table if not exists public.project_output_profiles (
  project_id uuid not null,
  owner_id uuid not null,
  output_type text not null
    check (output_type in ('summary','document','presentation','task','email')),
  profile_id uuid not null references public.output_profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key(project_id,output_type),
  foreign key(project_id,owner_id)
    references public.projects(id,owner_id) on delete cascade
);

-- Production rollout also applies owner-scoped RLS policies and default profiles.
