import { NextRequest, NextResponse } from 'next/server'
import { requireAuthorizedApiUser } from '@/lib/auth/require-authorized'
import { getSupabaseServer } from '@/lib/supabase/server'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { syncIncompleteTag } from '@/lib/funding-sources/incomplete-tag'
import { fundingSourceUpdateSchema } from '@/lib/types/funding-source'
import { indexFundingSource, sourceText, INDEX_PENDING_WARNING } from '@/lib/embeddings'
import { indexGraphForFundingSource } from '@/lib/graph/index-funding-source'
import { computeRequiredGaps } from '@/lib/funding-sources/required-fields'
import { mergeNonEmpty } from '@/lib/funding-sources/match'

async function withCostLog<T>(op: string, fn: () => Promise<T>): Promise<T> {
  const t0 = Date.now()
  try {
    return await fn()
  } finally {
    try {
      const admin = getSupabaseAdmin()
      const { error } = await admin.from('cost_log').insert({
        operation_type: op,
        cost_usd_equivalent: 0,
        latency_ms: Date.now() - t0,
      })
      // supabase-js resolves with { error }; it does not throw on a rejected
      // insert, so the catch below only ever sees network faults. An unread
      // error here is how 'spreadsheet' parse_logs rows went missing from
      // 2026-07-17 to 2026-09-08 (see 0021_audit_integrity.sql). Warn, never
      // throw — telemetry must not fail the user's request.
      if (error) console.warn(`cost_log insert failed (${op}):`, error.message)
    } catch {
      // never fail the request because cost_log is down
    }
  }
}

export async function GET(
  _: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  // Parity with the other routes: enforce the email whitelist in app code, not
  // RLS alone. Fail-safe — a non-whitelisted session gets 401/403 before any
  // read. (RLS still applies underneath via the server client.)
  const authz = await requireAuthorizedApiUser()
  if (!authz.ok) return authz.response
  const { id } = await params
  return withCostLog('funding_source.get', async () => {
    const sb = await getSupabaseServer()
    const { data, error } = await sb
      .from('funding_sources')
      .select('*')
      .eq('id', id)
      .single()
    if (error)
      return NextResponse.json({ error: error.message }, { status: 404 })
    return NextResponse.json(data)
  })
}

