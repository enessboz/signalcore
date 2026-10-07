-- SignalCore owner-scoped runtime worker operations ledger.

create table if not exists public.runtime_worker_runs (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null,
  owner_id uuid not null references auth.users(id) on delete cascade,
  worker_key text not null,
  trigger_type text not null default 'cron'
    check (trigger_type in ('cron','manual','system')),
  status text not null default 'running'
    check (status in ('running','succeeded','partial','failed','skipped')),
  metrics jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  error text,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  duration_ms integer,
  created_at timestamptz not null default now(),
  unique(batch_id,owner_id,worker_key)
);

create index if not exists runtime_worker_runs_owner_started_idx
  on public.runtime_worker_runs(owner_id,started_at desc);

create index if not exists runtime_worker_runs_owner_status_idx
  on public.runtime_worker_runs(owner_id,status,started_at desc);

alter table public.runtime_worker_runs enable row level security;

revoke all on public.runtime_worker_runs from public;
revoke all on public.runtime_worker_runs from anon;
revoke all on public.runtime_worker_runs from authenticated;
grant select on public.runtime_worker_runs to authenticated;
grant select,insert,update,delete on public.runtime_worker_runs to service_role;

drop policy if exists "runtime_worker_runs_select_own" on public.runtime_worker_runs;
create policy "runtime_worker_runs_select_own"
on public.runtime_worker_runs
for select
to authenticated
using (owner_id = (select auth.uid()));
