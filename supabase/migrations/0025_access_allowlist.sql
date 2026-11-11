-- 0025: a table-driven access allowlist.
--
-- Replaces the hard-coded email literals of 0014 / 0016 / 0018 with rows in
-- public.access_allowlist, so the RLS gate is configured with data, not code.
-- Keep it in step with AUTH_ALLOWED_EMAIL_DOMAINS / AUTH_ALLOWED_EMAILS, which
-- gate the app layer (src/lib/auth/authorized.ts). An empty table authorizes
-- nobody (fail closed). Seeds nothing.
--
-- Idempotent: the table and policy are guarded and the function is
-- CREATE OR REPLACE.

-- ---------------------------------------------------------------------------
-- Access allowlist
-- ---------------------------------------------------------------------------

-- pattern is either '@domain' (exact domain after the last '@') or a full
-- email address. Stored lowercased and trimmed.
create table if not exists public.access_allowlist (
  pattern     text primary key
              check (pattern = lower(btrim(pattern)) and position('@' in pattern) > 0),
  created_at  timestamptz not null default now()
);

alter table public.access_allowlist enable row level security;
revoke all on public.access_allowlist from anon;

-- Admin-only read and write for signed-in users. _is_authorized_user() below
-- reads the table as SECURITY DEFINER, so it needs no select policy.
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public'
                 and tablename = 'access_allowlist' and policyname = 'access_allowlist_admin_all') then
    create policy access_allowlist_admin_all on public.access_allowlist for all to authenticated
      using (public._is_admin()) with check (public._is_admin());
  end if;
end $$;

-- Same signature as 0014 / 0016, so every *_authorized policy picks it up.
-- Domain patterns compare the whole part after the last '@' exactly: no suffix
-- match, so x@yourcompany.example.attacker.io does not pass '@yourcompany.example'.
create or replace function public._is_authorized_user() returns boolean
language sql stable security definer set search_path = public as $$
  with jwt as (
    select lower(btrim(auth.jwt() ->> 'email')) as email
  )
  select exists (
    select 1
    from public.access_allowlist a, jwt
    where jwt.email is not null
      and position('@' in jwt.email) > 0
      and (
        a.pattern = jwt.email
        or (left(a.pattern, 1) = '@'
            and substr(a.pattern, 2) = regexp_replace(jwt.email, '^.*@', ''))
      )
  )
$$;
