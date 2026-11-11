-- Mark WHICH contacts at a lender handle international deals.
--
-- A lender that appears on both the Domestic and International workbooks is
-- merged into one record that accepts both, with its international rep marked
-- as such. There are usually fewer international reps than domestic ones, so it
-- is less cognitive load to mark only the odd ones out.
--
-- So this is deliberately SPARSE: false is the common case and carries no
-- meaning, true marks the exception. Nobody has to classify every contact.
--
-- It also does not have to be entered by hand at all. The spreadsheets are split
-- Domestic / International, so a contact's workbook of origin already states
-- which desk they sit on — the importer sets this from the file it read.
--
-- Additive and idempotent. No column is dropped, no value is rewritten: every
-- existing contact keeps the default of false, which is exactly what it means
-- today (the roster has never distinguished them).

alter table public.funding_source_contacts
  add column if not exists is_international boolean not null default false;

comment on column public.funding_source_contacts.is_international is
  'This contact handles international deals. Sparse by design: only the exceptions are marked. Set by the importer from the source workbook.';

-- The primary contact lives on funding_sources rather than in the contacts
-- table, so it needs the same marker to be describable at all.
alter table public.funding_sources
  add column if not exists primary_contact_is_international boolean not null default false;

comment on column public.funding_sources.primary_contact_is_international is
  'The primary contact handles international deals. See funding_source_contacts.is_international.';

create index if not exists fsc_is_international_idx
  on public.funding_source_contacts (funding_source_id)
  where is_international;
