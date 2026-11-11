-- 0021: audit rows must outlive the record they describe, and the parse-log
-- modality CHECK must accept every modality the app actually writes.
--
-- Two independent data-integrity defects, both verified against a live schema:
--
-- 1. funding_source_edits.funding_source_id was declared FK ... ON DELETE CASCADE
--    (0001_init.sql:81). DELETE /api/funding-sources/[id] writes a
--    field_name='__DELETED__' audit row and THEN hard-deletes the parent, so the
--    cascade erased that row — and every prior edit for the record — in the same
--    statement. Meanwhile the delete dialog told the user "Edit history is
--    preserved for audit". parse_logs got this right at 0002_parse_logs.sql:13
--    (ON DELETE SET NULL); the audit table did not. Mirror it here so the history
--    survives, detached from the deleted parent.
--
--    company_name_at_delete is what makes a detached row legible: once
--    funding_source_id is NULL it is the only thing left naming the lender the
--    history belonged to. Populated by the DELETE handler before it deletes.
--
-- 2. parse_logs.input_modality CHECK allowed only ('text','image','pdf','mixed'),
--    but /api/closed-deals has written 'spreadsheet' for xlsx/xls/csv Past-Deal
--    imports. Every one of those inserts was rejected
--    by the constraint, and because the insert error was never read (supabase-js
--    resolves with { error }, it does not throw — fixed in the same commit as
--    this migration), the failure was swallowed whole:
--    `select count(*) from parse_logs where input_modality='spreadsheet'` returns
--    0 and modalities_seen is only 'pdf, text'. Spreadsheet imports have produced
--    zero closed-loop training signal for the eval set.
--
-- Additive and idempotent: every constraint is swept then
-- recreated, no v1 column is dropped, re-running is a no-op.

-- ---------------------------------------------------------------------------
-- 1. funding_source_edits: stop the cascade from eating the audit trail
-- ---------------------------------------------------------------------------

-- ON DELETE SET NULL cannot fire against a NOT NULL column. No-op if 0001's
-- NOT NULL has already been dropped.
alter table public.funding_source_edits
  alter column funding_source_id drop not null;

-- 0001_init.sql declares the FK inline and unnamed, so Postgres named it
-- funding_source_edits_funding_source_id_fkey. We sweep by column rather than
-- trust that name: if a rename had made the DROP a no-op, the ADD below would
-- leave BOTH constraints in place and the CASCADE would still win on delete —
-- a silent half-fix that looks identical to a working one until a record is
-- deleted and its history vanishes again.
do $$
declare
  c text;
begin
  for c in
    select con.conname
    from pg_constraint con
    join pg_attribute att
      on att.attrelid = con.conrelid
     and att.attnum = any (con.conkey)
    where con.conrelid = 'public.funding_source_edits'::regclass
      and con.contype = 'f'
      and att.attname = 'funding_source_id'
  loop
    execute format('alter table public.funding_source_edits drop constraint %I', c);
  end loop;
end $$;

alter table public.funding_source_edits
  add constraint funding_source_edits_funding_source_id_fkey
  foreign key (funding_source_id)
  references public.funding_sources(id)
  on delete set null;

alter table public.funding_source_edits
  add column if not exists company_name_at_delete text;

comment on column public.funding_source_edits.funding_source_id is
  'NULL means the parent funding source was deleted. ON DELETE SET NULL (0021), not CASCADE — the audit trail outlives the record. Read company_name_at_delete to identify the lender.';
comment on column public.funding_source_edits.company_name_at_delete is
  'funding_sources.company_name captured by the DELETE handler at hard-delete time. The only surviving identifier once funding_source_id is NULL.';

-- ---------------------------------------------------------------------------
-- 2. parse_logs: allow the modality the closed-deals importer actually writes
-- ---------------------------------------------------------------------------

-- 0002_parse_logs.sql declares the CHECK inline and unnamed, so Postgres named
-- it parse_logs_input_modality_check. Swept by column for the same reason as
-- the FK above: two overlapping CHECKs would still reject 'spreadsheet'.
do $$
declare
  c text;
begin
  for c in
    select con.conname
    from pg_constraint con
    join pg_attribute att
      on att.attrelid = con.conrelid
     and att.attnum = any (con.conkey)
    where con.conrelid = 'public.parse_logs'::regclass
      and con.contype = 'c'
      and att.attname = 'input_modality'
  loop
    execute format('alter table public.parse_logs drop constraint %I', c);
  end loop;
end $$;

alter table public.parse_logs
  add constraint parse_logs_input_modality_check
  check (input_modality in ('text', 'image', 'pdf', 'mixed', 'spreadsheet'));

comment on column public.parse_logs.input_modality is
  'text | image | pdf | mixed | spreadsheet. Extend this CHECK in the same commit as any new modality — src/lib/supabase/schema-contract.test.ts fails otherwise.';
