-- Switch the funding_source_embeddings column from vector(1536) → vector(768)
-- to match nomic-embed-text (default local / self-hosted embedding model).
-- Replace ivfflat with hnsw — hnsw works on any-dim and gives better recall
-- at roster scale (hundreds of rows).
--
-- Run before any embeddings exist; backfill-embeddings re-creates them.

drop index if exists public.funding_source_embeddings_ivfflat;

alter table public.funding_source_embeddings
  drop column if exists embedding;

alter table public.funding_source_embeddings
  add column embedding vector(768);

create index if not exists funding_source_embeddings_hnsw
  on public.funding_source_embeddings using hnsw (embedding vector_cosine_ops);

-- Replace match RPC with the new dim. Drop both old signatures first to
-- avoid PG complaining about overloaded return types.
drop function if exists public.match_funding_sources(vector(1536), int);
drop function if exists public.match_funding_sources(vector, int);

create or replace function public.match_funding_sources(
  query_embedding vector(768),
  match_count int default 25
)
returns table (id uuid, similarity float)
language sql stable
set search_path = public
as $$
  select
    fs.id,
    1 - (fse.embedding <=> query_embedding) as similarity
  from public.funding_source_embeddings fse
  join public.funding_sources fs on fs.id = fse.funding_source_id
  where fse.embedding is not null
  order by fse.embedding <=> query_embedding asc
  limit match_count
$$;

grant execute on function public.match_funding_sources(vector(768), int) to authenticated;

-- dims metadata: default to 768 going forward.
alter table public.funding_source_embeddings
  alter column dims set default 768;
