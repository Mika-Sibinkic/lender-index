/**
 * Embedding helpers for semantic search over funding_sources.
 *
 * The actual model call lives in `src/lib/llm/client.ts`; this module
 * owns:
 *   - sourceText: canonical concatenation of the indexed fields
 *   - rrf: reciprocal-rank-fusion to merge BM25 and pgvector rankings
 *   - indexFundingSource: best-effort embed + upsert called on
 *     insert / update so semantic search never sees stale rows
 *
 * Indexing writes to public.funding_source_embeddings. The column is
 * vector(768) post-migration 0008 to match nomic-embed-text — the
 * default Mac-dev + on-prem box embedding model. If the configured
 * EMBED_MODEL returns a different dim, the write is skipped with a
 * warning (search degrades to FTS-only).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { FundingSourceRow } from '@/lib/types/funding-source'
import { llm, LLM_MODELS } from '@/lib/llm/client'

/**
 * The text we embed for each funding source. Concatenates the fields
 * that meaningfully describe the source — company, notes, structured
 * filterable columns (asset classes / geos / industries), and v2
 * additions. Including the structured columns in the embedding text
 * is what lets a "Korea excavator" or "$80M fleet" query find
 * the right lender even when the body of the notes doesn't repeat
 * the geo or asset class.
 */
export function sourceText(
  // Only the company name is actually required — every other field below is
  // read defensively (`?? ''`, `?.length`, `n == null`) precisely so a partial
  // row still embeds. The signature said otherwise, which forced callers to
  // pass fields this function never needs.
  row: Pick<FundingSourceRow, 'company_name'> &
    Partial<
      Pick<
        FundingSourceRow,
        | 'internal_notes'
        | 'rate_notes'
        | 'asset_classes'
        | 'geographic_scope'
        | 'industry_filters'
        | 'deal_size_min_usd'
        | 'deal_size_max_usd'
      >
    > & {
    interest_rate_notes?: string | null
    prepayment_penalty?: string | null
    down_payment_notes?: string | null
    asset_subtypes?: string[] | null
    specific_geographic?: string | null
    lender_type?: string | null
    operation_category?: string | null
    vintage_restriction?: string | null
  },
): string {
  const fmtUsd = (n: number | null | undefined): string | null => {
    if (n == null || !Number.isFinite(Number(n))) return null
    const x = Number(n)
    if (x >= 1_000_000) return `$${Math.round(x / 1_000_000)}M`
    if (x >= 1_000) return `$${Math.round(x / 1_000)}K`
    return `$${x}`
  }
  const dealMin = fmtUsd(row.deal_size_min_usd)
  const dealMax = fmtUsd(row.deal_size_max_usd)
  const dealRange =
    dealMin || dealMax
      ? `deal range: ${dealMin ?? '?'} to ${dealMax ?? '?'}`
      : ''

  return [
    row.company_name,
    row.internal_notes ?? '',
    row.rate_notes ?? '',
    row.interest_rate_notes ?? '',
    row.prepayment_penalty ? `prepayment: ${row.prepayment_penalty}` : '',
    row.down_payment_notes ?? '',
    row.asset_classes?.length ? `asset classes: ${row.asset_classes.join(', ')}` : '',
    row.asset_subtypes?.length ? `asset subtypes: ${row.asset_subtypes.join(', ')}` : '',
    row.geographic_scope?.length ? `geographic scope: ${row.geographic_scope.join(', ')}` : '',
    row.specific_geographic ? `specific geography: ${row.specific_geographic}` : '',
    row.industry_filters?.length ? `industries: ${row.industry_filters.join(', ')}` : '',
    row.lender_type ? `lender type: ${row.lender_type}` : '',
    row.operation_category ? `operation: ${row.operation_category}` : '',
    row.vintage_restriction ? `vintage restriction: ${row.vintage_restriction}` : '',
    dealRange,
  ]
    .filter((s) => s.trim().length > 0)
    .join('\n\n')
}

export const EMBEDDING_DIMS = 768

/**
 * User-facing, non-fatal warning to surface when a save succeeded but the
 * semantic index didn't (embed backend down / dim mismatch / upsert error).
 * Routes await indexFundingSource and, on `{ ok: false }`, include this in
 * their success JSON so the row's invisibility-to-vector-search is observable
 * rather than silent. The row is still picked up by the next full reindex
 * (`/api/admin/reindex-embeddings`, which re-embeds every row).
 */
export const INDEX_PENDING_WARNING =
  'Saved, but AI indexing is pending (search backend unavailable). It will be picked up on the next reindex.'

type IndexableRow = Parameters<typeof sourceText>[0] & { id: string }

/**
 * Embed the row's canonical sourceText and upsert into
 * funding_source_embeddings. Best-effort — any failure logs and resolves
 * without throwing so the calling insert/update isn't blocked.
 *
 * Callers should AWAIT this (not fire-and-forget) and, on `{ ok: false }`,
 * surface INDEX_PENDING_WARNING in their response so a saved-but-unsearchable
 * row is observable. Returning `{ ok: false }` never means the save failed —
 * only that the vector index is stale and a reindex is needed.
 */
export async function indexFundingSource(
  supabase: SupabaseClient,
  row: IndexableRow,
): Promise<{ ok: boolean; reason?: string }> {
  const text = sourceText(row)
  if (!text.trim()) {
    return { ok: false, reason: 'empty sourceText' }
  }
  try {
    const { embeddings } = await llm.embed({
      supabase,
      module: 'embeddings.index',
      values: [text],
    })
    const vec = embeddings[0]
    if (!Array.isArray(vec) || vec.length !== EMBEDDING_DIMS) {
      console.warn(
        `indexFundingSource: dim mismatch ${vec?.length} != ${EMBEDDING_DIMS}; skipping`,
      )
      return { ok: false, reason: `dim mismatch (${vec?.length})` }
    }
    const { error } = await supabase
      .from('funding_source_embeddings')
      .upsert(
        {
          funding_source_id: row.id,
          embedding: vec,
          model: LLM_MODELS.embed,
          dims: EMBEDDING_DIMS,
          indexed_at: new Date().toISOString(),
        },
        { onConflict: 'funding_source_id' },
      )
    if (error) {
      // error-level: the row is now saved-but-unsearchable until a reindex.
      console.error(
        `indexFundingSource upsert failed for ${row.id}: ${error.message}`,
      )
      return { ok: false, reason: error.message }
    }
    return { ok: true }
  } catch (e) {
    // error-level: most commonly the embed backend is unreachable, which
    // leaves the row saved-but-unsearchable until the next reindex.
    console.error(
      `indexFundingSource embed failed for ${row.id}: ${(e as Error).message}`,
    )
    return { ok: false, reason: (e as Error).message }
  }
}

/**
 * Reciprocal-rank-fusion.
 *
 * Given N ranked lists of IDs, returns a single ranked list where the
 * score of each ID is sum of 1 / (k + rank_i) across lists that
 * contain it. k=60 is the standard choice from the RRF paper.
 */
export function rrf(rankings: string[][], k = 60): string[] {
  const scores = new Map<string, number>()
  for (const list of rankings) {
    list.forEach((id, i) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + i + 1))
    })
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => id)
}
