/**
 * Roster spreadsheet parser — shared by the CLI importer
 * (scripts/import-roster-xlsx.ts) and the drag-drop import API route
 * (/api/import/funding-sources).
 *
 * Maps a roster workbook (e.g. one file for domestic and one for international
 * lenders) to funding_sources rows + data-derived tags. Pure functions;
 * no DB access — the caller does the upsert.
 */

import * as XLSX from 'xlsx'
import {
  ASSET_CATEGORIES,
  ASSET_SUBTYPES,
  OPERATION_CATEGORIES,
  USAGE_CODES,
} from '@/lib/config/domain'

export interface ParsedFundingRow {
  company_name: string
  primary_contact_name: string | null
  primary_contact_email: string | null
  asset_classes: string[]
  deal_size_min_usd: number | null
  deal_size_max_usd: number | null
  geographic_scope: string[]
  industry_filters: string[]
  internal_notes: string
  rate_notes: string | null
  status: 'active' | 'dormant'
  // Spreadsheet template fields (migration 0017) — mapped to their own columns
  // so the card shows real structured data, not crammed notes.
  lender_type: string | null
  intl_domestic: string | null
  specific_geographic: string | null
  asset_subtypes: string[]
  usage_codes: string | null
  operation_category: string | null
  vintage_restriction: string | null
  lending_status: string | null
  bank_paid_fee: string | null
}

export interface ParsedTag {
  company_name: string
  tag: string
}

export interface SkippedRow {
  /** 1-based row number in the sheet as a human sees it, header included. */
  sheetRow: number
  reason: string
}

/**
 * What the importer did with the file, in enough detail to reconcile it against
 * the source by hand.
 *
 * This exists because an earlier importer turned two sheets into noticeably
 * fewer lenders than they had rows, and NOTHING recorded it: no log, no
 * counter, no table, no line in the response. The UI printed the row count
 * AFTER rows were discarded and read as success. An import you cannot
 * reconcile is an import you cannot trust, however good the mapping is.
 */
export interface ImportReport {
  sheetNames: string[]
  sheetsRead: string[]
  /** Rows the spreadsheet actually contained, before any filtering. */
  inputRows: number
  /** Rows that became a ParsedFundingRow. */
  parsedRows: number
  headerRowIndex: number
  headerColumns: string[]
  /** Header → the field it fed. */
  mapped: Array<{ column: string; field: string }>
  /** Columns present in the file that nothing reads. */
  unmapped: string[]
  skipped: SkippedRow[]
  warnings: string[]
}

export interface ParseResult {
  rows: ParsedFundingRow[]
  tags: ParsedTag[]
  report: ImportReport
}

/**
 * Banking-notation loan amounts. M = thousand, MM = million.
 *   "$500M" -> 500_000   "$10MM" -> 10_000_000
 *
 * `columnIsMillions` says the COLUMN header declares its unit — e.g. the
 * template's "Loan Minimum MM" / "Loan Maximum MM". In that case a bare `5` means
 * five million, not five dollars. Without this the header's unit was decorative:
 * scale came only from a suffix a user had to retype in every cell, so one
 * row saying `5` and the next saying `5MM` differed by a factor of a million
 * inside the same column, silently. An explicit suffix still wins, because a
 * cell that states its own unit is not ambiguous.
 */
export function parseLoanAmount(raw: unknown, columnIsMillions = false): number | null {
  if (raw == null) return null
  const s = String(raw).trim().toUpperCase().replace(/[$,\s]/g, '')
  if (!s) return null
  let m = s.match(/^([\d.]+)MM$/)
  if (m) return Math.round(parseFloat(m[1]) * 1_000_000)
  m = s.match(/^([\d.]+)M$/)
  if (m) return Math.round(parseFloat(m[1]) * 1_000)
  m = s.match(/^([\d.]+)K$/)
  if (m) return Math.round(parseFloat(m[1]) * 1_000)
  m = s.match(/^([\d.]+)B$/)
  if (m) return Math.round(parseFloat(m[1]) * 1_000_000_000)
  const n = Number(s)
  if (!Number.isFinite(n)) return null
  return Math.round(columnIsMillions ? n * 1_000_000 : n)
}

const lc = (s: string) => s.trim().toLowerCase()
const tokens = (raw: unknown, sep: RegExp): string[] =>
  String(raw ?? '').split(sep).map(lc).filter(Boolean)

