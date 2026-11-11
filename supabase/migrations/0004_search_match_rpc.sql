-- Hybrid search support — the kNN RPC.
-- ivfflat index on funding_source_embeddings already exists (0002).
-- search_tsv generated column exists (0001).
-- This file is the source-of-truth replay for the RPC.

create or replace function public.match_funding_sources(
  query_embedding vector(1536),
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
  order by fse.embedding <=> query_embedding asc
  limit match_count
$$;

grant execute on function public.match_funding_sources(vector, int) to authenticated;
