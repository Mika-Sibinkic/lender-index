/**
 * Graph traversal — given a query string, returns a ranked list of
 * funder ids by walking the entity/edge graph.
 *
 * Pipeline:
 *   1. Resolve query → seed entities (via LLM augment over the query
 *      + fuzzy label match for any literal mentions)
 *   2. Recursive CTE walk from seeds, up to 3 hops, accumulating
 *      funder ids with score = sum(edge.confidence * edge.weight /
 *      hop_distance)
 *   3. Return ranked funder ids
 *
 * Hop limit 3: further hops add noise faster than signal.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { llm } from '@/lib/llm/client'
import { DOMAIN_DESCRIPTION, promptMakes } from '@/lib/config/domain'
import { z } from 'zod'
import {
  naturalKeys,
  slugify,
  EDGE_RELS,
  ENTITY_KINDS,
} from './types'

const QuerySeedSchema = z.object({
  geos: z.array(z.string()).default([]),
  asset_families: z.array(z.string()).default([]),
  asset_models: z.array(z.string()).default([]),
  industries: z.array(z.string()).default([]),
  funder_names: z.array(z.string()).default([]),
})

const QUERY_SYSTEM = `You extract structured entities from a ${DOMAIN_DESCRIPTION} search query so the system can walk a knowledge graph.

Return ONLY JSON matching the schema. Be conservative — only list what is explicitly mentioned. Empty arrays for fields not mentioned.

Fields:
- geos: US states, regions, countries ("Florida", "Texas", "Midwest", "Canada"). NOT cities.
- asset_families: family/brand (${promptMakes(4)}). NOT specific models.
- asset_models: specific model designators (a make plus its model number or name).
- industries: customer industries ("logistics", "construction", "healthcare", "agriculture"). Lowercase.
- funder_names: bank or funder names if explicitly mentioned ("Altair Bank").`

export interface TraversalHit {
  funder_id: string         // funding_sources.id
  score: number
  hops_via: string[]        // edge rels used to reach this funder
  seed_entities: string[]   // natural_keys of seed entities that led here
}

/**
 * Extract structured seeds from a user query via the local LLM.
 * Returns natural-keys that can be matched against graph_entity.
 */
export async function extractQuerySeeds(
  supabase: SupabaseClient,
  query: string,
): Promise<string[]> {
  if (!query.trim()) return []
  const { object } = await llm.object({
    supabase,
    module: 'graph.query',
    schema: QuerySeedSchema,
    system: QUERY_SYSTEM,
    prompt: query.slice(0, 1000),
  })
  const seeds: string[] = []
  for (const g of object.geos) seeds.push(naturalKeys.geo(g))
  for (const f of object.asset_families) seeds.push(naturalKeys.asset_family(f))
  for (const m of object.asset_models) seeds.push(naturalKeys.asset_model(m))
  for (const ind of object.industries) seeds.push(naturalKeys.industry(ind))
  // funder_names → not a natural-key match (funders are keyed by id);
  // resolve by label below via findEntitiesByLabel
  return Array.from(new Set(seeds))
}

/**
 * Resolve a list of natural-keys to entity ids. Drops anything missing.
 */
async function resolveEntityIds(
  supabase: SupabaseClient,
  naturalKeys: string[],
): Promise<string[]> {
  if (naturalKeys.length === 0) return []
  const { data } = await supabase
    .from('graph_entity')
    .select('id, natural_key')
    .in('natural_key', naturalKeys)
  return (data ?? []).map((r: { id: string }) => r.id)
}

/**
 * Walk the graph from seed entity ids and return funder candidates
 * with accumulated scores.
 *
 * Implementation: recursive CTE up to 3 hops. Each step expands
 * outward via any of the EDGE_RELS, accumulating
 *   score += confidence * weight / hop_distance
 * for funders we land on. Multiple paths to the same funder sum.
 */
export async function traverseFromSeeds(
  supabase: SupabaseClient,
  seedEntityIds: string[],
  opts: { limit?: number; maxHops?: number } = {},
): Promise<TraversalHit[]> {
  if (seedEntityIds.length === 0) return []
  const limit = opts.limit ?? 50
  const maxHops = Math.min(Math.max(opts.maxHops ?? 3, 1), 3)

  // Postgres function call via .rpc (defined in migration 0012).
  const { data, error } = await supabase.rpc('graph_traverse_funders', {
    seed_ids: seedEntityIds,
    max_hops: maxHops,
    match_count: limit,
  })
  if (error) {
    console.warn(`traverseFromSeeds rpc failed: ${error.message}`)
    return []
  }

  return (data ?? []).map(
    (r: { funder_uuid: string; score: number; hops: string[]; seeds: string[] }) => ({
      funder_id: r.funder_uuid,
      score: Number(r.score) || 0,
      hops_via: r.hops ?? [],
      seed_entities: r.seeds ?? [],
    }),
  )
}

/**
 * Composite query-time entrypoint — extract seeds + traverse.
 * Returns funding_sources.id list ordered by score, plus the seeds
 * used (for debug surface in /api/search response).
 */
export async function graphRankFunders(
  supabase: SupabaseClient,
  query: string,
  opts: { limit?: number; maxHops?: number; seedKeys?: string[] } = {},
): Promise<{ funderIds: string[]; seedKeys: string[]; hits: TraversalHit[] }> {
  // Prefer caller-supplied deterministic seeds (no LLM). Fall back to the
  // legacy LLM extraction only when seedKeys is not provided at all.
  const seedKeys = opts.seedKeys !== undefined
    ? opts.seedKeys
    : await extractQuerySeeds(supabase, query)
  const seedIds = await resolveEntityIds(supabase, seedKeys)
  if (seedIds.length === 0) {
    return { funderIds: [], seedKeys, hits: [] }
  }
  const hits = await traverseFromSeeds(supabase, seedIds, opts)
  return {
    funderIds: hits.map((h) => h.funder_id),
    seedKeys,
    hits,
  }
}

// keep imports referenced so dead-code purge doesn't drop them
void EDGE_RELS
void ENTITY_KINDS
void slugify
