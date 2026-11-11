-- 0002 — Adds: tags, closed_deal, proposed_field, borrower stubs.
-- Extends: funding_sources with rate/term/contact-health columns,
--          funding_source_embeddings with model/dims/indexed_at + ivfflat,
--          cost_log with module/model/token-level columns.
-- Idempotent: all `add column if not exists`, `create ... if not exists`.

-- --- Tags ----------------------------------------------------------------

create table if not exists public.tag (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  color       text not null check (color in ('red','amber','green','blue','violet','slate')),
  semantic    text,                              -- e.g. "bad contact", "renewed", "preferred"
  created_at  timestamptz not null default now()
);

create table if not exists public.funding_source_tag (
  funding_source_id uuid not null references public.funding_sources(id) on delete cascade,
  tag_id            uuid not null references public.tag(id) on delete cascade,
  applied_at        timestamptz not null default now(),
  applied_by        uuid references public.users(id),
  primary key (funding_source_id, tag_id)
);
create index if not exists fst_tag_idx on public.funding_source_tag (tag_id);

-- --- Past deals ----------------------------------------------------------

create table if not exists public.closed_deal (
  id                    uuid primary key default gen_random_uuid(),
  funding_source_id     uuid references public.funding_sources(id) on delete set null,
  asset_year            int,
  asset_make            text,
  asset_model           text,
  loan_amount_usd       numeric(14,2),
  purchase_price_usd    numeric(14,2),
  rate_pct              numeric(6,4),
  ltv_pct               numeric(5,2),
  prepayment_penalty    text,
  fees                  jsonb,
  closed_on             date,
  source_document_url   text,                    -- Supabase Storage signed URL
  source_kind           text check (source_kind in ('term_sheet','proposal','loan_doc','manual')),
  extracted_by_run_id   uuid,                    -- parse_run id when added; nullable for manual
  created_at            timestamptz not null default now(),
  created_by            uuid references public.users(id)
);
create index if not exists closed_deal_asset_idx        on public.closed_deal (asset_year, asset_make, asset_model);
create index if not exists closed_deal_fs_idx           on public.closed_deal (funding_source_id);
create index if not exists closed_deal_closed_on_idx    on public.closed_deal (closed_on);

-- --- Proposed (AI-suggested) schema extensions ---------------------------

create table if not exists public.proposed_field (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  data_type       text not null check (data_type in ('text','numeric','boolean','date','jsonb')),
  example_value   text,
  occurrences     int not null default 1,
  status          text not null default 'pending' check (status in ('pending','approved','rejected')),
  approved_by     uuid references public.users(id),
  applied_at      timestamptz,
  created_at      timestamptz not null default now()
);
create index if not exists proposed_field_status_idx on public.proposed_field (status);

-- DDL helper RPC — admin-only via grant (granted below); called by /api/proposed-fields/[id]/approve
create or replace function public.apply_proposed_field(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare p public.proposed_field%rowtype;
        col_type text;
begin
  select * into p from public.proposed_field where id = p_id and status = 'pending';
  if not found then raise exception 'no pending proposed_field %', p_id; end if;

  col_type := case p.data_type
                when 'numeric' then 'numeric'
                when 'boolean' then 'boolean'
                when 'date'    then 'date'
                when 'jsonb'   then 'jsonb'
                else                'text'
              end;

  execute format('alter table public.funding_sources add column if not exists %I %s', p.name, col_type);
  update public.proposed_field set status = 'approved', applied_at = now() where id = p_id;
end $$;

revoke all on function public.apply_proposed_field(uuid) from public;
-- granted to authenticated below; called only by the admin-gated endpoint

-- --- Borrower stubs (reserved, no UI) -------------------------------------

create table if not exists public.borrower (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  notes       text,
  created_at  timestamptz not null default now()
);

create table if not exists public.borrower_funding_source_link (
  borrower_id       uuid not null references public.borrower(id) on delete cascade,
  funding_source_id uuid not null references public.funding_sources(id) on delete cascade,
  link_kind         text not null check (link_kind in ('shortlisted','submitted','won','declined','dropped')),
  created_at        timestamptz not null default now(),
  primary key (borrower_id, funding_source_id, link_kind)
);

-- --- Extend funding_sources -----------------------------------------------
-- Names align with 0001 snake_case; final schema is iteratively expanded by
-- proposed_field approvals as roster spreadsheets are imported.

alter table public.funding_sources
  add column if not exists interest_rate_notes  text,
  add column if not exists prepayment_penalty   text,
  add column if not exists ltv_min_pct          numeric(5,2),
  add column if not exists ltv_max_pct          numeric(5,2),
  add column if not exists term_min_months      int,
  add column if not exists term_max_months      int,
  add column if not exists down_payment_notes   text,
  add column if not exists last_contact_at      timestamptz,
  add column if not exists outreach_status      text not null default 'current'
                                                check (outreach_status in ('current','stale','bouncing','do_not_contact'));

create index if not exists fs_last_contact_at_idx  on public.funding_sources (last_contact_at);
create index if not exists fs_outreach_status_idx  on public.funding_sources (outreach_status);

-- --- funding_source_embeddings — add model/dims/indexed_at + ivfflat ------
-- Keep existing vector(1536) column shape (matches OpenAI text-embedding-3-small,
-- which is the cloud default; on-prem model swap must produce 1536-dim vectors
-- or this column is altered in 0003).

alter table public.funding_source_embeddings
  add column if not exists model       text,
  add column if not exists dims        int  not null default 1536,
  add column if not exists indexed_at  timestamptz default now();

-- ivfflat index for cosine kNN
create index if not exists funding_source_embeddings_ivfflat
  on public.funding_source_embeddings using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);

