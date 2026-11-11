/**
 * POST /api/import/funding-sources
 *
 * Drag-drop xlsx import for the AI-powered funding-source search.
 * Accepts multipart/form-data with one or more `files`. Parses each
 * via the shared roster parser, upserts rows + data-derived tags,
 * then re-indexes embeddings + graph so search picks the new data up
 * immediately.
 *
 * Admin-only. Returns a per-file summary.
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireAuthorizedApiUser } from '@/lib/auth/require-authorized'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { parseRosterWorkbook, inferInternational } from '@/lib/parse/roster-xlsx'
import { persistRosterData } from '@/lib/parse/roster-persist'
import { logActivity } from '@/lib/activity/log'

export const maxDuration = 300
export const runtime = 'nodejs'

export async function POST(req: NextRequest) {
  const authz = await requireAuthorizedApiUser()
  if (!authz.ok) return authz.response
  const { userId } = authz

  const admin = getSupabaseAdmin()
  const { data: user } = await admin
    .from('users')
    .select('id, role')
    .eq('clerk_user_id', userId)
    .single()
  if (user?.role !== 'admin') {
    return NextResponse.json({ error: 'admin required' }, { status: 403 })
  }
  const actorId: string | null = user?.id ?? null

  const form = await req.formData()
  const files = form.getAll('files').filter((f): f is File => f instanceof File)
  if (files.length === 0) {
    return NextResponse.json({ error: 'no files' }, { status: 400 })
  }

  // The response carries the full reconciliation, not just the survivors.
  // "rows" used to be the count AFTER discards, so a file where most rows were
  // dropped reported a smaller number and read as success.
  const results: Array<Record<string, unknown>> = []

  // Same reconciliation, written down instead of only returned. It used to live
  // for exactly as long as the tab that triggered the import: by the time anyone
  // said "the spreadsheet lost rows", the only record of which rows and why was
  // gone. One activity_log row per file, so the answer survives the tab.
  const record = async (r: Record<string, unknown>) => {
    const skipped = Number(r.rowsSkipped ?? 0)
    const summary = r.error
      ? `Import failed for ${String(r.file)}: ${String(r.error)}`
      : `Imported ${String(r.file)}: ${Number(r.rowsInSheet ?? 0)} rows, ` +
        `${Number(r.upserted ?? 0)} upserted, ${skipped} skipped`
    await logActivity(admin, {
      kind: 'import',
      summary,
      detail: r,
      userId: actorId,
      // Not just "did it throw". A file where parsed + skipped does not equal
      // the sheet lost rows silently, and that is a failed import even though
      // every step returned.
      ok: !r.error && r.reconciles === true,
      error: r.error ? String(r.error) : r.reconciles === false ? 'rows did not reconcile' : null,
    })
  }

  for (const file of files) {
    if (file.size > 25 * 1024 * 1024) {
      const tooBig = { file: file.name, rowsInSheet: 0, rowsParsed: 0, upserted: 0, error: 'file too large (25MB max)' }
      results.push(tooBig)
      await record(tooBig)
      continue
    }
    try {
      const buf = Buffer.from(await file.arrayBuffer())
      const { rows, tags, report } = parseRosterWorkbook(buf, {
        isInternational: inferInternational(file.name),
      })
      const summary = await persistRosterData(admin, rows, tags, { reindex: true })
      const result = {
        file: file.name,
        sheetsInFile: report.sheetNames,
        sheetsRead: report.sheetsRead,
        headerRow: report.headerRowIndex + 1,
        rowsInSheet: report.inputRows,
        rowsParsed: report.parsedRows,
        rowsSkipped: report.skipped.length,
        skipped: report.skipped.slice(0, 50),
        unmappedColumns: report.unmapped,
        mergedCompanies: summary.merged,
        contactsKept: summary.contactsKept,
        blanksIgnored: summary.blanksIgnored,
        upserted: summary.upserted,
        tagLinks: summary.tagLinks,
        reindexed: summary.reindexed,
        warnings: report.warnings,
        // Every input row is accounted for: parsed + skipped must equal the sheet.
        reconciles: report.parsedRows + report.skipped.length === report.inputRows,
      }
      results.push(result)
      await record(result)
    } catch (e) {
      const failed = {
        file: file.name,
        rowsInSheet: 0,
        rowsParsed: 0,
        upserted: 0,
        error: e instanceof Error ? e.message : 'parse failed',
      }
      results.push(failed)
      await record(failed)
    }
  }

  return NextResponse.json({ results })
}
