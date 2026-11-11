-- 0017: add the funding-source fields from the roster spreadsheet template
-- (see README "Importing a roster") so every field appears on the card. Additive,
-- idempotent, nullable. Existing columns cover: company_name, contact, email,
-- deal_size_min/max_usd, geographic_scope, asset_classes, internal_notes.
-- These add the rest of the template.

alter table public.funding_sources add column if not exists lender_type text;            -- (B)Bank (C)Credit Union (NB)Non Bank (PE)Private Equity
alter table public.funding_sources add column if not exists intl_domestic text;          -- (I)International (D)Domestic / Both
alter table public.funding_sources add column if not exists specific_geographic text;     -- free-text region detail beyond geographic_scope
alter table public.funding_sources add column if not exists asset_subtypes text[] not null default '{}';  -- asset subtypes (display only)
alter table public.funding_sources add column if not exists usage_codes text;             -- usage codes (rank-only)
alter table public.funding_sources add column if not exists operation_category text;      -- operation category: Personal / Commercial
alter table public.funding_sources add column if not exists vintage_restriction text;     -- asset age/vintage limit
alter table public.funding_sources add column if not exists lending_status text;          -- free-text lending status (richer than active bool)
alter table public.funding_sources add column if not exists bank_paid_fee text;           -- bank-paid fee (Y/N or %)

comment on column public.funding_sources.lender_type is 'Bank / Credit Union / Non Bank / Private Equity';
comment on column public.funding_sources.asset_subtypes is
  'Spreadsheet "Asset Subtypes" column (e.g. New / Used / Refurbished). Display only; asset_classes drives search matching.';
comment on column public.funding_sources.usage_codes is
  'Comma-separated usage codes from src/lib/config/vocabulary.ts USAGE_CODES. Rank-only; never excludes.';
comment on column public.funding_sources.vintage_restriction is
  'Asset age / vintage limit as written (e.g. "15 Years", "2010 or newer", "None").';
