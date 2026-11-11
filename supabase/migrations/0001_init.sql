-- Base schema. Runs on Supabase Cloud or self-hosted Supabase; apply every
-- migration in filename order.

create extension if not exists "pgcrypto";
create extension if not exists vector;

-- Users (mirror of Clerk users; populated on first sign-in)
create table public.users (
  id uuid primary key default gen_random_uuid(),
  clerk_user_id text unique not null,
  email text unique not null,
  role text not null default 'viewer' check (role in ('admin','editor','viewer')),
  last_seen_at timestamptz,
  created_at timestamptz not null default now()
);

-- Funding sources (core table)
create table public.funding_sources (
  id uuid primary key default gen_random_uuid(),
  company_name text not null,
  primary_contact_name text,
  primary_contact_title text,
  primary_contact_email text,
  primary_contact_phone text,
  primary_contact_calendar_link text,
  asset_classes text[] not null default '{}',
  deal_size_min_usd numeric,
  deal_size_max_usd numeric,
  borrower_revenue_min_usd numeric,
  borrower_years_in_business_min int,
  borrower_capex_min_usd numeric,
  required_documents text[] not null default '{}',
  geographic_scope text[] not null default '{}',
  industry_filters text[] not null default '{}',
  rate_notes text,
  internal_notes text,
  introduced_via text,
  introduced_date date,
  status text not null default 'active' check (status in ('active','dormant','do_not_contact','archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.users(id),
  updated_by uuid references public.users(id)
);

create index funding_sources_company_name_idx on public.funding_sources (company_name);
create index funding_sources_primary_contact_email_idx on public.funding_sources (primary_contact_email);
create index funding_sources_status_idx on public.funding_sources (status);
create index funding_sources_asset_classes_idx on public.funding_sources using gin (asset_classes);
create index funding_sources_required_documents_idx on public.funding_sources using gin (required_documents);
create index funding_sources_geographic_scope_idx on public.funding_sources using gin (geographic_scope);
create index funding_sources_industry_filters_idx on public.funding_sources using gin (industry_filters);

-- Full-text search across name + notes
alter table public.funding_sources add column search_tsv tsvector
  generated always as (
    setweight(to_tsvector('english', coalesce(company_name,'')), 'A') ||
    setweight(to_tsvector('english', coalesce(internal_notes,'')), 'B') ||
    setweight(to_tsvector('english', coalesce(rate_notes,'')), 'C')
  ) stored;
create index funding_sources_search_tsv_idx on public.funding_sources using gin (search_tsv);

-- Additional contacts beyond the primary
create table public.funding_source_contacts (
  id uuid primary key default gen_random_uuid(),
  funding_source_id uuid not null references public.funding_sources(id) on delete cascade,
  name text,
  title text,
  email text,
  phone text,
  calendar_link text,
  notes text,
  created_at timestamptz not null default now()
);
create index fsc_funding_source_id_idx on public.funding_source_contacts (funding_source_id);

-- Audit log
create table public.funding_source_edits (
  id uuid primary key default gen_random_uuid(),
  funding_source_id uuid not null references public.funding_sources(id) on delete cascade,
  user_id uuid references public.users(id),
  field_name text not null,
  old_value text,
  new_value text,
  reason text,
  edited_at timestamptz not null default now()
);
create index fse_funding_source_id_idx on public.funding_source_edits (funding_source_id);
create index fse_edited_at_idx on public.funding_source_edits (edited_at);

-- Documents (optional uploads)
create table public.funding_source_documents (
  id uuid primary key default gen_random_uuid(),
  funding_source_id uuid not null references public.funding_sources(id) on delete cascade,
  file_url text not null,
  file_type text,
  uploaded_at timestamptz not null default now(),
  uploaded_by uuid references public.users(id)
);
create index fsd_funding_source_id_idx on public.funding_source_documents (funding_source_id);

-- Embeddings (semantic search vectors)
create table public.funding_source_embeddings (
  funding_source_id uuid primary key references public.funding_sources(id) on delete cascade,
  embedding vector(1536),
  embedding_model text,
  embedded_at timestamptz
);

-- Deal outcomes (not yet written by the app)
create table public.deal_outcomes (
  id uuid primary key default gen_random_uuid(),
  funding_source_id uuid not null references public.funding_sources(id),
  deal_identifier text,
  outcome text check (outcome in ('closed_won','closed_lost','pending','withdrawn')),
  closed_at date,
  profitability_notes text,
  created_at timestamptz not null default now()
);

-- Cost log (per-call AI usage)
create table public.cost_log (
  id uuid primary key default gen_random_uuid(),
  operation_type text not null,
  input_hash text,
  cost_usd_equivalent numeric not null default 0,
  latency_ms int,
  output_hash text,
  occurred_at timestamptz not null default now()
);
create index cost_log_operation_type_idx on public.cost_log (operation_type);
create index cost_log_occurred_at_idx on public.cost_log (occurred_at);

-- updated_at trigger
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
create trigger funding_sources_updated_at
  before update on public.funding_sources
  for each row execute function public.set_updated_at();

-- RLS
alter table public.users enable row level security;
alter table public.funding_sources enable row level security;
alter table public.funding_source_contacts enable row level security;
alter table public.funding_source_edits enable row level security;
alter table public.funding_source_documents enable row level security;
alter table public.funding_source_embeddings enable row level security;
alter table public.deal_outcomes enable row level security;
alter table public.cost_log enable row level security;

-- Initial policies: any authenticated user can read; editors/admins write.
create policy users_select_authenticated on public.users for select to authenticated using (true);

create policy fs_select_authenticated on public.funding_sources for select to authenticated using (true);
create policy fs_insert_editor on public.funding_sources for insert to authenticated
  with check (exists (select 1 from public.users u where u.clerk_user_id = auth.jwt() ->> 'sub' and u.role in ('admin','editor')));
create policy fs_update_editor on public.funding_sources for update to authenticated
  using (exists (select 1 from public.users u where u.clerk_user_id = auth.jwt() ->> 'sub' and u.role in ('admin','editor')));

create policy fsc_select on public.funding_source_contacts for select to authenticated using (true);
create policy fsc_write on public.funding_source_contacts for all to authenticated
  using (exists (select 1 from public.users u where u.clerk_user_id = auth.jwt() ->> 'sub' and u.role in ('admin','editor')))
  with check (exists (select 1 from public.users u where u.clerk_user_id = auth.jwt() ->> 'sub' and u.role in ('admin','editor')));

create policy fse_select on public.funding_source_edits for select to authenticated using (true);
create policy fse_insert on public.funding_source_edits for insert to authenticated with check (true);

create policy fsd_all on public.funding_source_documents for all to authenticated using (true) with check (true);
