-- Enables upsert-on-company_name for spreadsheet imports
-- (scripts/import-roster-xlsx.ts). Fails if duplicate company names
-- already exist; synthetic seed names are fictional so they do not
-- collide with a real roster.

create unique index if not exists funding_sources_company_name_key
  on public.funding_sources (company_name);