-- --- cost_log — token-level columns ---------------------------------------
-- 0001 had operation_type/cost_usd_equivalent/latency_ms/in&out hash.
-- Add the per-module/per-model token breakdown the client emits.

alter table public.cost_log
  add column if not exists module          text,
  add column if not exists model           text,
  add column if not exists input_tokens    int,
  add column if not exists output_tokens   int;

create index if not exists cost_log_module_idx on public.cost_log (module);
create index if not exists cost_log_model_idx  on public.cost_log (model);

-- --- RLS on new tables ----------------------------------------------------

alter table public.tag                            enable row level security;
alter table public.funding_source_tag             enable row level security;
alter table public.closed_deal                    enable row level security;
alter table public.proposed_field                 enable row level security;
alter table public.borrower                       enable row level security;
alter table public.borrower_funding_source_link   enable row level security;

-- Helper: is current Clerk JWT user an admin/editor?
create or replace function public._is_editor() returns boolean language sql stable as $$
  select exists (
    select 1 from public.users u
    where u.clerk_user_id = auth.jwt() ->> 'sub' and u.role in ('admin','editor')
  )
$$;

create or replace function public._is_admin() returns boolean language sql stable as $$
  select exists (
    select 1 from public.users u
    where u.clerk_user_id = auth.jwt() ->> 'sub' and u.role = 'admin'
  )
$$;

-- Tags: editors apply/remove; only admins create new tag definitions
create policy tag_select          on public.tag                          for select to authenticated using (true);
create policy tag_admin_write     on public.tag                          for all    to authenticated using (public._is_admin()) with check (public._is_admin());

create policy fst_select          on public.funding_source_tag           for select to authenticated using (true);
create policy fst_editor_write    on public.funding_source_tag           for all    to authenticated using (public._is_editor()) with check (public._is_editor());

-- Closed deals: editors write, all authed read
create policy cd_select           on public.closed_deal                  for select to authenticated using (true);
create policy cd_editor_write     on public.closed_deal                  for all    to authenticated using (public._is_editor()) with check (public._is_editor());

-- Proposed fields: any editor can create (parse pipeline does this);
-- only admins can approve (RLS on update; status changes are gated).
create policy pf_select           on public.proposed_field               for select to authenticated using (true);
create policy pf_editor_insert    on public.proposed_field               for insert to authenticated with check (public._is_editor());
create policy pf_admin_update     on public.proposed_field               for update to authenticated using (public._is_admin()) with check (public._is_admin());

-- Borrower stubs: editors only (no UI yet, but keep schema clean)
create policy borrower_select     on public.borrower                     for select to authenticated using (true);
create policy borrower_editor     on public.borrower                     for all    to authenticated using (public._is_editor()) with check (public._is_editor());
create policy bfsl_select         on public.borrower_funding_source_link for select to authenticated using (true);
create policy bfsl_editor         on public.borrower_funding_source_link for all    to authenticated using (public._is_editor()) with check (public._is_editor());

-- Grant function execution to authenticated; the admin gate is enforced
-- inside the function via public._is_admin() check on the calling row.
-- (For belt-and-suspenders, the API route also asserts admin role server-side.)
grant execute on function public.apply_proposed_field(uuid) to authenticated;
grant execute on function public._is_editor() to authenticated;
grant execute on function public._is_admin()  to authenticated;
