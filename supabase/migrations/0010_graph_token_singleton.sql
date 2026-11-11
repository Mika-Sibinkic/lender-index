-- Singleton row storing the principal inbox's Microsoft Graph refresh token. One row, id=1.
-- Admin-only RLS; service-role bypasses for the refresh flow in
-- src/lib/email/graph-auth.ts.

create table if not exists public.graph_token (
  id              int primary key default 1 check (id = 1),
  refresh_token   text not null,
  last_refreshed_at timestamptz default now(),
  created_at      timestamptz not null default now()
);

alter table public.graph_token enable row level security;

do $$ begin
  if not exists (
    select 1 from pg_policies where schemaname='public' and tablename='graph_token'
      and policyname='graph_token_admin_only'
  ) then
    create policy graph_token_admin_only on public.graph_token for all to authenticated
      using (public._is_admin()) with check (public._is_admin());
  end if;
end $$;
