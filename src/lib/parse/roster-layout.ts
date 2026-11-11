/**
 * Render a stored record back into the roster spreadsheet layout.
 *
 * Shared by scripts/export-roster-csv.ts (the backup file) and the side-by-side
 * sheet in scripts/sync-from-sheets.ts. One definition, so a change to how a
 * value is written back cannot land in the backup and miss the review file — the
 * same reason the audit reuses the importer's parser rather than restating it.
 *
 * Nothing here reads a workbook's DATA. `readHeaderRow` takes the header row and
 * nothing else, so the layout is learned from the roster file while the values
 * come entirely from the database.
 */

import * as XLSX from 'xlsx'
import { ASSET_SUBTYPES } from '@/lib/config/domain'

/** Database label → the code the roster sheets use. */
export const LENDER_CODE: Record<string, string> = {
  Bank: 'B',
  'Credit Union': 'C',
  'Non Bank': 'NB',
  'Non-Bank': 'NB',
  'Private Equity': 'PE',
  Lessor: 'L',
}

/** Stored subtype → the text written to the sheet (identity: the sheet uses the labels). */
export const SUBTYPE_CODE: Record<string, string> = Object.fromEntries(ASSET_SUBTYPES.map((s) => [s, s]))

export const INTL_CODE: Record<string, string> = {
  Both: 'I, D',
  International: 'I',
  Domestic: 'D',
}

export const norm = (s: unknown) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim()

/** The header row of the first sheet that has an "Account Name" column. */
export function readHeaderRow(buf: Buffer): { columns: string[]; rowIndex: number; sheet: string } | null {
  const wb = XLSX.read(buf, { type: 'buffer' })
  for (const name of wb.SheetNames) {
    const sh = wb.Sheets[name]
    if (!sh) continue
    const grid = XLSX.utils.sheet_to_json<unknown[]>(sh, { header: 1, raw: false, blankrows: true })
    for (let i = 0; i < Math.min(10, grid.length); i++) {
      // Spread first: a header row with gaps is sparse, and Array.map keeps holes.
      const cells = [...(grid[i] ?? [])].map((c) => String(c ?? ''))
      if (cells.some((c) => norm(c).includes('account name'))) {
        return { columns: cells, rowIndex: i, sheet: name }
      }
    }
  }
  return null
}

export type Contact = { name?: unknown; email?: unknown }

/**
 * What belongs under this spreadsheet column, for this record?
 *
 * `columnIndex` matters: the roster's first column carries the lender-type code and
 * its header is a legend rather than a field name, so position identifies it.
 */
export function cellFor(
  header: string,
  columnIndex: number,
  row: Record<string, unknown>,
  contact: Contact,
): string {
  const h = norm(header)
  const has = (...frags: string[]) => frags.some((f) => h.includes(f))

  if (columnIndex === 0 && !h.includes('account name')) {
    return LENDER_CODE[String(row.lender_type ?? '')] ?? ''
  }
  if (has('(i) international', 'international') || h === 'i/d') {
    return INTL_CODE[String(row.intl_domestic ?? '')] ?? ''
  }
  if (has('operation category')) return String(row.operation_category ?? '')
  if (has('account name')) return String(row.company_name ?? '')
  if (has('main contact')) return String(contact.name ?? '')
  if (has('first name')) return String(contact.name ?? '').split(/\s+/)[0] ?? ''
  if (has('last name')) return String(contact.name ?? '').split(/\s+/).slice(1).join(' ')
  if (has('email')) return String(contact.email ?? '')
  if (has('geographic target')) return ((row.geographic_scope as string[] | null) ?? []).join(', ')
  if (has('specific geographic')) return String(row.specific_geographic ?? '')
  if (has('loan minimum') || has('loan maximum')) {
    const n = Number(has('loan minimum') ? row.deal_size_min_usd : row.deal_size_max_usd)
    if (!Number.isFinite(n) || !n) return ''
    // The header declares its own unit, exactly as the importer reads it.
    return /\bmm\b/.test(h) ? String(n / 1_000_000) : String(n)
  }
  if (has('usage')) return String(row.usage_codes ?? '')
  if (has('asset subtype')) {
    return ((row.asset_subtypes as string[] | null) ?? []).map((t) => SUBTYPE_CODE[t] ?? t).join(', ')
  }
  if (has('asset class')) return ((row.asset_classes as string[] | null) ?? []).join(', ')
  if (has('vintage restriction')) return String(row.vintage_restriction ?? '')
  if (has('lending status')) return String(row.lending_status ?? '')
  if (has('bank paid fee')) return String(row.bank_paid_fee ?? '')
  if (has('notes')) return String(row.internal_notes ?? '')
  return ''
}

/** One spreadsheet row for one record + contact, in the given column order. */
export function renderRow(
  header: string[],
  row: Record<string, unknown>,
  contact: Contact,
): string[] {
  return header.map((h, i) => cellFor(h, i, row, contact))
}
