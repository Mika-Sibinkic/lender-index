-- 0022: activity_log — the user-visible record of what the system actually did.
--
-- Why this exists: when someone on the team says "the search came back wrong"
-- or "the import dropped rows", there is currently nothing to look at. The two
-- busiest paths in the product wrote nothing at all — /api/search did zero DB
-- writes and threw its effective criteria away with the response, and
-- /api/import/funding-sources computed a full per-file reconciliation
-- (rowsInSheet / rowsParsed / rowsSkipped / unmappedColumns) and returned it to
-- one browser tab that was then closed. So the report always arrived without
-- the input that produced it, and we could only guess.
--
-- parse_logs (0002) already covers the AI-parse path and funding_source_edits
-- covers field edits. This is the table for everything else. Unlike cost_log it
-- records FAILURES: cost_log is only ever written after a call succeeds, which
-- means the events most worth reporting were the ones guaranteed to be missing.
--
-- `on delete set null` on BOTH foreign keys, deliberately not cascade. Deleting
-- a user, or deleting a lender someone imported badly, must not erase the
-- record of what was done — an audit trail a delete can rewrite is not one.
--
-- Additive + idempotent. Every write goes through the service role, so there is
-- no client INSERT policy on purpose; SELECT mirrors parse_logs after 0014.

create table if not exists public.activity_log (
  id                uuid primary key default gen_random_uuid(),
  occurred_at       timestamptz not null default now(),
  user_id           uuid references public.users(id) on delete set null,
  kind              text not null check (kind in (
                      'search','import','parse','record_create','record_update',
                      'record_delete','report_export')),
  -- One human-readable line. This is the column the team reads; `detail` is the
  -- column we read when they report a problem with it.
  summary           text not null,
  detail            jsonb not null default '{}'::jsonb,
  funding_source_id uuid references public.funding_sources(id) on delete set null,
  ok                boolean not null default true,
  error             text
);

-- The activity page and the export both read newest-first, optionally narrowed
-- to one kind. Those are the only two access patterns.
create index if not exists activity_log_occurred_at_idx on public.activity_log (occurred_at desc);
create index if not exists activity_log_kind_idx on public.activity_log (kind);

comment on table public.activity_log is
  'User-visible record of system actions (search, import, parse, record writes, exports). Records failures too, which cost_log cannot.';
comment on column public.activity_log.detail is
  'Structured payload — the exact input that produced the row (search query + effective criteria, import reconciliation).';

alter table public.activity_log enable row level security;

-- Read-only to the app: SELECT for whitelisted users, mirroring
-- parse_logs_select_authorized in 0014. No INSERT/UPDATE/DELETE policy — the
-- service role bypasses RLS, so anon/authenticated clients cannot forge or
-- amend an activity row.
do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'activity_log'
      and policyname = 'activity_log_select_authorized'
  ) then
    create policy activity_log_select_authorized on public.activity_log
      for select using (_is_authorized_user());
  end if;
end $$;
