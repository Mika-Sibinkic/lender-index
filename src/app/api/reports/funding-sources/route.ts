/**
 * GET /api/reports/funding-sources?format=xlsx|csv
 *
 * The whole funding index as a spreadsheet — one row per lender, one column per
 * template field, so staff can see column by column what each lender does and
 * spot the records that need updating. Repeatable: run it whenever, on a
 * regular basis.
 *
 * Deliberately deterministic — no AI anywhere on this path. It works with the
 * AI backend offline, returns in well under a second, and cannot contain an
 * invented value. Excel gets an autofilter row so they can sort by state, deal
 * size or anything else themselves, which is the point of the report.
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireAuthorizedApiUser } from '@/lib/auth/require-authorized'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { toReportRow, toXlsxBuffer, toCsv } from '@/lib/reports/funding-source-report'

export const runtime = 'nodejs'

export async function GET(req: NextRequest) {
  const authz = await requireAuthorizedApiUser()
  if (!authz.ok) return authz.response

  const format = req.nextUrl.searchParams.get('format') === 'csv' ? 'csv' : 'xlsx'
  const admin = getSupabaseAdmin()

  const { data: sources, error } = await admin
    .from('funding_sources')
    .select('*')
    .order('company_name', { ascending: true })
  if (error) {
    console.error('report.funding-sources query failed', error)
    return NextResponse.json({ error: 'Could not build the report.' }, { status: 500 })
  }

  const rows = sources ?? []
  const { data: tagRows } = await admin
    .from('funding_source_tag')
    .select('funding_source_id, tag:tag_id ( name )')
    .in('funding_source_id', rows.map((r) => r.id as string))

  const tagsBySource = new Map<string, string[]>()
  for (const tr of (tagRows ?? []) as unknown as Array<{
    funding_source_id: string
    tag: { name: string } | { name: string }[] | null
  }>) {
    const flat = Array.isArray(tr.tag) ? tr.tag[0] : tr.tag
    if (!flat?.name) continue
    const arr = tagsBySource.get(tr.funding_source_id) ?? []
    arr.push(flat.name)
    tagsBySource.set(tr.funding_source_id, arr)
  }

  const reportRows = rows.map((r) =>
    toReportRow(r as Record<string, unknown>, tagsBySource.get(r.id as string) ?? []),
  )

  // Date in the filename so a folder of these stays sortable and it is obvious
  // which snapshot someone is looking at.
  const stamp = new Date().toISOString().slice(0, 10)
  const filename = `Funding-Sources-${stamp}.${format}`

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
