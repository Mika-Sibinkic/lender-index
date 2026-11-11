-- Fills missing RLS policies on three v1 tables (cost_log, deal_outcomes,
-- funding_source_embeddings) that had RLS enabled but zero policies —
-- silently blocking every non-service-role read. Surfaced by the
-- Supabase advisor after applying 0002.

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname='public' and tablename='cost_log'
      and policyname='cost_log_select_authenticated'
  ) then
    create policy cost_log_select_authenticated
      on public.cost_log for select to authenticated using (true);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname='public' and tablename='deal_outcomes'
      and policyname='deal_outcomes_select_authenticated'
  ) then
    create policy deal_outcomes_select_authenticated
      on public.deal_outcomes for select to authenticated using (true);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname='public' and tablename='deal_outcomes'
      and policyname='deal_outcomes_editor_write'
  ) then
    create policy deal_outcomes_editor_write
      on public.deal_outcomes for all to authenticated
      using (public._is_editor()) with check (public._is_editor());
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname='public' and tablename='funding_source_embeddings'
      and policyname='fse_select_authenticated'
  ) then
    create policy fse_select_authenticated
      on public.funding_source_embeddings for select to authenticated using (true);
  end if;
end $$;
