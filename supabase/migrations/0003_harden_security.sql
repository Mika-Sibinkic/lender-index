-- Hardens three security advisories surfaced by Supabase advisor:
-- 1) search_path on _is_admin / _is_editor (mutable -> fixed to public)
-- 2) apply_proposed_field: revoke from anon/public; add internal admin check
--    so the SECURITY DEFINER function cannot be abused even if grants drift
-- 3) set_updated_at warning predates this migration; out of scope here

create or replace function public._is_admin() returns boolean
language sql stable set search_path = public as $$
  select exists (
    select 1 from public.users u
    where u.clerk_user_id = auth.jwt() ->> 'sub' and u.role = 'admin'
  )
$$;

create or replace function public._is_editor() returns boolean
language sql stable set search_path = public as $$
  select exists (
    select 1 from public.users u
    where u.clerk_user_id = auth.jwt() ->> 'sub' and u.role in ('admin','editor')
  )
$$;

create or replace function public.apply_proposed_field(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare p public.proposed_field%rowtype;
        col_type text;
begin
  if not public._is_admin() then
    raise exception 'admin role required to apply proposed_field';
  end if;

  select * into p from public.proposed_field where id = p_id and status = 'pending';
  if not found then raise exception 'no pending proposed_field %', p_id; end if;

  col_type := case p.data_type
                when 'numeric' then 'numeric'
                when 'boolean' then 'boolean'
                when 'date'    then 'date'
                when 'jsonb'   then 'jsonb'
                else                'text'
              end;

  execute format('alter table public.funding_sources add column if not exists %I %s', p.name, col_type);
  update public.proposed_field set status = 'approved', applied_at = now() where id = p_id;
end $$;

revoke all     on function public.apply_proposed_field(uuid) from public;
revoke execute on function public.apply_proposed_field(uuid) from anon;
grant  execute on function public.apply_proposed_field(uuid) to   authenticated;
