-- SignalCore V1 Account-Level Connections
-- Connect provider accounts once, discover resources, then bind resources to projects.

create table if not exists public.connections (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('google')),
  status text not null default 'disconnected'
    check (status in ('disconnected','connecting','connected','error','revoked','paused')),
  external_account text,
  scopes text[] not null default '{}'::text[],
  config jsonb not null default '{}'::jsonb,
  last_discovery_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, provider),
  unique (id, owner_id)
);

create table if not exists public.connection_resources (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null,
  owner_id uuid not null,
  resource_type text not null check (resource_type in ('gsc_property','ga4_property')),
  resource_id text not null,
  display_name text,
  parent_id text,
  permission_level text,
  active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  discovered_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (connection_id, owner_id)
    references public.connections(id, owner_id) on delete cascade,
  unique (connection_id, resource_type, resource_id),
  unique (id, connection_id, owner_id)
);

create table if not exists public.project_bindings (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null,
  owner_id uuid not null,
  connection_id uuid not null,
  resource_id uuid not null,
  binding_type text not null check (binding_type in ('gsc','ga4')),
  binding_role text not null default 'primary' check (binding_role in ('primary','secondary')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (project_id, owner_id)
    references public.projects(id, owner_id) on delete cascade,
  foreign key (connection_id, owner_id)
    references public.connections(id, owner_id) on delete cascade,
  foreign key (resource_id, connection_id, owner_id)
    references public.connection_resources(id, connection_id, owner_id) on delete cascade,
  unique (project_id, binding_type, binding_role)
);

create table if not exists public.account_oauth_states (
  state text primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('google')),
  redirect_path text,
  requested_scopes text[] not null default '{}'::text[],
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table if not exists public.connection_credentials (
  connection_id uuid primary key,
  owner_id uuid not null,
  provider text not null check (provider in ('google')),
  encrypted_access_token text,
  encrypted_refresh_token text,
  expires_at timestamptz,
  token_type text,
  scopes text[] not null default '{}'::text[],
  metadata jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  foreign key (connection_id, owner_id)
    references public.connections(id, owner_id) on delete cascade
);

create index if not exists connections_owner_status_idx on public.connections(owner_id, status);
create index if not exists resources_connection_owner_fk_idx on public.connection_resources(connection_id, owner_id);
create index if not exists resources_owner_type_idx on public.connection_resources(owner_id, resource_type, active);
create index if not exists bindings_project_owner_fk_idx on public.project_bindings(project_id, owner_id);
create index if not exists bindings_connection_owner_fk_idx on public.project_bindings(connection_id, owner_id);
create index if not exists bindings_resource_connection_owner_fk_idx on public.project_bindings(resource_id, connection_id, owner_id);
create index if not exists account_oauth_states_owner_expiry_idx on public.account_oauth_states(owner_id, expires_at);
create index if not exists connection_credentials_full_fk_idx on public.connection_credentials(connection_id, owner_id);

grant select, insert, update, delete on public.connections to authenticated;
grant select, insert, update, delete on public.connection_resources to authenticated;
grant select, insert, update, delete on public.project_bindings to authenticated;
grant select, insert, delete on public.account_oauth_states to authenticated;
grant select, insert, update, delete on public.connection_credentials to authenticated;

alter table public.connections enable row level security;
alter table public.connection_resources enable row level security;
alter table public.project_bindings enable row level security;
alter table public.account_oauth_states enable row level security;
alter table public.connection_credentials enable row level security;

drop policy if exists connections_select_own on public.connections;
create policy connections_select_own on public.connections for select to authenticated using ((select auth.uid()) = owner_id);
drop policy if exists connections_insert_own on public.connections;
create policy connections_insert_own on public.connections for insert to authenticated with check ((select auth.uid()) = owner_id);
drop policy if exists connections_update_own on public.connections;
create policy connections_update_own on public.connections for update to authenticated using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);
drop policy if exists connections_delete_own on public.connections;
create policy connections_delete_own on public.connections for delete to authenticated using ((select auth.uid()) = owner_id);

drop policy if exists resources_select_own on public.connection_resources;
create policy resources_select_own on public.connection_resources for select to authenticated using ((select auth.uid()) = owner_id);
drop policy if exists resources_insert_own on public.connection_resources;
create policy resources_insert_own on public.connection_resources for insert to authenticated with check ((select auth.uid()) = owner_id);
drop policy if exists resources_update_own on public.connection_resources;
create policy resources_update_own on public.connection_resources for update to authenticated using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);
drop policy if exists resources_delete_own on public.connection_resources;
create policy resources_delete_own on public.connection_resources for delete to authenticated using ((select auth.uid()) = owner_id);

drop policy if exists bindings_select_own on public.project_bindings;
create policy bindings_select_own on public.project_bindings for select to authenticated using ((select auth.uid()) = owner_id);
drop policy if exists bindings_insert_own on public.project_bindings;
create policy bindings_insert_own on public.project_bindings for insert to authenticated with check ((select auth.uid()) = owner_id);
drop policy if exists bindings_update_own on public.project_bindings;
create policy bindings_update_own on public.project_bindings for update to authenticated using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);
drop policy if exists bindings_delete_own on public.project_bindings;
create policy bindings_delete_own on public.project_bindings for delete to authenticated using ((select auth.uid()) = owner_id);

drop policy if exists account_oauth_select_own on public.account_oauth_states;
create policy account_oauth_select_own on public.account_oauth_states for select to authenticated using ((select auth.uid()) = owner_id);
drop policy if exists account_oauth_insert_own on public.account_oauth_states;
create policy account_oauth_insert_own on public.account_oauth_states for insert to authenticated with check ((select auth.uid()) = owner_id);
drop policy if exists account_oauth_delete_own on public.account_oauth_states;
create policy account_oauth_delete_own on public.account_oauth_states for delete to authenticated using ((select auth.uid()) = owner_id);

drop policy if exists connection_credentials_select_own on public.connection_credentials;
create policy connection_credentials_select_own on public.connection_credentials for select to authenticated using ((select auth.uid()) = owner_id);
drop policy if exists connection_credentials_insert_own on public.connection_credentials;
create policy connection_credentials_insert_own on public.connection_credentials for insert to authenticated with check ((select auth.uid()) = owner_id);
drop policy if exists connection_credentials_update_own on public.connection_credentials;
create policy connection_credentials_update_own on public.connection_credentials for update to authenticated using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);
drop policy if exists connection_credentials_delete_own on public.connection_credentials;
create policy connection_credentials_delete_own on public.connection_credentials for delete to authenticated using ((select auth.uid()) = owner_id);
