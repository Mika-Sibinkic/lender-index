-- GraphRAG: entity + edge tables. Closed taxonomies enforced by
-- check constraints.
-- pg_trgm enables fuzzy label match for query entity resolution.

create extension if not exists pg_trgm;

-- Entity nodes
create table if not exists public.graph_entity (
  id           uuid primary key default gen_random_uuid(),
  kind         text not null check (kind in (
                 'funder','contact','asset_family','asset_model',
                 'geo','industry','doc_kind','borrower_profile')),
  natural_key  text not null unique,
  label        text not null,
  metadata     jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists graph_entity_kind_idx on public.graph_entity (kind);
create index if not exists graph_entity_label_trgm_idx
  on public.graph_entity using gin (label gin_trgm_ops);

-- Edges (directed)
create table if not exists public.graph_edge (
  id              uuid primary key default gen_random_uuid(),
  src_id          uuid not null references public.graph_entity(id) on delete cascade,
  dst_id          uuid not null references public.graph_entity(id) on delete cascade,
  rel             text not null check (rel in (
                    'employs','operates_in','serves','funded','capped_at',
                    'works_at','is_a','emitted')),
  confidence      numeric(4,3) not null default 1.0 check (confidence between 0 and 1),
  weight          numeric(6,4) not null default 1.0,
  source_table    text not null,
  source_id       uuid,
  metadata        jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);
create index if not exists graph_edge_src_idx on public.graph_edge (src_id, rel);
create index if not exists graph_edge_dst_idx on public.graph_edge (dst_id, rel);
create index if not exists graph_edge_rel_idx on public.graph_edge (rel);
create unique index if not exists graph_edge_dedup_idx
  on public.graph_edge (src_id, dst_id, rel, source_table,
                        coalesce(source_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- RLS — read for any authed user (drives search); admin-only writes
alter table public.graph_entity enable row level security;
alter table public.graph_edge   enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='graph_entity' and policyname='graph_entity_select') then
    create policy graph_entity_select on public.graph_entity for select to authenticated using (true);
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='graph_entity' and policyname='graph_entity_admin_write') then
    create policy graph_entity_admin_write on public.graph_entity for all to authenticated
      using (public._is_admin()) with check (public._is_admin());
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='graph_edge' and policyname='graph_edge_select') then
    create policy graph_edge_select on public.graph_edge for select to authenticated using (true);
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='graph_edge' and policyname='graph_edge_admin_write') then
    create policy graph_edge_admin_write on public.graph_edge for all to authenticated
      using (public._is_admin()) with check (public._is_admin());
  end if;
end $$;
