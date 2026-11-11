-- Recursive CTE traversal RPC for GraphRAG.
-- Walks the entity/edge graph from seed_ids up to max_hops, accumulating
-- path scores; returns funder_uuid + score + traversal trace.
-- See src/lib/graph/traverse.ts for calling convention.
--
-- Postgres recursive CTE rule: exactly one UNION ALL between the
-- non-recursive anchor and the recursive term. Bidirectional edge
-- traversal is collapsed via `OR` + `CASE` on src/dst — not two unions.

create or replace function public.graph_traverse_funders(
  seed_ids uuid[],
  max_hops int default 3,
  match_count int default 50
)
returns table (
  funder_uuid uuid,
  score double precision,
  hops text[],
  seeds text[]
)
language sql stable
set search_path = public
as $$
  with recursive walk as (
    select
      e.id            as node_id,
      e.natural_key   as node_key,
      e.kind          as node_kind,
      0               as hop,
      1.0::double precision as path_score,
      array[]::text[] as path_rels,
      array[e.natural_key]::text[] as path_seeds
    from public.graph_entity e
    where e.id = any(seed_ids)

    union all

    select
      ne.id,
      ne.natural_key,
      ne.kind,
      w.hop + 1,
      w.path_score * ed.confidence * ed.weight
                   / (w.hop + 1)::double precision,
      array_append(w.path_rels, ed.rel),
      w.path_seeds
    from walk w
    join public.graph_edge ed
      on ed.src_id = w.node_id or ed.dst_id = w.node_id
    join public.graph_entity ne
      on ne.id = case when ed.src_id = w.node_id then ed.dst_id else ed.src_id end
    where w.hop < max_hops
  ),
  funder_hits as (
    select
      substring(node_key from '^funder\.(.*)$')::uuid as funder_uuid,
      sum(path_score)                  as score,
      array_agg(distinct unnest_rel)   as hops,
      array_agg(distinct unnest_seed)  as seeds
    from walk
    cross join lateral unnest(path_rels) as unnest_rel
    cross join lateral unnest(path_seeds) as unnest_seed
    where node_kind = 'funder' and node_key like 'funder.%' and hop > 0
    group by funder_uuid
  )
  select funder_uuid, score, hops, seeds
  from funder_hits
  where funder_uuid is not null
  order by score desc
  limit match_count
$$;

grant execute on function public.graph_traverse_funders(uuid[], int, int) to authenticated;