/**
 * "Asset Classes" cell → config ids (src/lib/config/vocabulary.ts). A token may be
 * the stored id ("construction_equipment") or the label ("Construction
 * equipment"). Unknown tokens are dropped: asset_classes drives matching.
 */
export function parseAssetClasses(raw: unknown): string[] {
  if (!raw) return []
  const out = new Set<string>()
  for (const t of tokens(raw, /[,\/;]/)) {
    const c = ASSET_CATEGORIES.find(
      (a) => a.id === t.replace(/[\s-]+/g, '_') || lc(a.label) === t,
    )
    if (c) out.add(c.id)
  }
  return [...out]
}

/** "Usage" cell → usage codes from config, matched by code, label or keyword. */
export function parseUsage(raw: unknown): string[] {
  if (!raw) return []
  const out = new Set<string>()
  for (const t of tokens(raw, /[,\/;]/)) {
    const u = USAGE_CODES.find(
      (x) => x.code === t || lc(x.label) === t || x.keywords.includes(t),
    )
    if (u) out.add(u.code)
  }
  return USAGE_CODES.map((u) => u.code).filter((c) => out.has(c))
}

const LENDER_TYPE: Record<string, { tag: string; label: string }> = {
  B: { tag: 'bank', label: 'Bank' },
  C: { tag: 'credit-union', label: 'Credit Union' },
  NB: { tag: 'non-bank', label: 'Non-Bank' },
  PE: { tag: 'private-equity', label: 'Private Equity' },
  L: { tag: 'lessor', label: 'Lessor' },
  OTHER: { tag: 'other-lender', label: 'Other' },
}

// Canonical lender_type labels for the structured column (match ai-extract +
// migration 0017). Unknown code → null (accuracy-first: never guess).
const LENDER_TYPE_CANON: Record<string, string> = {
  B: 'Bank',
  C: 'Credit Union',
  NB: 'Non Bank',
  PE: 'Private Equity',
}

// Display pick-list for the asset_subtypes column (separate from asset_classes,
// which drives search matching). Case-insensitive, canonical spelling kept.
export function parseAssetSubtypes(raw: unknown): string[] {
  if (!raw) return []
  const out: string[] = []
  for (const t of tokens(raw, /[,\/]/)) {
    const label = ASSET_SUBTYPES.find((s) => lc(s) === t)
    if (label && !out.includes(label)) out.push(label)
  }
  return out
}

/** "(I) International (D) Domestic" code → canonical label. */
export function parseIntlDomestic(raw: unknown): string | null {
  if (!raw) return null
  const codes = new Set(
    String(raw)
      .toUpperCase()
      .split(/[,\/\s]+/)
      .map((t) => t.trim())
      .filter(Boolean),
  )
  const i = codes.has('I') || codes.has('INTERNATIONAL')
  const d = codes.has('D') || codes.has('DOMESTIC')
  if (i && d) return 'Both'
  if (i) return 'International'
  if (d) return 'Domestic'
  return null
}

/**
 * "Operation Category" cell → a stored OPERATION_CATEGORIES value. Tokens match
 * a value or label; more than one base category maps to the combined value.
 */
export function parseOperationCategory(raw: unknown): string | null {
  if (!raw) return null
  const match = (t: string) => OPERATION_CATEGORIES.find((o) => lc(o.value) === t || lc(o.label) === t)
  const whole = match(lc(String(raw)))
  if (whole) return whole.value
  const hit = new Set(tokens(raw, /[,\/;&]/).flatMap((t) => match(t)?.value.split(', ') ?? []))
  if (hit.size === 0) return null
  const combined = OPERATION_CATEGORIES.find(
    (o) => o.value.split(', ').length === hit.size && o.value.split(', ').every((v) => hit.has(v)),
  )
  return combined?.value ?? [...hit].join(', ')
}

/** Normalize a Usage cell ("owner,lease" / "Owner-operated; Rental fleet") to "owner, lease". */
export function normalizeUsageText(raw: unknown): string | null {
  const codes = parseUsage(raw)
  return codes.length ? codes.join(', ') : null
}