export async function DELETE(
  _: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authz = await requireAuthorizedApiUser()
  if (!authz.ok) return authz.response
  const { userId } = authz
  const { id } = await params

  return withCostLog('funding_source.delete', async () => {
    const admin = getSupabaseAdmin()
    const { data: user } = await admin
      .from('users')
      .select('id,role')
      .eq('clerk_user_id', userId)
      .single()
    if (!user || !['admin', 'editor'].includes(user.role)) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 })
    }

    // Snapshot for audit log
    const { data: before } = await admin
      .from('funding_sources')
      .select('company_name')
      .eq('id', id)
      .single()
    if (!before)
      return NextResponse.json({ error: 'not found' }, { status: 404 })

    // This row, and every prior edit for the record, now survive the delete:
    // 0021_audit_integrity.sql swapped the funding_source_edits FK from
    // ON DELETE CASCADE to ON DELETE SET NULL. Under the old cascade the audit
    // row written on the line below was erased microseconds later by the delete
    // on the line after it, while the delete dialog promised the opposite.
    //
    // company_name_at_delete is not redundant with old_value: once
    // funding_source_id is NULL it is the only column that identifies which
    // lender the detached history belonged to.
    const { error: auditError } = await admin.from('funding_source_edits').insert({
      funding_source_id: id,
      user_id: user.id,
      field_name: '__DELETED__',
      old_value: JSON.stringify(before.company_name),
      new_value: null,
      reason: 'hard delete from detail page',
      company_name_at_delete: before.company_name,
    })
    // supabase-js resolves with { error } instead of throwing. Surface a failed
    // audit write rather than deleting silently unaudited — but do not block
    // the delete on it, which would leave the user unable to remove a record
    // because the audit table is unhappy.
    if (auditError)
      console.warn(
        'funding_source_edits insert failed (delete audit):',
        auditError.message,
      )

    const { error } = await admin.from('funding_sources').delete().eq('id', id)
    if (error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true })
  })
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authz = await requireAuthorizedApiUser()
  if (!authz.ok) return authz.response
  const { userId } = authz
  const { id } = await params
  const body = await req.json()
  // merge mode (dedup update-in-place): a blank incoming value must NEVER
  // overwrite a populated field ("blank = unknown"). The detail-page inline
  // edit omits merge → it can still deliberately clear a field.
  const merge = body?.merge === true
  const parsed = fundingSourceUpdateSchema.safeParse(body)
  if (!parsed.success)
    return NextResponse.json(
      { error: parsed.error.flatten() },
      { status: 400 }
    )

  return withCostLog('funding_source.patch', async () => {
    const admin = getSupabaseAdmin()
    const { data: user } = await admin
      .from('users')
      .select('id,role')
      .eq('clerk_user_id', userId)
      .single()
    if (!user || !['admin', 'editor'].includes(user.role)) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 })
    }

    const { data: before } = await admin
      .from('funding_sources')
      .select('*')
      .eq('id', id)
      .single()
    if (!before)
      return NextResponse.json({ error: 'not found' }, { status: 404 })

    // In merge mode drop blank incoming fields so an update-in-place never
    // erases a known value. Recompute required_field_gaps on the effective
    // merged record so the "incomplete" flag stays accurate after every edit.
    const effective = merge
      ? mergeNonEmpty(parsed.data as Record<string, unknown>)
      : (parsed.data as Record<string, unknown>)
    const required_field_gaps = computeRequiredGaps({ ...before, ...effective })

    const { data: after, error } = await admin
      .from('funding_sources')
      .update({ ...effective, required_field_gaps, updated_by: user.id })
      .eq('id', id)
      .select()
      .single()
    if (error)
      return NextResponse.json({ error: error.message }, { status: 500 })

    // Keep the `incomplete` tag honest in BOTH directions. A tag that is only
    // ever added becomes a lie the moment someone fills the missing fields in —
    // the same "screen disagrees with the system" class as a stale fit chip.
    await syncIncompleteTag(admin, {
      fundingSourceId: id,
      gaps: required_field_gaps,
      userId: user.id,
    })

    const edits = Object.entries(effective)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .filter(([k, v]) => JSON.stringify((before as any)[k]) !== JSON.stringify(v))
      .map(([k, v]) => ({
        funding_source_id: id,
        user_id: user.id,
        field_name: k,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        old_value: JSON.stringify((before as any)[k]),
        new_value: JSON.stringify(v),
      }))
    if (edits.length) {
      // supabase-js resolves with { error }; a discarded error here means an
      // edit silently leaves no audit trail. Warn, don't throw — the update
      // itself already succeeded.
      const { error: auditError } = await admin
        .from('funding_source_edits')
        .insert(edits)
      if (auditError)
        console.warn(
          'funding_source_edits insert failed (patch audit):',
          auditError.message,
        )
    }

    // Re-index if any of the embedded fields changed.
    const indexedKeys = [
      'company_name',
      'internal_notes',
      'rate_notes',
      'interest_rate_notes',
      'prepayment_penalty',
      'down_payment_notes',
    ]
    const beforeText = sourceText(before)
    const afterText = sourceText(after)
    let indexWarning: string | undefined
    if (
      edits.some((e) => indexedKeys.includes(e.field_name)) ||
      beforeText !== afterText
    ) {
      // Await the semantic-index so a failure (e.g. embed backend down) is
      // observable instead of leaving the edited row searchable on stale text.
      // indexFundingSource never throws; the update already succeeded.
      const indexResult = await indexFundingSource(admin, after)
      if (!indexResult.ok) indexWarning = INDEX_PENDING_WARNING
      void indexGraphForFundingSource(admin, after)
    }

    // Notes changed → the signals read out of them are now stale, and a stale
    // ranking signal is worse than none: it would keep sorting on a sentence the
    // operator has just deleted. Clearing the column is the safe state — the
    // matcher treats absent signals as "nothing known", which is exactly true
    // until the reader runs again (scripts/extract-note-signals.ts).
    //
    // Deliberately NOT re-extracted inline. A model read costs seconds and this
    // is a keystroke-latency path on a record card; making the user wait on the
    // model to save a field is the trade the accuracy mandate does NOT ask for,
    // since the signal only affects ordering.
    if (edits.some((e) => e.field_name === 'internal_notes')) {
      const { error: clearError } = await admin
        .from('funding_sources')
        .update({ note_signals: null })
        .eq('id', id)
      if (clearError)
        console.warn('note_signals clear failed after notes edit:', clearError.message)
    }

    return NextResponse.json(
      indexWarning ? { ...after, warning: indexWarning } : after,
    )
  })
}
