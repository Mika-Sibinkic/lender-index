/**
 * NL search query → structured filter rewrite.
 *
 * Given a search query like "equipment finance under $5M for Texas logistics
 * operators", returns a stripped-down semantic query plus a set of
 * canonical filters the search route can apply alongside the embedding.
 *
 * Fast-path: cheap regex extracts $-amount limits before calling the LLM
 * so the LLM only needs to handle the harder cases (asset class, geo,
 * industry).
 */

import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { llm } from '@/lib/llm/client'
import { ASSET_CLASSES } from '@/lib/types/funding-source'
import { BORROWER_INDUSTRIES, DOMAIN_DESCRIPTION } from '@/lib/config/domain'

export const queryRewriteSchema = z.object({
  semantic_query: z.string().min(2),
  asset_classes: z.array(z.string()).default([]),
  deal_size_min_usd: z.number().nullable().default(null),
  deal_size_max_usd: z.number().nullable().default(null),
  geographic_scope: z.array(z.string()).default([]),
  industry_filters: z.array(z.string()).default([]),
})

export type QueryRewrite = z.infer<typeof queryRewriteSchema>

const SYSTEM = `You normalize a natural-language search query about ${DOMAIN_DESCRIPTION} funding sources into:
  - semantic_query: cleaned-up query stripped of structured constraints — what to embed for kNN
  - asset_classes: subset of [${ASSET_CLASSES.join(', ')}] (canonical, never invent)
  - deal_size_min_usd / deal_size_max_usd: numeric in plain dollars
  - geographic_scope: array of US states / countries / regions ("Texas", "California", "US", "Canada", "Latin America")
  - industry_filters: array of borrower-side industry tags (${BORROWER_INDUSTRIES.map((i) => JSON.stringify(i)).join(', ')})

Rules:
- Only fill structured fields that are explicitly indicated.
- Convert "$5M"/"5 million" to 5000000, "$500k" to 500000, "under $5M" to deal_size_max_usd=5000000.
- "high-LTV", "subprime", "low rate" etc. → leave in semantic_query, do NOT invent a field for them.
- Strip the parts you moved into structured fields out of semantic_query, leaving the qualitative intent.
- Return JSON only.`

export async function rewriteQuery(
  supabase: SupabaseClient,
  query: string,
): Promise<QueryRewrite> {
  try {
    const res = await llm.object<QueryRewrite>({
      schema: queryRewriteSchema,
      system: SYSTEM,
      prompt: `Query: ${JSON.stringify(query)}`,
      supabase,
      module: 'search.rewrite',
    })
    const rw = res.object
    // Constrain asset_classes to the canonical set; drop unknown values
    rw.asset_classes = rw.asset_classes.filter((c) =>
      (ASSET_CLASSES as readonly string[]).includes(c),
    )
    return rw
  } catch (e) {
    // Best-effort: rewrite failure means we use the raw query, no filters.
    console.warn(`query-rewrite failed: ${(e as Error).message}`)
    return {
      semantic_query: query,
      asset_classes: [],
      deal_size_min_usd: null,
      deal_size_max_usd: null,
      geographic_scope: [],
      industry_filters: [],
    }
  }
}