/**
 * The place list, from the column that holds places.
 *
 * Geographic Target should be US or International; Specific Geography should
 * be states or countries. Target is the CATEGORY and Specific Geography is the
 * place list. The category is already stored in intl_domestic, so unioning
 * Target into the place list duplicated it: a row reading
 * `D | US | IL, WI, IA, MO,KY, IN, MI` produced ["US","IL",…], a redundant US.
 *
 * So Specific wins when it names anything. Target is a FALLBACK, not a
 * supplement — in a real roster many rows have no Specific cell at all, and
 * dropping Target outright would leave them with no geography, which reads as
 * UNKNOWN and keeps a domestic-only lender on a foreign deal.
 */
export function parseGeo(target: unknown, specific: unknown): string[] {
  const tokens = (src: unknown): string[] => {
    if (!src) return []
    return String(src)
      .split(/[,;]/)
      .map((t) => t.trim())
      .filter((t) => t && t.toLowerCase() !== 'all')
  }
  // Only the CATEGORY words are dropped from Target — they are what
  // intl_domestic already stores. A real place there is still a real place:
  // "US, Canada" must keep Canada, or a lender loses a country it serves.
  const CATEGORY = /^(us|u\.s\.|usa|united states|domestic|international|intl)$/i
  const fromSpecific = tokens(specific)
  const targetTokens = tokens(target)
  const combined = [...new Set([...fromSpecific, ...targetTokens.filter((t) => !CATEGORY.test(t))])]
  // Dropping the category must never empty the list: rows with no Specific
  // cell are common, and an empty geography reads as UNKNOWN, which keeps a
  // domestic-only lender on a foreign deal.
  return combined.length > 0 ? combined : [...new Set(targetTokens)]
}

function makeResolver(keys: string[]) {
  // Normalize internal whitespace so a fragment like 'geographic target'
  // matches a header written 'Geographic  Target' (double space / trailing
  // space are common in real roster sheets).
  // Tolerate a non-string key. A blank cell in the header row used to arrive
  // here as undefined and crash the whole import on .toLowerCase().
  const norm = (s: unknown) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim()
  return (...frags: string[]) =>
    keys.find((k) => norm(k) !== '' && frags.some((f) => norm(k).includes(norm(f))))
}

/**
 * Parse one workbook (Buffer or already-read XLSX.WorkBook) into rows +
 * tags. `isInternational` toggles the domestic/international tag and is
 * usually inferred from the filename by the caller.
 */
