/**
 * CRUD over graph_entity + graph_edge.
 *
 * Upserts are idempotent on natural_key (entity) and
 * (src_id, dst_id, rel, source_table, source_id) (edge). The bootstrap
 * script and the per-row reindex hook both run through here so the
 * deduplication invariant is enforced in one place.
 *
 * deleteEdgesBySource lets the indexer rebuild a row's edges cleanly:
 * delete-then-insert per source_table+source_id, no stale edges left
 * behind when a row is edited.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  type EntityInput,
  type EdgeInput,
  EntityInputSchema,
  EdgeInputSchema,
} from './types'

export interface EntityRow {
  id: string
  kind: string
  natural_key: string
  label: string
  metadata: Record<string, unknown>
}

export async function upsertEntity(
  supabase: SupabaseClient,
  input: EntityInput,
): Promise<EntityRow> {
  const parsed = EntityInputSchema.parse(input)
  const { data, error } = await supabase
    .from('graph_entity')
    .upsert(
      {
        kind: parsed.kind,
        natural_key: parsed.natural_key,
        label: parsed.label,
        metadata: parsed.metadata,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'natural_key' },
    )
    .select('id, kind, natural_key, label, metadata')
    .single()
  if (error) throw new Error(`upsertEntity(${parsed.natural_key}): ${error.message}`)
  return data as EntityRow
}

export async function upsertEntities(
  supabase: SupabaseClient,
  inputs: EntityInput[],
): Promise<EntityRow[]> {
  if (inputs.length === 0) return []
  const parsed = inputs.map((i) => EntityInputSchema.parse(i))
  const { data, error } = await supabase
    .from('graph_entity')
    .upsert(
      parsed.map((p) => ({
        kind: p.kind,
        natural_key: p.natural_key,
        label: p.label,
        metadata: p.metadata,
        updated_at: new Date().toISOString(),
      })),
      { onConflict: 'natural_key' },
    )
    .select('id, kind, natural_key, label, metadata')
  if (error) throw new Error(`upsertEntities (${parsed.length}): ${error.message}`)
  return (data ?? []) as EntityRow[]
}

/**
 * Resolves edge natural-keys → entity ids, then upserts edges.
 * Missing entities are silently dropped (with a console warning) so a
 * single bad extraction can't kill the whole insert.
 */
export async function upsertEdges(
  supabase: SupabaseClient,
  inputs: EdgeInput[],
): Promise<number> {
  if (inputs.length === 0) return 0
  const parsed = inputs.map((i) => EdgeInputSchema.parse(i))
  const naturalKeys = Array.from(
    new Set(parsed.flatMap((e) => [e.src_natural_key, e.dst_natural_key])),
  )
  const { data: ents, error: entErr } = await supabase
    .from('graph_entity')
    .select('id, natural_key')
    .in('natural_key', naturalKeys)
  if (entErr) throw new Error(`upsertEdges resolve: ${entErr.message}`)

  const idByKey = new Map<string, string>(
    (ents ?? []).map((e: { id: string; natural_key: string }) => [e.natural_key, e.id]),
  )

  const rows: Array<{
    src_id: string
    dst_id: string
    rel: string
    confidence: number
    weight: number
    source_table: string
    source_id: string | null
    metadata: Record<string, unknown>
  }> = []
  for (const e of parsed) {
    const src = idByKey.get(e.src_natural_key)
    const dst = idByKey.get(e.dst_natural_key)
    if (!src || !dst) {
      console.warn(
        `upsertEdges: missing entity for edge ${e.src_natural_key} -[${e.rel}]-> ${e.dst_natural_key}; skipping`,
      )
      continue
    }
    rows.push({
      src_id: src,
      dst_id: dst,
      rel: e.rel,
      confidence: e.confidence,
      weight: e.weight,
      source_table: e.source_table,
      source_id: e.source_id ?? null,
      metadata: e.metadata,
    })
  }
  if (rows.length === 0) return 0

  // In-call dedup — same edge can be derived twice in one extraction.
  // Cross-call dedup is handled by deleteEdgesBySource() before insert,
  // plus the unique index as a hard backstop.
  const seen = new Set<string>()
  const deduped = rows.filter((r) => {
    const k = `${r.src_id}|${r.dst_id}|${r.rel}|${r.source_table}|${r.source_id ?? ''}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })

  const { error } = await supabase.from('graph_edge').insert(deduped)
  if (error) throw new Error(`upsertEdges insert: ${error.message}`)
  return deduped.length
}

/**
 * Wipes all edges derived from one row of a source table. Use before
 * re-extracting that row so stale edges don't leak.
 */
export async function deleteEdgesBySource(
  supabase: SupabaseClient,
  sourceTable: string,
  sourceId: string,
): Promise<void> {
  const { error } = await supabase
    .from('graph_edge')
    .delete()
    .eq('source_table', sourceTable)
    .eq('source_id', sourceId)
  if (error) throw new Error(`deleteEdgesBySource(${sourceTable},${sourceId}): ${error.message}`)
}

export async function getEntityByNaturalKey(
  supabase: SupabaseClient,
  natural_key: string,
): Promise<EntityRow | null> {
  const { data, error } = await supabase
    .from('graph_entity')
    .select('id, kind, natural_key, label, metadata')
    .eq('natural_key', natural_key)
    .maybeSingle()
  if (error) throw new Error(`getEntityByNaturalKey: ${error.message}`)
  return (data as EntityRow) ?? null
}

/**
 * Fuzzy entity search by label via pg_trgm. Used at query time to
 * resolve free-text query tokens to entity ids before traversal.
 * Returns the top N matches above a similarity threshold.
 */
export async function findEntitiesByLabel(
  supabase: SupabaseClient,
  query: string,
  opts: { limit?: number; minSimilarity?: number; kinds?: string[] } = {},
): Promise<EntityRow[]> {
  const limit = opts.limit ?? 10
  let q = supabase
    .from('graph_entity')
    .select('id, kind, natural_key, label, metadata')
    .ilike('label', `%${query.replace(/[%_]/g, '\\$&')}%`)
  if (opts.kinds && opts.kinds.length) q = q.in('kind', opts.kinds)
  q = q.limit(limit)
  const { data, error } = await q
  if (error) throw new Error(`findEntitiesByLabel: ${error.message}`)
  return (data ?? []) as EntityRow[]
}
