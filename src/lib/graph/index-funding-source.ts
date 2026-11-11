/**
 * Continuous graph indexer — re-extracts entities + edges for a single
 * funding_source / closed_deal / contact row and upserts them.
 *
 * Mirrors the embedding indexer (src/lib/embeddings/indexFundingSource):
 * fire-and-forget from API routes, best-effort, logs+swallows errors so
 * a graph-write failure can't block the parent insert/update.
 *
 * Continuous index with a single touchpoint: every write path calls this one
 * function rather than re-implementing extraction.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  extractFromFundingSource,
  extractFromClosedDeal,
  extractFromContact,
  augmentFromText,
  type FundingSourceCols,
  type ClosedDealCols,
  type ContactCols,
} from './extract'
import { upsertEntities, upsertEdges, deleteEdgesBySource } from './repo'
import type { EntityInput, EdgeInput } from './types'

interface IndexResult {
  ok: boolean
  reason?: string
  entities?: number
  edges?: number
}

async function applyExtraction(
  supabase: SupabaseClient,
  sourceTable: 'funding_sources' | 'closed_deal' | 'funding_source_contacts',
  sourceId: string,
  result: { entities?: EntityInput[]; edges?: EdgeInput[] },
): Promise<IndexResult> {
  try {
    await deleteEdgesBySource(supabase, sourceTable, sourceId)
    const ents = await upsertEntities(supabase, result.entities ?? [])
    const edgeCount = await upsertEdges(supabase, result.edges ?? [])
    return { ok: true, entities: ents.length, edges: edgeCount }
  } catch (e) {
    const reason = (e as Error).message
    console.warn(`graph index ${sourceTable}=${sourceId} failed: ${reason}`)
    return { ok: false, reason }
  }
}

/**
 * Re-extract + re-upsert graph data for one funding_sources row.
 * Includes the LLM augment pass over free-text (internal_notes +
 * rate_notes) when `augment` is true (default).
 */
export async function indexGraphForFundingSource(
  supabase: SupabaseClient,
  row: FundingSourceCols & { internal_notes?: string | null; rate_notes?: string | null },
  opts: { augment?: boolean } = {},
): Promise<IndexResult> {
  const result = extractFromFundingSource(row)

  if (opts.augment !== false) {
    const blob = [row.internal_notes ?? '', row.rate_notes ?? ''].join('\n\n').trim()
    if (blob) {
      try {
        const aug = await augmentFromText(supabase, blob, { funding_source_id: row.id })
        result.entities = [...(result.entities ?? []), ...(aug.entities ?? [])]
        result.edges = [...(result.edges ?? []), ...(aug.edges ?? [])]
      } catch (e) {
        // Augment failure is non-fatal; the deterministic edges still ship
        console.warn(`augmentFromText failed for ${row.id}: ${(e as Error).message}`)
      }
    }
  }

  return applyExtraction(supabase, 'funding_sources', row.id, result)
}

/**
 * Re-extract + re-upsert graph data for one closed_deal row.
 * No LLM augment — closed_deal is structured-only.
 */
export async function indexGraphForClosedDeal(
  supabase: SupabaseClient,
  row: ClosedDealCols,
): Promise<IndexResult> {
  const result = extractFromClosedDeal(row)
  return applyExtraction(supabase, 'closed_deal', row.id, result)
}

/**
 * Re-extract + re-upsert graph data for one funding_source_contacts row.
 */
export async function indexGraphForContact(
  supabase: SupabaseClient,
  row: ContactCols,
): Promise<IndexResult> {
  const result = extractFromContact(row)
  return applyExtraction(supabase, 'funding_source_contacts', row.id, result)
}
