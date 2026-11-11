-- Funding-source document chunks for RAG-style semantic search over
-- uploaded PDFs / term sheets / business cards. Each chunk is a ~800-char
-- sliding window with overlap, embedded via the same llm.embed pipeline
-- that powers funding_source_embeddings.
--
-- Match RPC returns the chunk + its funding_source_id so the hybrid
-- search route can collapse to per-lender ranking.

create table if not exists public.funding_source_doc_chunks (
  id                uuid primary key default gen_random_uuid(),
  funding_source_id uuid not null references public.funding_sources(id) on delete cascade,
  document_id       uuid references public.funding_source_documents(id) on delete cascade,
  chunk_index       int not null,
  text              text not null,
  embedding         vector(768),
  model             text,
  dims              int default 768,
  created_at        timestamptz not null default now(),
  unique (document_id, chunk_index)
);

create index if not exists fsdc_fs_id_idx   on public.funding_source_doc_chunks (funding_source_id);
create index if not exists fsdc_doc_id_idx  on public.funding_source_doc_chunks (document_id);
create index if not exists fsdc_hnsw_idx
  on public.funding_source_doc_chunks using hnsw (embedding vector_cosine_ops);

alter table public.funding_source_doc_chunks enable row level security;
drop policy if exists fsdc_admin on public.funding_source_doc_chunks;
create policy fsdc_admin
  on public.funding_source_doc_chunks for all to authenticated
  using (public._is_admin()) with check (public._is_admin());

-- Match RPC: kNN over chunks; returns chunk + parent funding_source_id.
drop function if exists public.match_doc_chunks(vector(768), int);
create or replace function public.match_doc_chunks(
  query_embedding vector(768),
  match_count int default 25
)
returns table (
  id uuid,
  funding_source_id uuid,
  document_id uuid,
  chunk_index int,
  text text,
  similarity float
)
language sql stable
set search_path = public
as $$
  select
    fsdc.id,
    fsdc.funding_source_id,
    fsdc.document_id,
    fsdc.chunk_index,
    fsdc.text,
    1 - (fsdc.embedding <=> query_embedding) as similarity
  from public.funding_source_doc_chunks fsdc
  where fsdc.embedding is not null
  order by fsdc.embedding <=> query_embedding asc
  limit match_count
$$;

grant execute on function public.match_doc_chunks(vector(768), int) to authenticated;

-- Convenience column: extend funding_source_documents with what we extract.
alter table public.funding_source_documents
  add column if not exists body_text text,
  add column if not exists provider text,
  add column if not exists indexed_at timestamptz;
