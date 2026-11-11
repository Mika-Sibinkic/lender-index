import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { enqueueRuns, draftRun } from '@/lib/outreach/runs'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

/**
 * Daily cron entry. Vercel signs cron invocations with a Bearer
 * Authorization header equal to CRON_SECRET. We also accept the same
 * value via x-cron-secret to make manual local smoke tests painless.
 */
function authorized(req: NextRequest): boolean {
  const expected = process.env.CRON_SECRET
  if (!expected) return false
  const bearer = req.headers.get('authorization') ?? ''
  if (bearer === `Bearer ${expected}`) return true
  if (req.headers.get('x-cron-secret') === expected) return true
  return false
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const admin = getSupabaseAdmin()
  const enqueued = await enqueueRuns(admin)

  // Pull every queued run (capped by enqueueRuns to MAX_DAILY) and draft
  // them sequentially. Each draftRun is idempotent; partial-failure is
  // safe — a re-run picks up where this one stopped.
  const { data: queued, error } = await admin
    .from('outreach_run')
    .select('id')
    .eq('status', 'queued')
    .order('created_at', { ascending: true })
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const drafted: string[] = []
  const failed: Array<{ id: string; error: string }> = []
  for (const r of queued ?? []) {
    try {
      const out = await draftRun(admin, r.id)
      if (out) drafted.push(r.id)
    } catch (e) {
      failed.push({ id: r.id, error: (e as Error).message })
    }
  }

  return NextResponse.json({
    enqueue: enqueued,
    drafted: drafted.length,
    failed,
  })
}

export const POST = GET
