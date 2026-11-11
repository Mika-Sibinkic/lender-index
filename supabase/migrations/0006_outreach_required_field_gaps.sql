-- Pre-stages the columns the outreach.enqueue workflow reads.
--
-- required_field_gaps is a free-form text[] of field names that staff
-- have flagged as missing on a per-record basis. Empty = no gaps.

alter table public.funding_sources
  add column if not exists required_field_gaps text[] not null default '{}'::text[];

create index if not exists fs_outreach_predicate_idx
  on public.funding_sources (outreach_status, last_contact_at);
