-- SignalCore Approval Gate extensions.

alter table public.approvals
  add column if not exists agent_run_id uuid references public.agent_runs(id) on delete set null,
  add column if not exists target_agent_key text references public.agent_definitions(agent_key),
  add column if not exists summary text,
  add column if not exists risk_level text not null default 'medium'
    check (risk_level in ('low','medium','high','critical')),
  add column if not exists execution_status text not null default 'not_started'
    check (execution_status in ('not_started','ready','running','succeeded','failed','cancelled')),
  add column if not exists execution_result jsonb not null default '{}'::jsonb;

create index if not exists approvals_owner_status_idx
  on public.approvals(owner_id, status, requested_at desc);
create index if not exists approvals_agent_run_idx
  on public.approvals(agent_run_id);
create index if not exists approvals_target_agent_idx
  on public.approvals(target_agent_key);