export function parseRosterWorkbook(
  input: Buffer | ArrayBuffer | XLSX.WorkBook,
  opts: { isInternational: boolean },
): ParseResult {
  // Duck-type: a WorkBook has SheetNames; a Buffer/ArrayBuffer doesn't.
  const isWorkBook =
    typeof input === 'object' &&
    input !== null &&
    Array.isArray((input as XLSX.WorkBook).SheetNames)
  const wb = isWorkBook ? (input as XLSX.WorkBook) : XLSX.read(input, { type: 'buffer' })

  const warnings: string[] = []
  const skipped: SkippedRow[] = []
  const rows: ParsedFundingRow[] = []
  const tags: ParsedTag[] = []

  // Read EVERY sheet that looks like a funding-source table, not just the first.
  // `wb.Sheets[wb.SheetNames[0]]` meant a workbook with a second tab imported
  // tab one and discarded the rest without a word.
  const sheetsRead: string[] = []
  let raw: Record<string, unknown>[] = []
  let headerRowIndex = 0
  let headerColumns: string[] = []

  for (const name of wb.SheetNames) {
    const sh = wb.Sheets[name]
    if (!sh) continue
    const found = readSheetWithHeader(sh)
    if (!found) {
      if (wb.SheetNames.length === 1) {
        warnings.push(
          `Sheet "${name}" has no "Account Name" column — nothing was imported from it.`,
        )
      }
      continue
    }
    sheetsRead.push(name)
    if (headerColumns.length === 0) {
      headerRowIndex = found.headerRowIndex
      headerColumns = found.columns
    }
    raw = raw.concat(found.rows)
  }

  if (sheetsRead.length === 0) {
    warnings.push(
      'No sheet in this file has an "Account Name" column. Check that the header row is ' +
        'the first row — a title or a blank line above it hides every column.',
    )
  }
  if (wb.SheetNames.length > sheetsRead.length && sheetsRead.length > 0) {
    const ignored = wb.SheetNames.filter((n) => !sheetsRead.includes(n))
    warnings.push(`Ignored ${ignored.length} sheet(s) with no Account Name column: ${ignored.join(', ')}.`)
  }

  const inputRows = raw.length
  let sheetRow = headerRowIndex + 1

  for (const r of raw) {
    sheetRow += 1
    const keys = Object.keys(r)
    const find = makeResolver(keys)
    const get = (...frags: string[]): unknown => {
      const k = find(...frags)
      return k ? r[k] : null
    }

    const company = String(get('account name') ?? '').trim()
    if (!company) {
      // Counted, not vanished. Spacer rows and section separators are normal and
      // harmless; a hundred of them is a symptom. Either way the operator now
      // sees the number instead of a summary that only counts survivors.
      const hasAnyValue = Object.values(r).some((v) => String(v ?? '').trim() !== '')
      skipped.push({
        sheetRow,
        reason: hasAnyValue ? 'no Account Name (row has other values)' : 'blank row',
      })
      continue
    }

    const typeCode = String((keys[0] ? r[keys[0]] : '') ?? '').trim().toUpperCase()
    const lenderType = LENDER_TYPE[typeCode] ?? LENDER_TYPE.OTHER

    let contactName = String(get('main contact') ?? '').trim()
    if (!contactName) {
      const first = String(get('first name') ?? '').trim()
      const last = String(get('last name') ?? '').trim()
      contactName = [first, last].filter(Boolean).join(' ')
    }

    const email = String(get('email') ?? '').trim() || null
    const assetClasses = parseAssetClasses(get(...COLUMN_FRAGMENTS.asset_classes))
    const assetSubtypes = parseAssetSubtypes(get(...COLUMN_FRAGMENTS.asset_subtypes))
    const usageCell = get(...COLUMN_FRAGMENTS.usage_codes)
    const operationCell = get(...COLUMN_FRAGMENTS.operation_category)

    // "Loan Minimum MM" declares its own unit: a bare 5 in that column is five
    // million. An explicit suffix in the cell still wins.
    const minKey = find('loan minimum')
    const maxKey = find('loan maximum')
    const dealMin = parseLoanAmount(get('loan minimum'), /\bmm\b/i.test(minKey ?? ''))
    const dealMax = parseLoanAmount(get('loan maximum'), /\bmm\b/i.test(maxKey ?? ''))
    const specificGeo = String(get('specific geographic') ?? '').trim() || null
    const geo = parseGeo(get('geographic target'), specificGeo)

    const lendingStatusRaw = String(get('lending status') ?? '').trim()
    const status: 'active' | 'dormant' =
      lendingStatusRaw.toLowerCase() === 'no' ? 'dormant' : 'active'

    const vintage = String(get('vintage restriction') ?? '').trim() || null
    const bankFee = String(get('bank paid fee') ?? '').trim() || null
    const notes = String(get('notes') ?? '').trim()

    rows.push({
      company_name: company,
      primary_contact_name: contactName || null,
      primary_contact_email: email,
      asset_classes: assetClasses,
      deal_size_min_usd: dealMin,
      deal_size_max_usd: dealMax,
      geographic_scope: geo,
      // No roster column carries borrower industries; edit them per lender.
      industry_filters: [],
      // Structured columns now carry lender_type / vintage / fee, so notes hold
      // only the spreadsheet's Notes cell (no more crammed prefix).
      internal_notes: notes,
      rate_notes: null,
      status,
      lender_type: LENDER_TYPE_CANON[typeCode] ?? null,
      intl_domestic: parseIntlDomestic(get('(i) international', 'international', 'domestic')),
      specific_geographic: specificGeo,
      asset_subtypes: assetSubtypes,
      usage_codes: normalizeUsageText(usageCell),
      operation_category: parseOperationCategory(operationCell),
      vintage_restriction: vintage,
      lending_status: lendingStatusRaw || null,
      bank_paid_fee: bankFee,
    })

    tags.push({ company_name: company, tag: lenderType.tag })
    tags.push({ company_name: company, tag: opts.isInternational ? 'international' : 'domestic' })
    if (!email) tags.push({ company_name: company, tag: 'bad-contact' })
    if (status === 'dormant') tags.push({ company_name: company, tag: 'stale' })
  }

  // Which of the file's columns did anything read?
  const mapped: Array<{ column: string; field: string }> = []
  for (const [field, frags] of Object.entries(COLUMN_FRAGMENTS)) {
    const col = makeResolver(headerColumns)(...frags)
    if (col) mapped.push({ column: col, field })
  }
  if (headerColumns.length > 0) mapped.push({ column: headerColumns[0], field: 'lender_type (by position)' })
  const usedColumns = new Set(mapped.map((m) => m.column))
  const unmapped = headerColumns.filter((c) => !usedColumns.has(c) && c.trim() !== '')
  if (unmapped.length) {
    warnings.push(`${unmapped.length} column(s) in this file are not read by the importer: ${unmapped.join(' | ')}`)
  }
  if (inputRows > 0 && rows.length === 0) {
    warnings.push(
      `Read ${inputRows} row(s) but produced none. This almost always means the header row was ` +
        'not found where expected.',
    )
  }

  return {
    rows,
    tags,
    report: {
      sheetNames: wb.SheetNames,
      sheetsRead,
      inputRows,
      parsedRows: rows.length,
      headerRowIndex,
      headerColumns,
      mapped,
      unmapped,
      skipped,
      warnings,
    },
  }
}

