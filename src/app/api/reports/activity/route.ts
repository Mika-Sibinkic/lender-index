/**
 * GET /api/reports/activity?format=xlsx|csv&days=30&kind=search
 *
 * The Activity page as a spreadsheet. Same deal as the funding-source report:
 * deterministic, no AI on the path, works with the AI backend offline.
 *
 * This is the attachment on a bug report. "The search was wrong on Tuesday"
 * cannot be investigated; the same sentence with this file attached can, because
 * the Details column carries the effective criteria the server actually ran on
 * and the per-file import reconciliation, not what anyone remembers doing.
 *
 * Not admin-gated, on purpose — same reasoning as the funding-source report.
 * Authorized users default to `editor`, and the people who hit the problems are
 * the ones who need to be able to send us the evidence.
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireAuthorizedApiUser } from '@/lib/auth/require-authorized'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { toActivityRow, toXlsxBuffer, toCsv } from '@/lib/reports/activity-report'
import type { ActivityKind } from '@/lib/activity/log'

export const runtime = 'nodejs'

const KINDS: readonly ActivityKind[] = [
  'search', 'import', 'parse', 'record_create', 'record_update', 'record_delete', 'report_export',
]

// An unbounded export of a table that grows with every search would eventually
// time out the function and produce a file nobody can open. 30 days covers "what
// happened this month"; ?days= widens it when someone needs further back.
const DEFAULT_DAYS = 30
const MAX_ROWS = 10_000

export async function GET(req: NextRequest) {
  const authz = await requireAuthorizedApiUser()
  if (!authz.ok) return authz.response

  const params = req.nextUrl.searchParams
  const format = params.get('format') === 'csv' ? 'csv' : 'xlsx'
  const daysRaw = Number(params.get('days'))
  const days = Number.isFinite(daysRaw) && daysRaw > 0 ? Math.min(Math.floor(daysRaw), 3650) : DEFAULT_DAYS
  const kindParam = params.get('kind')
  const kind = KINDS.includes(kindParam as ActivityKind) ? (kindParam as ActivityKind) : null

  const admin = getSupabaseAdmin()
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()

  let query = admin
    .from('activity_log')
    .select('occurred_at, kind, summary, detail, ok, error, user:user_id ( email ), funding_source:funding_source_id ( company_name )')
    .gte('occurred_at', since)
    .order('occurred_at', { ascending: false })
    .limit(MAX_ROWS)
  if (kind) query = query.eq('kind', kind)

  const { data: events, error } = await query
  if (error) {
    console.error('report.activity query failed', error)
    return NextResponse.json({ error: 'Could not build the report.' }, { status: 500 })
  }

  const reportRows = (events ?? []).map((e) => toActivityRow(e as Record<string, unknown>))

  // Date in the filename so a folder of these stays sortable and it is obvious
  // which snapshot someone is looking at.
  const stamp = new Date().toISOString().slice(0, 10)
  const scope = kind ? `-${kind}` : ''
  const filename = `Activity${scope}-${stamp}.${format}`

  if (format === 'csv') {
    return new NextResponse(toCsv(reportRows), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store',
      },
    })
  }

  const buf = toXlsxBuffer(reportRows)
  return new NextResponse(new Uint8Array(buf), {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  })
}
