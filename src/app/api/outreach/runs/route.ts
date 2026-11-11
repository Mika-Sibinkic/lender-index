import { NextRequest, NextResponse } from 'next/server'
import { requireAuthorizedApiUser } from '@/lib/auth/require-authorized'
import { z } from 'zod'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { draftRun } from '@/lib/outreach/runs'
import { missingFieldsFor, type StalenessRow } from '@/lib/outreach/staleness'

export const dynamic = 'force-dynamic'

const requestSchema = z.object({
  funding_source_id: z.string().uuid(),
})

/**
 * Admin-only manual trigger: enqueue + draft one funding source's
 * outreach run on demand. Useful for a small human-eval batch of drafts.
 */
export async function POST(req: NextRequest) {
  const authz = await requireAuthorizedApiUser()
  if (!authz.ok) return authz.response
  const { userId } = authz

  const body = await req.json().catch(() => ({}))
  const parsed = requestSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  }
  const fsId = parsed.data.funding_source_id

  const admin = getSupabaseAdmin()
  const { data: user } = await admin
    .from('users')
    .select('role')
    .eq('clerk_user_id', userId)
    .single()
  if (!user || user.role !== 'admin') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const { data: fs, error: fsErr } = await admin
    .from('funding_sources')
    .select('id, last_contact_at, outreach_status, required_field_gaps, primary_contact_email')
    .eq('id', fsId)
    .single()
  if (fsErr || !fs) return NextResponse.json({ error: 'funding source not found' }, { status: 404 })
  if (!fs.primary_contact_email) {
    return NextResponse.json({ error: 'primary_contact_email is empty' }, { status: 422 })
  }

  // Skip if already an open run
  const { data: open } = await admin
    .from('outreach_run')
    .select('id, status')
    .eq('funding_source_id', fsId)
    .in('status', ['queued', 'drafting', 'awaiting_approval'])
    .maybeSingle()
  if (open) {
    return NextResponse.json({ run_id: open.id, status: open.status, reused: true })
  }

  const now = new Date()
  const { data: run, error: insErr } = await admin
    .from('outreach_run')
    .insert({
      funding_source_id: fsId,
      status: 'queued',
      missing_fields: missingFieldsFor(fs as StalenessRow, now),
    })
    .select('id')
    .single()
  if (insErr || !run) return NextResponse.json({ error: insErr?.message }, { status: 500 })

  try {
    const out = await draftRun(admin, run.id)
    return NextResponse.json({ run_id: run.id, drafted: !!out, status: 'awaiting_approval' })
  } catch (e) {
    return NextResponse.json({ run_id: run.id, error: (e as Error).message }, { status: 500 })
  }
}
