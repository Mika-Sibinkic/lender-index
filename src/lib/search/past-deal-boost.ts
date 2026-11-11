/**
 * Past-deal preference boost.
 *
 * Cheap regex extracts a 4-digit year and any configured make tokens
 * (ASSET_MAKES in src/lib/config/vocabulary.ts) from the user's query string.
 * Then looks up closed_deal rows that match those tokens within ±3 years.
 * Any funding_source_id appearing in those rows is boosted in the final
 * ranking — "2015 Caterpillar -> ABC Bank funded one, try them again".
 *
 * Light by design: hard funding facts (who-funds-what) override the
 * past-preference signal.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { ASSET_MAKES } from '@/lib/config/domain'

export interface QueryTokens {
  year: number | null
  makes: string[]
}

export function tokenizeQuery(q: string): QueryTokens {
  const lower = q.toLowerCase()
  const yearMatch = lower.match(/\b(19|20)\d{2}\b/)
  const year = yearMatch ? parseInt(yearMatch[0], 10) : null
  const makes: string[] = []
  for (const m of ASSET_MAKES) {
    if (lower.includes(m)) makes.push(m)
  }
  return { year, makes }
}

export async function fundingSourceIdsWithPastDeal(
  supabase: SupabaseClient,
  tokens: QueryTokens,
  candidateIds: string[],
): Promise<Set<string>> {
  if (!tokens.year && tokens.makes.length === 0) return new Set()
  if (candidateIds.length === 0) return new Set()

  let q = supabase
    .from('closed_deal')
    .select('funding_source_id, asset_year, asset_make, asset_model')
    .not('funding_source_id', 'is', null)
    .in('funding_source_id', candidateIds)

  if (tokens.year) {
    q = q.gte('asset_year', tokens.year - 3).lte('asset_year', tokens.year + 3)
  }

  const { data } = await q
  if (!data) return new Set()

  const matching = new Set<string>()
  for (const row of data as Array<{
    funding_source_id: string | null
    asset_make: string | null
    asset_model: string | null
  }>) {
    if (!row.funding_source_id) continue
    if (tokens.makes.length === 0) {
      matching.add(row.funding_source_id)
      continue
    }
    const blob = `${row.asset_make ?? ''} ${row.asset_model ?? ''}`.toLowerCase()
    if (tokens.makes.some((m) => blob.includes(m))) {
      matching.add(row.funding_source_id)
    }
  }
  return matching
}

/**
 * Re-orders the fused ids by promoting any whose funding_source has a
 * matching past deal. Stable on the rest.
 */
export function applyPastDealBoost(
  fusedIds: string[],
  boostedIds: Set<string>,
): string[] {
  if (boostedIds.size === 0) return fusedIds
  const head: string[] = []
  const tail: string[] = []
  for (const id of fusedIds) {
    if (boostedIds.has(id)) head.push(id)
    else tail.push(id)
  }
  return [...head, ...tail]
}
