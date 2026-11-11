/**
 * Funding-source report — the whole index, one row per lender, one column per field.
 *
 * The need: see a report of all funding sources in a spreadsheet fashion, column
 * by column, so a user can see which records need updating. Sortable
 * by state, deal size and the rest. And it is not a one-off — reports must be
 * runnable whenever, on a regular basis.
 *
 * Two design choices follow from that:
 *
 * 1. The columns use the roster template vocabulary (Account Name, Loan
 *    Minimum, Asset Subtypes…), taken from required-fields.ts, not our internal
 *    column names. This is the spreadsheet a team runs the business on; a
 *    report they have to translate is not a report they will use.
 *
 * 2. It is completely deterministic. No AI, no inference, no summarising — just
 *    their data in a grid. So it works with the AI backend offline, it is instant,
 *    and there is nothing in it that could be a hallucinated number. The accuracy
 *    mandate is satisfied by construction rather than by review.
 *
 * "Missing Required Fields" is the column that answers "what needs updating" —
 * it lists, per lender, exactly which template fields are still blank.
 */

import * as XLSX from 'xlsx'
import { requiredFieldsFor, isFieldFilled } from '@/lib/funding-sources/required-fields'

/** Required template fields still blank on this record, as human labels. */
function missingRequiredLabels(row: Record<string, unknown>): string[] {
  return requiredFieldsFor(row)
    .filter((f) => !isFieldFilled(row[f.key]))
    .map((f) => f.label)
}

export interface ReportRow {
  [column: string]: string | number | null
}

/** A lender row as it comes out of Postgres, loosely typed on purpose. */
export type SourceRow = Record<string, unknown>

const list = (v: unknown): string =>
  Array.isArray(v) ? v.filter(Boolean).map(String).join(', ') : v == null ? '' : String(v)

const money = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

const date = (v: unknown): string => {
  if (!v) return ''
  const s = String(v)
  // Already ISO from Postgres; keep the date part only — nobody sorts by seconds.
  return s.slice(0, 10)
}

/**
 * Column order mirrors the roster template: who they are, how to reach them,
 * what they lend on, where, how much, then the housekeeping columns that drive
 * "which of these need updating".
 */
export function toReportRow(src: SourceRow, tags: string[]): ReportRow {
  const gaps = missingRequiredLabels(src as Record<string, unknown>)
  return {
    'Account Name': list(src.company_name),
    Type: list(src.lender_type),
    'Lending Status': list(src.lending_status),
    Status: list(src.status),
    'Main Contact': list(src.primary_contact_name),
    Title: list(src.primary_contact_title),
    Email: list(src.primary_contact_email),
    Phone: list(src.primary_contact_phone),
    'Geographic Target': list(src.intl_domestic),
    'Specific Geography': list(src.geographic_scope),
    'Geography Detail': list(src.specific_geographic),
    'Loan Minimum': money(src.deal_size_min_usd),
    'Loan Maximum': money(src.deal_size_max_usd),
    'Asset Subtypes': list(src.asset_subtypes),
    'Asset Classes': list(src.asset_classes),
    Usage: list(src.usage_codes),
    'Operation Category': list(src.operation_category),
    'Vintage Restriction': list(src.vintage_restriction),
    'Bank Paid Fee': list(src.bank_paid_fee),
    Tags: tags.join(', '),
    'Last Contact': date(src.last_contact_at),
    'Outreach Status': list(src.outreach_status),
    'Missing Required Fields': gaps.join(', '),
    'Missing Count': gaps.length,
    Notes: list(src.internal_notes),
    'Rate Notes': list(src.rate_notes),
    'Last Updated': date(src.updated_at),
  }
}

export const REPORT_COLUMNS: readonly string[] = Object.keys(
  toReportRow({}, []),
)

/** Build the workbook. One sheet, frozen header, widths sized to the content. */
export function buildWorkbook(rows: ReportRow[]): XLSX.WorkBook {
  const sheet = XLSX.utils.json_to_sheet(rows, { header: [...REPORT_COLUMNS] })
  sheet['!freeze'] = { xSplit: 0, ySplit: 1 }
  // Excel shows an autofilter row so they can sort by state, deal size, anything.
  if (rows.length > 0) {
    sheet['!autofilter'] = {
      ref: XLSX.utils.encode_range({
        s: { c: 0, r: 0 },
        e: { c: REPORT_COLUMNS.length - 1, r: rows.length },
      }),
    }
  }
  sheet['!cols'] = REPORT_COLUMNS.map((col) => {
    const widest = rows.reduce(
      (max, r) => Math.max(max, String(r[col] ?? '').length),
      col.length,
    )
    return { wch: Math.min(Math.max(widest + 2, 10), 60) }
  })
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, sheet, 'Funding Sources')
  return wb
}

export function toCsv(rows: ReportRow[]): string {
  const sheet = XLSX.utils.json_to_sheet(rows, { header: [...REPORT_COLUMNS] })
  return XLSX.utils.sheet_to_csv(sheet)
}

export function toXlsxBuffer(rows: ReportRow[]): Buffer {
  return XLSX.write(buildWorkbook(rows), { type: 'buffer', bookType: 'xlsx' }) as Buffer
}
