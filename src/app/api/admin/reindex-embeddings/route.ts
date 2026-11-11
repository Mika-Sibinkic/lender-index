import { NextRequest, NextResponse } from 'next/server'
import { requireAuthorizedApiUser } from '@/lib/auth/require-authorized'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { indexFundingSource } from '@/lib/embeddings'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

/**
 * Admin-only reindex. Hits llm.embed once per funding source and
 * upserts into funding_source_embeddings. Safe to re-run; idempotent.
 *
 * Also callable from cron / shell with Bearer CRON_SECRET so backfills
 * can run without a Clerk session.
 */
function authorized(req: NextRequest): { ok: boolean; viaCron: boolean } {
  const expected = process.env.CRON_SECRET
  if (expected) {
    const bearer = req.headers.get('authorization') ?? ''
    if (bearer === `Bearer ${expected}`) return { ok: true, viaCron: true }
    if (req.headers.get('x-cron-secret') === expected) return { ok: true, viaCron: true }
  }
  return { ok: false, viaCron: false }
}

export async function POST(req: NextRequest) {
  const cronAuth = authorized(req)

  let isAdmin = cronAuth.ok
  if (!cronAuth.ok) {
    const authz = await requireAuthorizedApiUser()
    if (!authz.ok) return authz.response
    const { userId } = authz
    const admin = getSupabaseAdmin()
    const { data: user } = await admin
      .from('users')
      .select('role')
      .eq('clerk_user_id', userId)
      .single()
    isAdmin = user?.role === 'admin'
  }
  if (!isAdmin) return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  const admin = getSupabaseAdmin()
  const { data: rows, error } = await admin
    .from('funding_sources')
    // SELECT * on purpose. This listed seven columns while indexFundingSource
    // builds its embedding text from asset_classes, asset_subtypes,
    // geographic_scope, specific_geographic, industry_filters, lender_type,
    // operation_category, vintage_restriction and both deal-size bounds as well.
    // Every one of those was absent here, so the admin "reindex" button
    // overwrote good vectors with name-and-notes-only ones and counted each as a
    // success. The button that exists to repair search was degrading it.
    .select('*')
    .order('updated_at', { ascending: false })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  let ok = 0
  let skipped = 0
  const failures: Array<{ id: string; reason: string }> = []
  for (const r of rows ?? []) {
    const res = await indexFundingSource(admin, r as unknown as Parameters<typeof indexFundingSource>[1])
    if (res.ok) ok += 1
    else {
      skipped += 1
      failures.push({ id: r.id, reason: res.reason ?? 'unknown' })
    }
  }

  return NextResponse.json({
    total: rows?.length ?? 0,
    ok,
    skipped,
    failures: failures.slice(0, 5),
  })
}

// POST-only: re-embedding mutates state + costs LLM calls, so it must not be
// triggerable by a top-level GET navigation (cookie sessions are SameSite=Lax).
// Cron/shell callers already use POST with the Bearer CRON_SECRET.
