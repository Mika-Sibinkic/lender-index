/**
 * POST /api/search/debug — bearer-gated search introspection for E2E/quality
 * iteration (so an operator/agent can run the real pipeline without a Clerk
 * session). Returns RANKING MECHANICS ONLY — extracted params, ordered lender
 * IDs + fit verdicts, per-source candidate counts, timings. NO company names,
 * contacts, notes, or rates → the crown-jewel lender data is never exposed
 * here; resolve IDs → names via direct DB access when judging quality.
 *
 * Gated by SEARCH_DEBUG_TOKEN (NOT Clerk). Public in middleware; auth is
 * enforced inside. Token is on the credential-rotation agenda.
 */

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { runSearch } from '@/lib/search/run'

/**
 * Same values-only contract as /api/search — the server still owns every
 * derivation. Added 2026-09-03 because the "Narrow by" dimensions were
 * unreachable from here, which meant the one harness that measures the accuracy
 * mandate could not see a facet at all. A dimension that can hard-exclude a
 * lender and cannot be measured is the shape of every bug this project has had.
 */
const Constraints = z.object({
  asset_classes: z.array(z.string()).optional(),
  geographic_scope: z.array(z.string()).optional(),
  deal_size_min_usd: z.number().nonnegative().nullable().optional(),
  deal_size_max_usd: z.number().nonnegative().nullable().optional(),
  usage_codes: z.array(z.string()).optional(),
  operation_category: z.string().nullable().optional(),
  lender_type_required: z.string().nullable().optional(),
  us_states: z.array(z.string()).optional(),
  asset_year: z.number().int().nullable().optional(),
  intl_keyword_active: z.boolean().optional(),
})

const Body = z.object({
  q: z.string().min(2).max(500),
  asset_classes: z.array(z.string()).optional(),
  constraints: Constraints.optional(),
  limit: z.number().int().min(1).max(50).default(25),
  rewrite: z.boolean().optional(),
  graph: z.boolean().optional(),
  rerank: z.boolean().optional(),
})

export const maxDuration = 60

export async function POST(req: NextRequest) {
  const token = process.env.SEARCH_DEBUG_TOKEN
  const provided = req.headers.get('authorization')
  if (!token || provided !== `Bearer ${token}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const parsed = Body.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  }

  const r = await runSearch(getSupabaseAdmin(), {
    q: parsed.data.q,
    assetClasses: parsed.data.asset_classes,
    constraints: parsed.data.constraints,
    limit: parsed.data.limit,
    rewrite: parsed.data.rewrite,
    graph: parsed.data.graph,
    rerank: parsed.data.rerank,
  })

  return NextResponse.json({
    query: parsed.data.q,
    extraction: r.extraction,
    effective: r.effective,
    effectiveAssetClasses: r.effectiveAssetClasses,
    graphSeedKeys: r.graphSeedKeys,
    sourceCounts: r.sourceCounts,
    flags: r.flags,
    timings: r.timings,
    ranked: r.results.map((row, i) => ({ rank: i, id: row.id, fit: row.fit })),
  })
}
