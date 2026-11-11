import { NextRequest, NextResponse } from 'next/server'
import { requireAuthorizedApiUser } from '@/lib/auth/require-authorized'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { syncIncompleteTag } from '@/lib/funding-sources/incomplete-tag'
import { fundingSourceCreateSchema } from '@/lib/types/funding-source'
import { indexFundingSource, INDEX_PENDING_WARNING } from '@/lib/embeddings'
import { indexGraphForFundingSource } from '@/lib/graph/index-funding-source'
import { isDuplicateCompanyError } from '@/lib/funding-sources/duplicate'
import { computeRequiredGaps } from '@/lib/funding-sources/required-fields'

export async function POST(req: NextRequest) {
  const authz = await requireAuthorizedApiUser()
  if (!authz.ok) return authz.response
  const { userId } = authz

  const body = await req.json()
  const parseLogId: string | undefined =
    typeof body?.parseLogId === 'string' ? body.parseLogId : undefined
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { parseLogId: _omit, ...record } = body as any
  void _omit

  const parsed = fundingSourceCreateSchema.safeParse(record)
  if (!parsed.success)
    return NextResponse.json(
      { error: parsed.error.flatten() },
      { status: 400 }
    )

  const admin = getSupabaseAdmin()
  const { data: user } = await admin
    .from('users')
    .select('id,role')
    .eq('clerk_user_id', userId)
    .single()
  if (!user || !['admin', 'editor'].includes(user.role)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  // Full-field discipline: record which required core fields are still empty so
  // an "incomplete" lender is flagged (badge), not silently accepted as complete.
  // Server-authoritative — never trust a client-sent gap list.
  const required_field_gaps = computeRequiredGaps(parsed.data as Record<string, unknown>)

  const { data, error } = await admin
    .from('funding_sources')
    .insert({ ...parsed.data, required_field_gaps, created_by: user.id, updated_by: user.id })
    .select()
    .single()
  if (error) {
    // company_name is UNIQUE (0013). A duplicate means the lender already
    // exists — don't 500 with a raw Postgres error. Point the operator at the
    // existing record (its detail page has inline-editable fields) so they can
    // update in place instead of hitting a dead end. AI never auto-merges.
    if (isDuplicateCompanyError(error)) {
      const { data: existing } = await admin
        .from('funding_sources')
        .select('id')
        .ilike('company_name', parsed.data.company_name)
        .maybeSingle()
      return NextResponse.json(
        {
          error: `A lender named "${parsed.data.company_name}" already exists. Open it to edit instead of creating a duplicate.`,
          code: 'duplicate_company',
          existing_id: existing?.id ?? null,
        },
        { status: 409 },
      )
    }
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Await the semantic-index so a failure (e.g. embed backend down) is
  // observable to the caller instead of leaving the row silently
  // unsearchable. indexFundingSource never throws; on failure the save still
  // succeeds and we attach a non-fatal warning to the response.
  const indexResult = await indexFundingSource(admin, data)
  const indexWarning = indexResult.ok ? undefined : INDEX_PENDING_WARNING
  // Fire-and-forget graph re-extract. Search degrades to vec+FTS if this fails.
  void indexGraphForFundingSource(admin, data)

  // "Save incomplete" promised to flag the lender for later. It stored the gap
  // list, which shows as a badge on the card — but it tagged nothing, so the
  // tag row, which is where the team actually filters and scans, could not
  // answer "what still needs finishing".
  await syncIncompleteTag(admin, {
    fundingSourceId: data.id,
    gaps: required_field_gaps,
    userId: user.id,
  })

  // Closed-loop: if this insert traces back to an AI parse, compute the
  // user's corrections diff and link the parse_log to the saved row.
  if (parseLogId) {
    const { data: log } = await admin
      .from('parse_logs')
      .select('parsed_output')
      .eq('id', parseLogId)
      .single()
    if (log) {
      const original = (log.parsed_output ?? {}) as Record<string, unknown>
      const corrections: Record<string, { from: unknown; to: unknown }> = {}
      for (const k of Object.keys(parsed.data)) {
        const before = original[k]
        const after = (parsed.data as Record<string, unknown>)[k]
        if (JSON.stringify(before) !== JSON.stringify(after)) {
          corrections[k] = { from: before ?? null, to: after ?? null }
        }
      }
      // supabase-js resolves with { error } rather than throwing, so a failed
      // link here would silently cost the eval set its corrections signal —
      // the same class of swallowed write that hid the rejected 'spreadsheet'
      // parse_logs inserts (see 0021_audit_integrity.sql). Warn, never throw:
      // the funding source is already saved.
      const { error: linkError } = await admin
        .from('parse_logs')
        .update({
          funding_source_id: data.id,
          corrections,
          saved_at: new Date().toISOString(),
        })
        .eq('id', parseLogId)
      if (linkError)
        console.warn('parse_logs update failed (corrections link):', linkError.message)
    }
  }

  return NextResponse.json(
    indexWarning ? { ...data, warning: indexWarning } : data,
    { status: 201 },
  )
}
