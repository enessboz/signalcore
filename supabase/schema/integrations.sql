-- SignalCore V1 Integration Metadata & Credentials
-- Public integration metadata is owner-scoped. Credential rows are encrypted
-- and inaccessible to authenticated browser clients; only service-role server code can access them.

create table if not exists public.project_integrations (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null,
  owner_id uuid not null,
  provider text not null check (provider in ('gsc','ga4','github','cms','serp_provider')),
  status text not null default 'disconnected' check (status in ('disconnected','connecting','connected','error','revoked','paused')),
  external_account text,
  selected_resource text,
  scopes text[] not null default '{}'::text[],
  config jsonb not null default '{}'::jsonb,
  last_sync_at timestamptz,
  last_success_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (project_id, owner_id) references public.projects(id, owner_id) on delete cascade,
  unique (project_id, provider),
  unique (id, project_id, owner_id)
);

create table if not exists public.oauth_states (
  state text primary key,
  project_id uuid not null,
  owner_id uuid not null,
  provider text not null check (provider in ('gsc','ga4')),
  redirect_path text,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  foreign key (project_id, owner_id) references public.projects(id, owner_id) on delete cascade
);

create table if not exists public.integration_credentials (
  integration_id uuid primary key,
  project_id uuid not null,
  owner_id uuid not null,
  provider text not null,
  encrypted_access_token text,
  encrypted_refresh_token text,
  expires_at timestamptz,
  token_type text,
  scopes text[] not null default '{}'::text[],
  metadata jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  foreign key (integration_id, project_id, owner_id)
    references public.project_integrations(id, project_id, owner_id)
    on delete cascade
);

create index if not exists project_integrations_project_owner_fk_idx
  on public.project_integrations(project_id, owner_id);
create index if not exists oauth_states_project_owner_fk_idx
  on public.oauth_states(project_id, owner_id);
create index if not exists oauth_states_expires_idx
  on public.oauth_states(expires_at);
create index if not exists integration_credentials_project_owner_fk_idx
  on public.integration_credentials(project_id, owner_id);
create index if not exists integration_credentials_full_fk_idx
  on public.integration_credentials(integration_id, project_id, owner_id);

grant select, insert, update, delete on public.project_integrations to authenticated;
grant select, insert, delete on public.oauth_states to authenticated;
revoke all on public.integration_credentials from anon, authenticated;
grant select, insert, update, delete on public.integration_credentials to service_role;

alter table public.project_integrations enable row level security;
alter table public.oauth_states enable row level security;
alter table public.integration_credentials enable row level security;

drop policy if exists integrations_select_own on public.project_integrations;
create policy integrations_select_own on public.project_integrations
  for select to authenticated using ((select auth.uid()) = owner_id);
drop policy if exists integrations_insert_own on public.project_integrations;
create policy integrations_insert_own on public.project_integrations
  for insert to authenticated with check ((select auth.uid()) = owner_id);
drop policy if exists integrations_update_own on public.project_integrations;
create policy integrations_update_own on public.project_integrations
  for update to authenticated using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);
drop policy if exists integrations_delete_own on public.project_integrations;
create policy integrations_delete_own on public.project_integrations
  for delete to authenticated using ((select auth.uid()) = owner_id);

drop policy if exists oauth_states_select_own on public.oauth_states;
create policy oauth_states_select_own on public.oauth_states
  for select to authenticated using ((select auth.uid()) = owner_id);
drop policy if exists oauth_states_insert_own on public.oauth_states;
create policy oauth_states_insert_own on public.oauth_states
  for insert to authenticated with check ((select auth.uid()) = owner_id);
drop policy if exists oauth_states_delete_own on public.oauth_states;
create policy oauth_states_delete_own on public.oauth_states
  for delete to authenticated using ((select auth.uid()) = owner_id);

drop policy if exists credentials_deny_authenticated on public.integration_credentials;
create policy credentials_deny_authenticated on public.integration_credentials
  for all to authenticated using (false) with check (false);