/**
 * Every lookup the row mapper performs, so the report can say which column fed
 * which field — and, just as importantly, which columns nothing read. A sheet
 * that grows a "Bank Paid Fee" or a "Secondary Email" column should announce
 * itself, not be silently ignored.
 */
const COLUMN_FRAGMENTS: Record<string, string[]> = {
  company_name: ['account name'],
  primary_contact_name: ['main contact'],
  'primary_contact_name (fallback)': ['first name'],
  'primary_contact_name (fallback2)': ['last name'],
  primary_contact_email: ['email'],
  deal_size_min_usd: ['loan minimum'],
  deal_size_max_usd: ['loan maximum'],
  intl_domestic: ['(i) international', 'international', 'domestic'],
  geographic_scope: ['geographic target'],
  specific_geographic: ['specific geographic'],
  asset_classes: ['asset classes', 'asset class'],
  asset_subtypes: ['asset subtypes', 'asset subtype'],
  usage_codes: ['usage'],
  operation_category: ['operation category'],
  vintage_restriction: ['vintage restriction'],
  lending_status: ['lending status'],
  bank_paid_fee: ['bank paid fee'],
  internal_notes: ['notes'],
}

/**
 * Find the header row and read from there.
 *
 * `sheet_to_json` takes its headers from the first row of the used range. A
 * title line, a merged banner, or one blank line above the headers therefore
 * turned every column name into `__EMPTY`, every lookup missed, every row was
 * skipped for having no Account Name — and the importer reported SUCCESS with
 * zero rows. Verified by execution on 2026-09-08 for both XLSX and CSV.
 *
 * So: scan the first few rows for the one that actually names Account Name.
 */
function readSheetWithHeader(
  sh: XLSX.WorkSheet,
): { rows: Record<string, unknown>[]; headerRowIndex: number; columns: string[] } | null {
  const MAX_SCAN = 10
  const grid = XLSX.utils.sheet_to_json<unknown[]>(sh, { header: 1, raw: false, blankrows: true })
  for (let i = 0; i < Math.min(MAX_SCAN, grid.length); i++) {
    // Spread first: sheet_to_json(header:1) returns a SPARSE array when the
    // header row has gaps, and Array.map PRESERVES holes (it skips them rather
    // than filling them). Spreading densifies, so every index is a real string.
    const cells = [...(grid[i] ?? [])].map((c) => String(c ?? '').toLowerCase().replace(/\s+/g, ' ').trim())
    if (!cells.some((c) => c.includes('account name'))) continue
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sh, {
      raw: false,
      defval: null,
      range: i,
    })
    const columns = [...(grid[i] ?? [])].map((c) => String(c ?? ''))
    return { rows, headerRowIndex: i, columns }
  }
  return null
}

/** Tag color palette for the data-derived tags. */
export const ROSTER_TAG_COLORS: Record<string, string> = {
  bank: 'blue',
  'credit-union': 'blue',
  'non-bank': 'violet',
  'private-equity': 'violet',
  lessor: 'slate',
  'other-lender': 'slate',
  international: 'green',
  domestic: 'green',
  'bad-contact': 'red',
  stale: 'amber',
  incomplete: 'amber',
}

/** Heuristic: filename mentions "international" → international file. */
export function inferInternational(filename: string): boolean {
  return /international|intl/i.test(filename)
}
