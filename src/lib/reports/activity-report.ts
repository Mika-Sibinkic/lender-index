/**
 * Activity report — one row per thing the system did, in the same spreadsheet
 * shape as the funding-source report so the team already knows how to read it.
 *
 * This is the export half of the Activity page. The page answers "what
 * happened"; this file answers "here it is, attached to my email, with the
 * exact input" — which is the only form of bug report we can actually act on.
 * Before activity_log, a report arrived as "the search was wrong yesterday" and
 * there was nothing on the server to check it against.
 *
 * Two columns carry the weight. `Details` is the raw payload: for a search that
 * is the effective criteria the server really ran on, for an import it is the
 * full per-file reconciliation. `Result` is OK/Failed, and it exists because
 * cost_log — the only comparable table we had — is written only after success,
 * so failures were the one thing guaranteed to be missing.
 *
 * Deterministic like the funding-source report: no AI on this path, so it works
 * with the office box offline and cannot contain an invented value.
 */

import * as XLSX from 'xlsx'

export interface ActivityReportRow {
  [column: string]: string | number | null
}

/** An activity_log row as it comes out of Postgres, loosely typed on purpose. */
export type ActivityRow = Record<string, unknown>

/** Internal kinds are snake_case; nobody outside this repo should have to read that. */
const KIND_LABELS: Record<string, string> = {
  search: 'Search',
  import: 'Import',
  parse: 'AI parse',
  record_create: 'Record created',
  record_update: 'Record updated',
  record_delete: 'Record deleted',
  report_export: 'Report export',
}

const text = (v: unknown): string =>
  Array.isArray(v) ? v.filter(Boolean).map(String).join(', ') : v == null ? '' : String(v)

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

/** UTC, spelled out in the column header. A report that silently uses the
 *  server's timezone is worse than one that names the timezone it used. */
const stamp = (v: unknown): string => {
  if (!v) return ''
  const d = new Date(String(v))
  if (Number.isNaN(d.getTime())) return String(v)
  return d.toISOString().slice(0, 19).replace('T', ' ')
}

/** PostgREST returns an embedded row as an object, or as a one-element array
 *  depending on the relationship it infers. Both shapes reach here. */
function embedded(v: unknown): Record<string, unknown> | null {
  const flat = Array.isArray(v) ? v[0] : v
  return flat && typeof flat === 'object' ? (flat as Record<string, unknown>) : null
}

function detailOf(row: ActivityRow): Record<string, unknown> {
  const d = row.detail
  return d && typeof d === 'object' && !Array.isArray(d) ? (d as Record<string, unknown>) : {}
}

/** Excel refuses a cell over 32767 characters — a long import payload would
 *  otherwise make the whole workbook unopenable. Trim, and say it was trimmed. */
function serializeDetail(detail: Record<string, unknown>): string {
  if (Object.keys(detail).length === 0) return ''
  let s: string
  try {
    s = JSON.stringify(detail)
  } catch {
    return '(detail could not be serialized)'
  }
  return s.length > 32000 ? `${s.slice(0, 32000)}… (truncated)` : s
}

/**
 * Column order follows how someone reads a problem report: when, who, what,
 * did it work — then the specifics of the two kinds that produce most of the
 * volume (search and import), then the raw payload for us.
 */
export function toActivityRow(row: ActivityRow): ActivityReportRow {
  const d = detailOf(row)
  const user = embedded(row.user)
  const source = embedded(row.funding_source)
  const kind = text(row.kind)
  const failed = row.ok === false
  return {
    'Time (UTC)': stamp(row.occurred_at),
    User: text(user?.email),
    Action: KIND_LABELS[kind] ?? kind,
    Summary: text(row.summary),
    Result: failed ? 'Failed' : 'OK',
    Error: text(row.error),
    'Search Query': text(d.q),
    'Results Returned': num(d.resultCount),
    File: text(d.file),
    'Rows In File': num(d.rowsInSheet),
    'Rows Imported': num(d.upserted),
    'Rows Skipped': num(d.rowsSkipped),
    'Duration (s)': d.totalMs == null ? null : Math.round(Number(d.totalMs) / 100) / 10,
    'Funding Source': text(source?.company_name),
    Details: serializeDetail(d),
  }
}

export const ACTIVITY_COLUMNS: readonly string[] = Object.keys(toActivityRow({}))

/** Build the workbook. One sheet, frozen header, widths sized to the content. */
export function buildWorkbook(rows: ActivityReportRow[]): XLSX.WorkBook {
  const sheet = XLSX.utils.json_to_sheet(rows, { header: [...ACTIVITY_COLUMNS] })
  sheet['!freeze'] = { xSplit: 0, ySplit: 1 }
  // Autofilter so they can pull out just the failures, or just one person's
  // searches, without asking us to run a query.
  if (rows.length > 0) {
    sheet['!autofilter'] = {
      ref: XLSX.utils.encode_range({
        s: { c: 0, r: 0 },
        e: { c: ACTIVITY_COLUMNS.length - 1, r: rows.length },
      }),
    }
  }
  sheet['!cols'] = ACTIVITY_COLUMNS.map((col) => {
    const widest = rows.reduce(
      (max, r) => Math.max(max, String(r[col] ?? '').length),
      col.length,
    )
    return { wch: Math.min(Math.max(widest + 2, 10), 60) }
  })
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, sheet, 'Activity')
  return wb
}

export function toCsv(rows: ActivityReportRow[]): string {
  const sheet = XLSX.utils.json_to_sheet(rows, { header: [...ACTIVITY_COLUMNS] })
  return XLSX.utils.sheet_to_csv(sheet)
}

export function toXlsxBuffer(rows: ActivityReportRow[]): Buffer {
  return XLSX.write(buildWorkbook(rows), { type: 'buffer', bookType: 'xlsx' }) as Buffer
}
