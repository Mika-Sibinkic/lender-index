/**
 * POST /api/search — hybrid NL deal-match over funding_sources (Clerk-gated).
 * The pipeline lives in src/lib/search/run.ts (shared with /api/search/debug).
 */

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireAuthorizedApiUser } from '@/lib/auth/require-authorized'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { runSearch } from '@/lib/search/run'
import { logActivity } from '@/lib/activity/log'

/**
 * Operator edits from the chip/facet UI. Values only — the server owns every
 * derivation (see lib/search/constraints.ts). Note the deliberate use of
 * `.optional()` on arrays: an ABSENT key means "no edit, use the parse", while
 * an explicit `[]` means "the operator cleared this dimension". Collapsing the
 * two would make a chip impossible to remove.
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
  // Ceiling sits above a real roster's active row count so a
  // structured search can return every lender that fits rather than a page of
  // them. This bounds the SEMANTIC pool; the structured path returns its full
  // ranked set regardless.
  limit: z.number().int().min(1).max(300).default(50),
  rewrite: z.boolean().optional().default(true),
  graph: z.boolean().optional(),
  rerank: z.boolean().optional(),
})

export const maxDuration = 60

export async function POST(req: NextRequest) {
  const authz = await requireAuthorizedApiUser()
  if (!authz.ok) return authz.response

  const admin = getSupabaseAdmin()

  // Actor as the users.id uuid, never the Clerk id — same lookup /api/parse and
  // /api/funding-sources do, so activity_log joins to `users` the way parse_logs
  // does. Resolved before the body check so a rejected search still has a name
  // on it; a `.single()` miss just leaves it null.
  const { data: actor } = await admin
    .from('users')
    .select('id')
    .eq('clerk_user_id', authz.userId)
    .single()
  const userId: string | null = actor?.id ?? null

  const raw: unknown = await req.json().catch(() => ({}))
  const parsed = Body.safeParse(raw)
  if (!parsed.success) {
    // Logged, not just returned. "I typed something and nothing happened" is
    // indistinguishable from a backend failure unless the rejection is on record.
    const attempted = (raw as { q?: unknown })?.q
    await logActivity(admin, {
      kind: 'search',
      summary: typeof attempted === 'string' && attempted ? attempted : '(empty search)',
      detail: { q: typeof attempted === 'string' ? attempted : null, issues: parsed.error.flatten() },
      userId,
      ok: false,
      error: 'search input rejected',
    })
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  }

  let r: Awaited<ReturnType<typeof runSearch>>
  try {
    r = await runSearch(admin, {
      q: parsed.data.q,
      assetClasses: parsed.data.asset_classes,
      constraints: parsed.data.constraints,
      limit: parsed.data.limit,
      rewrite: parsed.data.rewrite,
      graph: parsed.data.graph,
      rerank: parsed.data.rerank,
    })
  } catch (e) {
    // The catch exists for the log line, not for new behaviour: an uncaught
    // throw here already produced a 500 the client read as "no results", which
    // is precisely the silent failure the team could never report on.
    await logActivity(admin, {
      kind: 'search',
      summary: parsed.data.q,
      detail: { q: parsed.data.q, constraints: parsed.data.constraints ?? null },
      userId,
      ok: false,
      error: e instanceof Error ? e.message : 'search failed',
    })
    return NextResponse.json({ error: 'Search failed.' }, { status: 500 })
  }

  // `effective` is the criteria the search actually ran on, so a "wrong
  // results" report can be replayed against what the server really did rather
  // than against what the person remembers typing. The flags say whether
  // retrieval was degraded at the time, which changes the answer entirely.
  await logActivity(admin, {
    kind: 'search',
    summary: parsed.data.q,
    detail: {
      q: parsed.data.q,
      effective: r.effective,
      resultCount: r.results.length,
      embedFailed: r.flags.embedFailed,
      graphFailed: r.flags.graphFailed,
      rerankFailed: r.flags.rerankFailed,
      totalMs: r.timings.totalMs,
    },
    userId,
  })

  return NextResponse.json({
    results: r.results,
    extraction: r.extraction,
    // What the search actually ran on. The UI renders its chips from this, so
    // the screen can never disagree with the criteria that produced the list.
    effective: r.effective,
    sourceCounts: r.sourceCounts,
    flags: r.flags,
    timings: r.timings,
  })
}
