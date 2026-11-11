-- 0015_lender_appetite.sql
-- Lender "currently lending" appetite signal.
-- Manual: staff flip `active` and jot `appetite_notes`. Search surfaces it
-- but does NOT hard-filter on it ("matches criteria — verify appetite").
-- Not implemented: deriving appetite from outreach replies.
-- Additive + idempotent. RLS already enabled on funding_sources; columns inherit.

alter table public.funding_sources
  add column if not exists active boolean not null default true;

alter table public.funding_sources
  add column if not exists appetite_notes text;

alter table public.funding_sources
  add column if not exists appetite_updated_at timestamptz;

comment on column public.funding_sources.active is
  'Manual "currently lending" flag. Default true. Search surfaces, does not hard-filter.';
comment on column public.funding_sources.appetite_notes is
  'Free-text current appetite ("paused trucks, active on equipment Q3"). Staff-maintained.';
