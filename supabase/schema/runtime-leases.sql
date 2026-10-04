-- SignalCore runtime worker leases.
-- Prevents concurrent cron/manual invocations from processing the same worker lane.

create table if not exists public.runtime_leases (
  lease_key text primary key,
  holder text not null,
  acquired_at timestamptz not null default now(),
  lease_until timestamptz not null,
  updated_at timestamptz not null default now()
);

create index if not exists runtime_leases_until_idx
  on public.runtime_leases(lease_until);

alter table public.runtime_leases enable row level security;

revoke all on public.runtime_leases from public;
revoke all on public.runtime_leases from anon;
revoke all on public.runtime_leases from authenticated;
grant select,insert,update,delete on public.runtime_leases to service_role;

create or replace function public.acquire_runtime_lease(
  p_lease_key text,
  p_holder text,
  p_ttl_seconds integer default 360
)
returns boolean
language plpgsql
security invoker
set search_path to 'public'
as $function$
declare
  v_acquired boolean := false;
begin
  if p_lease_key is null or length(trim(p_lease_key)) = 0 then
    raise exception 'lease key is required';
  end if;

  if p_holder is null or length(trim(p_holder)) = 0 then
    raise exception 'lease holder is required';
  end if;

  if p_ttl_seconds < 30 or p_ttl_seconds > 3600 then
    raise exception 'lease ttl must be between 30 and 3600 seconds';
  end if;

  insert into public.runtime_leases(
    lease_key,holder,acquired_at,lease_until,updated_at
  )
  values (
    p_lease_key,p_holder,now(),
    now() + make_interval(secs => p_ttl_seconds),now()
  )
  on conflict (lease_key) do update
  set
    holder = excluded.holder,
    acquired_at = excluded.acquired_at,
    lease_until = excluded.lease_until,
    updated_at = excluded.updated_at
  where public.runtime_leases.lease_until <= now()
  returning true into v_acquired;

  return coalesce(v_acquired,false);
end;
$function$;

revoke all on function public.acquire_runtime_lease(text,text,integer) from public;
revoke all on function public.acquire_runtime_lease(text,text,integer) from anon;
revoke all on function public.acquire_runtime_lease(text,text,integer) from authenticated;
grant execute on function public.acquire_runtime_lease(text,text,integer) to service_role;
