/**
 * Make the database faithfully contain everything the two source spreadsheets say.
 *
 * When the app becomes the system of record, the roster spreadsheets have to be
 * represented in it perfectly first; after that, spreadsheet-side mistakes are
 * fixed in the app.
 *
 * So this is a ONE-TIME reconciliation, not an ongoing sync. The sheet wins on
 * every field it has an opinion about. After it runs, staff edit in the app
 * and the spreadsheets stop being authoritative.
 *
 * WHAT IT WRITES
 *   Every importer-owned field where the sheet has a value and the database
 *   disagrees — whether the database is blank (the audit's LOST) or simply
 *   different (UNEXPLAINED). Plus every additional contact the sheets carry.
 *
 * WHAT IT REFUSES TO TOUCH
 *   1. A field a human deliberately changed in the app. Every in-app edit is in
 *      funding_source_edits; those are listed for confirmation instead of being
 *      silently reverted. Re-run with --include-edited to overwrite them too.
 *   2. A field the sheet leaves blank. A blank is not an instruction to erase.
 *
 * WHAT IT DELIBERATELY DESTROYS
 *   Any asset_classes value derived from lender NOTES rather than from the
 *   sheets is removed by a faithful sync. Re-derive it afterwards if you keep one.
 *
 *   set -a && source .env.local && set +a
 *   pnpm sync:sheets <domestic.xlsx> <international.xlsx>            # preview
 *   pnpm sync:sheets <domestic.xlsx> <international.xlsx> --write    # apply
 */

import * as fs from 'fs'
import * as path from 'path'
import { execFile } from 'child_process'
import ExcelJS from 'exceljs'
import * as XLSX from 'xlsx'
import { createClient } from '@supabase/supabase-js'
import { parseRosterWorkbook, inferInternational, type ParsedFundingRow } from '../src/lib/parse/roster-xlsx'
import { mergeRows } from '../src/lib/parse/roster-persist'
import { readHeaderRow, renderRow } from '../src/lib/parse/roster-layout'

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!URL || !KEY) {
  console.error('Missing Supabase env. Run:  set -a && source .env.local && set +a')
  process.exit(1)
}

const args = process.argv.slice(2)
const WRITE = args.includes('--write')
const INCLUDE_EDITED = args.includes('--include-edited')
const files = args.filter((a) => !a.startsWith('--'))
if (files.length === 0) {
  console.error('Usage: pnpm sync:sheets <domestic.xlsx> [international.xlsx] [--write] [--include-edited]')
  process.exit(1)
}

const db = createClient(URL, KEY, { auth: { autoRefreshToken: false, persistSession: false } })

/** Fields the spreadsheets own. company_name is the match key and is never written. */
const FIELDS: Array<keyof ParsedFundingRow> = [
  'primary_contact_name',
  'primary_contact_email',
  'asset_classes',
  'deal_size_min_usd',
  'deal_size_max_usd',
  'geographic_scope',
  'industry_filters',
  'internal_notes',
  'rate_notes',
  'status',
  'lender_type',
  'intl_domestic',
  'specific_geographic',
  'asset_subtypes',
  'usage_codes',
  'operation_category',
  'vintage_restriction',
  'lending_status',
  'bank_paid_fee',
]

/**
 * Which spreadsheet column(s) feed each field, and is the stored value a COPY of
 * that cell or something DERIVED from it?
 *
 * This matters more than it looks. Several fields are transformed on the way in:
 * asset_classes turns "Construction equipment, Commercial trucks" into
 * construction_equipment/commercial_trucks, geographic_scope is the UNION of two
 * separate columns with "All" dropped. A preview that shows only the
 * parsed result next to a header saying "from spreadsheet" invites the reader to
 * compare it against one cell, find it different, and conclude the tool invented
 * the value. Showing the source column and its raw text makes the transform
 * checkable instead of mysterious.
 */
const SOURCE: Record<string, { cols: string[][]; derived?: string }> = {
  primary_contact_name: { cols: [['main contact'], ['first name'], ['last name']] },
  primary_contact_email: { cols: [['email']] },
  asset_classes: { cols: [['asset classes', 'asset class']], derived: 'labels mapped to asset class ids' },
  asset_subtypes: { cols: [['asset subtypes', 'asset subtype']], derived: 'matched to the subtype pick-list' },
  usage_codes: { cols: [['usage']], derived: 'usage codes normalised' },
  geographic_scope: { cols: [['geographic target'], ['specific geographic']], derived: 'UNION of both columns, "All" dropped' },
  specific_geographic: { cols: [['specific geographic']] },
  deal_size_min_usd: { cols: [['loan minimum']], derived: 'MM header means the cell is in millions' },
  deal_size_max_usd: { cols: [['loan maximum']], derived: 'MM header means the cell is in millions' },
  internal_notes: { cols: [['notes']] },
  lender_type: { cols: [], derived: 'column 1 code: B / C / NB / PE' },
  intl_domestic: { cols: [['(i) international', 'international', 'domestic']], derived: 'I / D codes' },
  operation_category: { cols: [['operation category']], derived: 'Personal / Commercial' },
  vintage_restriction: { cols: [['vintage restriction']] },
  lending_status: { cols: [['lending status']] },
  bank_paid_fee: { cols: [['bank paid fee']] },
  status: { cols: [['lending status']], derived: 'Lending Status = No means dormant' },
}

const isBlank = (v: unknown): boolean =>
  v === null ||
  v === undefined ||
  (typeof v === 'string' && v.trim() === '') ||
  (Array.isArray(v) && v.length === 0)

function same(a: unknown, b: unknown): boolean {
  if (isBlank(a) && isBlank(b)) return true
  if (Array.isArray(a) || Array.isArray(b)) {
    const norm = (x: unknown) =>
      (Array.isArray(x) ? x : x == null ? [] : [x])
        .map((v) => String(v).trim().toLowerCase())
        .filter(Boolean)
        .sort()
        .join('|')
    return norm(a) === norm(b)
  }
  if (typeof a === 'number' || typeof b === 'number') {
    const na = a == null || a === '' ? null : Number(a)
    const nb = b == null || b === '' ? null : Number(b)
    if (na == null || nb == null) return na === nb
    return Number.isFinite(na) && Number.isFinite(nb) && na === nb
  }
  return String(a ?? '').trim().replace(/\s+/g, ' ').toLowerCase() ===
    String(b ?? '').trim().replace(/\s+/g, ' ').toLowerCase()
}

const csvCell = (v: unknown): string => {
  const s = Array.isArray(v) ? v.join('; ') : v == null ? '' : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/**
 * Write the preview as a formatted workbook rather than raw CSV.
 *
 * The CSV carried both values all along, but internal_notes routinely contains
 * commas and line breaks, so Excel's import split those rows across columns and
 * the "before" value stopped lining up with its field. A real .xlsx has no
 * delimiter to misread.
 */
async function writeWorkbook(
  rows: Array<{
    company: string
    field: string
    action: string
    now: unknown
    next: unknown
    column: string
    raw: string
    derived: string
  }>,
  sideBySide: Array<{
    company: string
    header: string[]
    sheet: string[][]
    before: string[]
    after: string[]
  }> = [],
) {
  const show = (v: unknown) =>
    Array.isArray(v) ? v.join(', ') : v === null || v === undefined || v === '' ? '—  (empty)' : String(v)

  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Proposed changes', {
    views: [{ state: 'frozen', ySplit: 1 }], // header stays put while scrolling
  })

  ws.columns = [
    { header: 'Lender', key: 'company', width: 30 },
    { header: 'Field', key: 'field', width: 20 },
    { header: 'What happens', key: 'action', width: 13 },
    { header: 'Currently in the database', key: 'now', width: 40 },
    { header: 'New value', key: 'next', width: 40 },
    { header: 'Read from this sheet column', key: 'column', width: 30 },
    { header: 'Exact text in that cell', key: 'raw', width: 44 },
    { header: 'How the cell becomes the value', key: 'derived', width: 40 },
    // Type anything here to veto a row. Read back on --write, matched on
    // Lender + Field, so a decision made while reviewing is the decision applied.
    { header: 'SKIP? (type x)', key: 'skip', width: 14 },
  ]

  for (const r of rows) {
    ws.addRow({
      company: r.company,
      field: r.field,
      action: r.action,
      now: show(r.now),
      next: show(r.next),
      column: r.column || '—',
      raw: r.raw || '—',
      derived: r.derived || 'copied as-is',
    })
  }

  const FILL: Record<string, string> = {
    CONFLICT: 'FFEDE7F6', // violet — the sheets disagree with themselves
    MERGED: 'FFE0F2F1', // teal — both workbooks, widened rather than picked
    FILL: 'FFE8F5E9', // green — filling a blank, nothing can be lost
    OVERWRITE: 'FFFFF3E0', // amber — replaces a real value, read these
    'HELD BACK': 'FFFFEBEE', // red — a human edit, left alone
    'ADD CONTACT': 'FFE3F2FD', // blue — new person
    'ADD CONTACT (intl rep)': 'FFE1F5FE', // blue — new person, international desk
  }

  ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } }
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF37474F' } }
  ws.getRow(1).alignment = { vertical: 'middle' }
  ws.getRow(1).height = 22

  ws.eachRow((row, i) => {
    row.alignment = { vertical: 'top', wrapText: true }
    row.eachCell((cell) => {
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFCFD8DC' } },
        left: { style: 'thin', color: { argb: 'FFCFD8DC' } },
        bottom: { style: 'thin', color: { argb: 'FFCFD8DC' } },
        right: { style: 'thin', color: { argb: 'FFCFD8DC' } },
      }
    })
    if (i === 1) return
    const action = String(row.getCell('action').value ?? '')
    const argb = FILL[action]
    if (argb) row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb } }
    row.getCell('action').font = { bold: true }
    // An empty "before" is the whole point of FILL — grey it so the eye skips it.
    if (String(row.getCell('now').value ?? '').startsWith('—')) {
      row.getCell('now').font = { color: { argb: 'FF90A4AE' }, italic: true }
    }
    if (String(row.getCell('derived').value ?? '') !== 'copied as-is') {
      row.getCell('derived').font = { italic: true, color: { argb: 'FF6A1B9A' } }
      row.getCell('next').font = { italic: true }
    }
  })

  ws.autoFilter = { from: 'A1', to: { row: 1, column: 9 } }

  // A one-screen summary, so the counts do not live only in the terminal.
  const sum = wb.addWorksheet('Summary')
  sum.columns = [
    { header: 'What happens', key: 'k', width: 22 },
    { header: 'Rows', key: 'n', width: 10 },
    { header: 'Meaning', key: 'm', width: 74 },
  ]
  const meaning: Record<string, string> = {
    FILL: 'The database is blank here and the spreadsheet has a value. Nothing can be lost.',
    OVERWRITE: 'Both have a value and they differ. THESE are the ones worth reading.',
    'HELD BACK': 'Someone changed this in the app on purpose. Left alone unless you pass --include-edited.',
    'ADD CONTACT': 'A person listed on the spreadsheet who is missing from the database entirely.',
    CONFLICT:
      'This lender sits on several spreadsheet rows and they DISAGREE on this field (shown as "a || b"). Nothing is applied — decide which is right and set it in the app, or fix the sheet.',
    MERGED:
      'The lender is on BOTH workbooks and does both kinds of business. Deal sizes widen to the outer range, lists union, and the target becomes Both. Narrowing instead would hide the lender from deals it genuinely does.',
  }
  const counts: Record<string, number> = {}
  for (const r of rows) counts[r.action] = (counts[r.action] ?? 0) + 1
  for (const [k, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    sum.addRow({ k, n, m: meaning[k] ?? '' })
  }
  sum.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } }
  sum.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF37474F' } }
  sum.eachRow((row, i) => {
    row.alignment = { vertical: 'middle', wrapText: true }
    if (i === 1) return
    const argb = FILL[String(row.getCell('k').value ?? '')]
    if (argb) row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb } }
  })

  sum.addRow({})
  sum.addRow({ k: 'READ THIS', n: '', m: 'Some fields are TRANSFORMED on the way in, not copied. "Construction equipment, Commercial trucks" in the sheet becomes construction_equipment/commercial_trucks in asset_classes. geographic_scope is the UNION of the Geographic Target AND Specific Geographic columns, with "All" dropped. So a New value will often not look like the cell it came from — the last three columns show the source column, its exact text, and the transform, so you can check it rather than take it on trust.' })

  // --- Sheet 3: certify the READING, not the proposal ----------------------
  // Reviewing proposals answers "is this change right". It cannot answer "did
  // the parser read the sheet correctly", because the answer is drawn from the
  // same code. That second question is checkable cheaply for one reason: a
  // parser defect is SYSTEMATIC. A column read from the wrong header is read
  // wrong for every lender, never for one. So a couple of rows per column,
  // checked once against the real workbook, certify every row in that column.
  {
    const perField = new Map<string, typeof rows>()
    for (const r of rows) {
      if (r.action === 'ADD CONTACT') continue
      const list = perField.get(r.field) ?? []
      // Prefer an OVERWRITE (a real value being replaced) and one FILL, so the
      // sample covers both the populated and the blank case for each column.
      if (list.length < 2 && !list.some((x) => x.action === r.action)) list.push(r)
      perField.set(r.field, list)
    }
    const sample = [...perField.entries()].flatMap(([, v]) => v)
    if (sample.length) {
      const chk = wb.addWorksheet('Spot-check the reading', { views: [{ state: 'frozen', ySplit: 3 }] })
      chk.columns = [
        { header: 'Field', key: 'field', width: 22 },
        { header: 'Lender — find this one in your sheet', key: 'company', width: 34 },
        { header: 'Open THIS column in your sheet', key: 'column', width: 32 },
        { header: 'I read this exact text from it', key: 'raw', width: 46 },
        { header: 'Which becomes', key: 'next', width: 34 },
        { header: 'By this rule', key: 'derived', width: 34 },
        { header: 'Matches? (type y/n)', key: 'ok', width: 18 },
      ]
      chk.spliceRows(1, 0, [])
      chk.getCell('A1').value =
        'Check each row ONCE against the real workbook. A parser fault is systematic — if the text below matches ' +
        'the cell for this lender, that whole column is being read correctly for every lender. ' +
        String(sample.length) + ' checks certify all ' + String(rows.length) + ' proposed changes.'
      chk.mergeCells('A1:G1')
      chk.getCell('A1').alignment = { wrapText: true, vertical: 'middle' }
      chk.getCell('A1').font = { italic: true, color: { argb: 'FF37474F' } }
      chk.getRow(1).height = 40
      chk.addRow({})
      for (const r of sample) {
        chk.addRow({
          field: r.field,
          company: r.company,
          column: r.column || '(column 1, by position)',
          raw: r.raw || '(blank)',
          next: show(r.next),
          derived: r.derived || 'copied as-is',
          ok: '',
        })
      }
      const head = chk.getRow(3)
      head.values = ['Field', 'Lender — find this one in your sheet', 'Open THIS column in your sheet', 'I read this exact text from it', 'Which becomes', 'By this rule', 'Matches? (type y/n)']
      head.font = { bold: true, color: { argb: 'FFFFFFFF' } }
      head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF37474F' } }
      head.alignment = { vertical: 'middle', wrapText: true }
      head.height = 30
      chk.eachRow((row, i) => {
        if (i < 4) return
        row.alignment = { vertical: 'top', wrapText: true }
        row.getCell('ok').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFDE7' } }
        row.eachCell((cell) => {
          cell.border = { bottom: { style: 'thin', color: { argb: 'FFCFD8DC' } } }
        })
      })
    }
  }

  // --- Sheet 4: the spreadsheet, the record, and the proposal, in THEIR order
  if (sideBySide.length) {
    const sbs = wb.addWorksheet('Side by side (their layout)', {
      views: [{ state: 'frozen', xSplit: 2, ySplit: 1 }],
    })
    const header = sideBySide[0].header
    const shortHeader = (h: string, i: number) =>
      (String(h).split(/\s{2,}|\n/)[0] || `Column ${i + 1}`).trim()
    sbs.columns = [
      { header: 'Lender', key: 'company', width: 26 },
      { header: 'Row', key: 'which', width: 13 },
      ...header.map((h, i) => ({
        header: shortHeader(h, i),
        key: `c${i}`,
        width: Math.min(32, Math.max(12, shortHeader(h, i).length + 4)),
      })),
    ]

    for (const rec of sideBySide) {
      const mk = (company: string, which: string, cells: string[]) => {
        const o: Record<string, unknown> = { company, which }
        cells.forEach((c, i) => (o[`c${i}`] = c))
        return o
      }
      // Ground truth first, so the block reads top-down: what the sheet says,
      // what the database holds, what it would become.
      for (const sr of rec.sheet) {
        const rs = sbs.addRow(mk(rec.company, 'SPREADSHEET', sr))
        rs.getCell('which').font = { bold: true, color: { argb: 'FF0D47A1' } }
        rs.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF5F5F5' } }
      }
      const rBefore = sbs.addRow(mk(rec.company, 'Database now', rec.before))
      const rAfter = sbs.addRow(mk(rec.company, 'After sync', rec.after))
      rBefore.getCell('which').font = { bold: true, color: { argb: 'FF616161' } }
      rAfter.getCell('which').font = { bold: true, color: { argb: 'FF1B5E20' } }
      rec.before.forEach((b, i) => {
        if (b === rec.after[i]) return
        for (const [row, argb] of [
          [rBefore, 'FFFFF3E0'],
          [rAfter, 'FFC8E6C9'],
        ] as Array<[ExcelJS.Row, string]>) {
          row.getCell(`c${i}`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb } }
          row.getCell(`c${i}`).font = { bold: true }
        }
      })
      for (const row of [rBefore, rAfter]) {
        row.alignment = { vertical: 'top', wrapText: true }
      }
      sbs.addRow({}).height = 6
    }

    sbs.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } }
    sbs.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF37474F' } }
    sbs.getRow(1).alignment = { vertical: 'middle', wrapText: true }
    sbs.getRow(1).height = 30
    sbs.autoFilter = { from: 'A1', to: { row: 1, column: 2 } }
  }

  await wb.xlsx.writeFile('sync-preview.xlsx')
  console.log('')
  console.log('  wrote sync-preview.xlsx — colour-coded, filterable, opening it now')
  execFile('open', ['sync-preview.xlsx'], () => {})
}

/**
 * A lender on BOTH workbooks is one lender doing both kinds of business.
 *
 * It is merged into one record that accepts both Domestic AND International
 * deals. So for an ACROSS-SHEETS disagreement the answer is to WIDEN, not to
 * pick a side — a lender doing $1MM-$35MM domestically and $3MM-$20MM
 * internationally is served to a broker as $1MM-$35MM with intl_domestic = Both.
 *
 * Widening is also the safer error. Taking the intersection would hide the
 * lender from a $1.5MM domestic deal it genuinely does — a wrong EXCLUSION, and
 * "no wrong lender ever" runs in both directions (see geo-detail-2026-09-09).
 * The cost of widening is that a broker occasionally calls about a deal one desk
 * will not take; the cost of narrowing is a deal never placed.
 *
 * Only fields whose merge is UNAMBIGUOUS are resolved here. Anything requiring
 * judgement — a vintage limit, a notes cell, a lending status — stays a conflict
 * for a human, because guessing those is how a tool quietly invents policy.
 */
function mergeAcrossSheets(field: string, values: unknown[]): { value: unknown; rule: string } | null {
  const present = values.filter((v) => v !== null && v !== undefined && v !== '')
  if (present.length < 2) return null

  if (field === 'intl_domestic') {
    return { value: 'Both', rule: 'on both workbooks → Both' }
  }
  if (field === 'deal_size_min_usd') {
    const n = present.map(Number).filter(Number.isFinite)
    if (!n.length) return null
    return { value: Math.min(...n), rule: 'widest range: lowest minimum' }
  }
  if (field === 'deal_size_max_usd') {
    const n = present.map(Number).filter(Number.isFinite)
    if (!n.length) return null
    return { value: Math.max(...n), rule: 'widest range: highest maximum' }
  }
  if (['asset_classes', 'asset_subtypes', 'geographic_scope', 'industry_filters'].includes(field)) {
    const out: string[] = []
    for (const v of present) {
      for (const item of Array.isArray(v) ? v : [v]) {
        const t = String(item).trim()
        if (t && !out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t)
      }
    }
    return { value: out, rule: 'union of both desks' }
  }
  return null
}

async function main() {
  const sheetRows: ParsedFundingRow[] = []
  // Keep the UNPARSED rows too, keyed by company, so the preview can quote the
  // literal cell a value came from rather than only the parser's output.
  const rawByCompany = new Map<string, Array<Record<string, unknown>>>()
  let layout: string[] | null = null
  for (const f of files) {
    if (!fs.existsSync(f)) {
      console.error(`No such file: ${f}`)
      process.exit(1)
    }
    const buf = fs.readFileSync(f)
    sheetRows.push(
      ...parseRosterWorkbook(buf, { isInternational: inferInternational(path.basename(f)) }).rows,
    )
    if (!layout) layout = readHeaderRow(buf)?.columns ?? null
    const wb = XLSX.read(buf, { type: 'buffer' })
    for (const name of wb.SheetNames) {
      const sh = wb.Sheets[name]
      if (!sh) continue
      const grid = XLSX.utils.sheet_to_json<unknown[]>(sh, { header: 1, raw: false, blankrows: true })
      for (let i = 0; i < Math.min(10, grid.length); i++) {
        const cells = [...(grid[i] ?? [])].map((c) => String(c ?? ''))
        if (!cells.some((c) => c.toLowerCase().includes('account name'))) continue
        const objs = XLSX.utils.sheet_to_json<Record<string, unknown>>(sh, { raw: false, defval: null, range: i })
        for (const o of objs) {
          const nameKey = Object.keys(o).find((k) => k.toLowerCase().replace(/\s+/g, ' ').includes('account name'))
          const co = String((nameKey ? o[nameKey] : '') ?? '').trim()
          if (!co) continue
          if (!rawByCompany.has(co)) rawByCompany.set(co, [])
          // Remember WHICH workbook this row came from. A lender on both sheets
          // with different terms is two programmes, not a typo, and the fix is
          // completely different from a disagreement inside one sheet.
          rawByCompany.get(co)!.push({ ...o, __file: inferInternational(path.basename(f)) ? 'INTL' : 'DOM' })
        }
        break
      }
    }
  }

  /** The literal text in the column(s) this field is read from. */
  const rawCellsFor = (company: string, field: string): { column: string; text: string } => {
    const src = SOURCE[field]
    if (!src) return { column: '', text: '' }
    if (!src.cols.length) {
      // lender_type is read by POSITION, not by header, so it has no fragment to
      // resolve. Showing "(blank)" for it made a correct proposal look invented —
      // Mizar Credit Leasing's sheet row plainly reads "B". Read column 1 directly.
      const rows = rawByCompany.get(company) ?? []
      const vals: string[] = []
      for (const r of rows) {
        const first = Object.keys(r).filter((k) => k !== '__file')[0]
        const v = String((first ? r[first] : '') ?? '').trim()
        if (v && !vals.includes(v)) vals.push(v)
      }
      return { column: '(column 1, by position)', text: vals.length ? vals.join('  ||  ') : '(blank)' }
    }
    const rows = rawByCompany.get(company) ?? []
    const cols: string[] = []
    const texts: string[] = []
    for (const frags of src.cols) {
      let col = ''
      const vals: string[] = []
      for (const r of rows) {
        const k = Object.keys(r).find((key) => {
          if (key === '__file') return false
          const n = key.toLowerCase().replace(/\s+/g, ' ').trim()
          return n !== '' && frags.some((f) => n.includes(f))
        })
        if (!k) continue
        col = k.replace(/\s+/g, ' ').trim()
        const v = String(r[k] ?? '').trim()
        if (v && !vals.includes(v)) vals.push(v)
      }
      if (col) cols.push(col.length > 28 ? col.slice(0, 28) + '…' : col)
      texts.push(vals.length ? vals.join('  ||  ') : '(blank)')
    }
    return { column: cols.join('  +  '), text: texts.join('   ‖   ') }
  }

  const byCompany = new Map<string, ParsedFundingRow[]>()
  for (const r of sheetRows) {
    const list = byCompany.get(r.company_name)
    if (list) list.push(r)
    else byCompany.set(r.company_name, [r])
  }

  const { data, error } = await db.from('funding_sources').select('*')
  if (error) throw new Error(error.message)
  const dbByName = new Map<string, Record<string, unknown>>()
  for (const r of (data ?? []) as Array<Record<string, unknown>>) {
    dbByName.set(String(r.company_name), r)
  }

  const { data: editRows } = await db.from('funding_source_edits').select('funding_source_id,field_name')
  const editedFields = new Set(
    ((editRows ?? []) as Array<Record<string, unknown>>).map((e) => `${e.funding_source_id}|${e.field_name}`),
  )

  const prov = (company: string, field: string) => {
    const { column, text } = rawCellsFor(company, field)
    return { column, raw: text, derived: SOURCE[field]?.derived ?? '' }
  }

  // A reviewer's SKIP marks, read back out of the workbook they reviewed in.
  const skips = new Set<string>()
  if (WRITE && fs.existsSync('sync-preview.xlsx')) {
    try {
      const rb = new ExcelJS.Workbook()
      await rb.xlsx.readFile('sync-preview.xlsx')
      const sheet = rb.getWorksheet('Proposed changes')
      if (sheet) {
        let skipCol = 0
        sheet.getRow(1).eachCell((cell, col) => {
          if (String(cell.value ?? '').trim().toLowerCase().startsWith('skip')) skipCol = col
        })
        if (skipCol) {
          sheet.eachRow((row, i) => {
            if (i === 1) return
            const mark = String(row.getCell(skipCol).value ?? '').trim()
            if (!mark) return
            skips.add(`${String(row.getCell(1).value ?? '')}|${String(row.getCell(2).value ?? '')}`)
          })
        }
      }
    } catch {
      console.warn('  could not read SKIP marks from sync-preview.xlsx — continuing with none')
    }
  }

  const plan: Array<{ id: string; company: string; patch: Record<string, unknown>; fields: string[] }> = []
  const heldBack: Array<[string, string]> = []
  const skipped: Array<[string, string]> = []
  const conflicts: Array<[string, string, string]> = []
  type PreviewRow = {
    company: string
    field: string
    action: string
    now: unknown
    next: unknown
    column: string
    raw: string
    derived: string
  }
  const preview: PreviewRow[] = []
  let fieldCount = 0
  let notesTouched = 0

  for (const [company, list] of byCompany) {
    const row = dbByName.get(company)
    if (!row) continue
    const sheet = mergeRows(list) as unknown as Record<string, unknown>
    const patch: Record<string, unknown> = {}
    const fields: string[] = []
    for (const f of FIELDS) {
      const sv = sheet[f as string]
      const dv = row[f as string]
      if (isBlank(sv)) continue // a blank cell is not an instruction to erase
      if (same(sv, dv)) continue
      // The sheets are contact-level and the index is company-level. If the
      // stored contact is ALREADY one of this company's contacts on the sheet,
      // it is represented faithfully and the only thing an overwrite would do is
      // swap one real person for another because of sheet row order. Leave it,
      // and let the contacts table carry the rest.
      if (
        (f === 'primary_contact_name' || f === 'primary_contact_email') &&
        list.some((alt) => same((alt as unknown as Record<string, unknown>)[f as string], dv))
      ) {
        continue
      }
      // The sheets carry a company on several rows. When those rows DISAGREE on a
      // field, mergeRows keeps row 1 — which quietly picks a winner in someone
      // else's data conflict. Bellatrix Capital reads "Yes || No" for Lending Status
      // across its rows; proposing `active` from that is a coin toss wearing a
      // suit. Surface it and let a human settle it.
      const rawText = prov(company, f as string).raw
      if (rawText.includes('  ||  ')) {
        // Which kind of disagreement is this?
        const rowsFor = rawByCompany.get(company) ?? []
        const files = new Set(rowsFor.map((r) => String(r.__file ?? '')))
        const acrossSheets = files.size > 1
        // Values as each workbook's row parses them, so the merge operates on
        // parsed values rather than on raw cell text.
        const perFile = [...files].map((tag) => {
          const subset = list.filter((_, i) => String(rowsFor[i]?.__file ?? '') === tag)
          const merged = subset.length ? (mergeRows(subset) as unknown as Record<string, unknown>) : null
          return merged ? merged[f as string] : null
        })
        const resolved = acrossSheets ? mergeAcrossSheets(f as string, perFile) : null
        if (resolved && !same(resolved.value, dv)) {
          patch[f as string] = resolved.value
          fields.push(f as string)
          preview.push({
            company,
            field: f as string,
            action: 'MERGED',
            now: dv,
            next: resolved.value,
            ...prov(company, f as string),
            derived: `both workbooks — ${resolved.rule}`,
          })
          fieldCount++
          continue
        }
        if (resolved && same(resolved.value, dv)) continue // already correct
        const kind = acrossSheets ? 'ACROSS SHEETS' : 'WITHIN ONE SHEET'
        conflicts.push([company, `${f as string}  [${kind}]`, rawText])
        preview.push({
          company,
          field: f as string,
          action: 'CONFLICT',
          now: dv,
          next: sv,
          ...prov(company, f as string),
        })
        continue
      }
      if (!INCLUDE_EDITED && editedFields.has(`${row.id}|${f as string}`)) {
        heldBack.push([company, f as string])
        preview.push({ company, field: f as string, action: 'HELD BACK', now: dv, next: sv, ...prov(company, f as string) })
        continue
      }
      if (skips.has(`${company}|${f as string}`)) {
        skipped.push([company, f as string])
        continue
      }
      patch[f as string] = sv
      fields.push(f as string)
      preview.push({
        company,
        field: f as string,
        action: isBlank(dv) ? 'FILL' : 'OVERWRITE',
        now: dv,
        next: sv,
        ...prov(company, f as string),
      })
      fieldCount++
      if (f === 'internal_notes') notesTouched++
    }
    // The primary contact is stored on the lender row, not in the contacts
    // table, so it needs the same marker — a lender whose primary contact is
    // also its international rep is exactly that case.
    {
      const rawRows = rawByCompany.get(company) ?? []
      const primaryKeys = [
        String(row.primary_contact_name ?? '').toLowerCase().trim(),
        String(row.primary_contact_email ?? '').toLowerCase().trim(),
      ].filter(Boolean)
      const primaryIsIntl =
        primaryKeys.length > 0 &&
        rawRows.some(
          (raw) =>
            String(raw.__file ?? '') === 'INTL' &&
            Object.entries(raw).some(
              ([k, v]) => k !== '__file' && primaryKeys.includes(String(v ?? '').toLowerCase().trim()),
            ),
        )
      if (primaryIsIntl && row.primary_contact_is_international !== true) {
        patch.primary_contact_is_international = true
        fields.push('primary_contact_is_international')
        preview.push({
          company,
          field: 'primary_contact_is_international',
          action: 'MERGED',
          now: false,
          next: true,
          column: '(which workbook this contact appears on)',
          raw: 'international-roster.xlsx',
          derived: 'primary contact sits on the international desk',
        })
        fieldCount++
      }
    }

    if (fields.length) {
      // Notes feed note_signals; a signal quoting a sentence no longer in the
      // record keeps reordering the shortlist off text nobody can see.
      if (fields.includes('internal_notes')) patch.note_signals = null
      plan.push({ id: String(row.id), company, patch, fields })
    }
  }

  // Additional contacts the sheets carry beyond each company's primary.
  const { data: existingContacts } = await db.from('funding_source_contacts').select('funding_source_id,name,email')
  const have = new Set(
    ((existingContacts ?? []) as Array<Record<string, unknown>>).map(
      (c) => `${c.funding_source_id}|${String(c.email ?? c.name ?? '').toLowerCase().trim()}`,
    ),
  )
  const contactRows: Array<Record<string, unknown>> = []
  for (const [company, list] of byCompany) {
    const row = dbByName.get(company)
    if (!row || list.length < 2) continue
    const merged = mergeRows(list) as unknown as Record<string, unknown>
    // Only the contact that will actually BE the primary after this run is
    // excluded. Excluding the pre-sync primary as well is how an earlier version
    // of this script silently destroyed real contacts: overwritten in the row,
    // and skipped here because they looked "already seen".
    const keeps = list.some((alt) => same(alt.primary_contact_name, row.primary_contact_name))
    const primary = keeps ? row : merged
    // Key on BOTH name and email. Keying on email-or-name alone meant a primary
    // matched by NAME was not recognised when the row carried an email, and the
    // same person was then inserted again as an "additional" contact.
    const keysOf = (name: unknown, email: unknown) =>
      [String(name ?? '').toLowerCase().trim(), String(email ?? '').toLowerCase().trim()].filter(Boolean)
    const seen = new Set<string>(keysOf(primary.primary_contact_name, primary.primary_contact_email))
    for (const r of list) {
      const keys = keysOf(r.primary_contact_name, r.primary_contact_email)
      if (!keys.length) continue
      if (keys.some((k) => seen.has(k) || have.has(`${row.id}|${k}`))) continue
      for (const k of keys) seen.add(k)
      // Which desk does this person sit on? The workbooks are already split
      // Domestic / International, so their file of origin states it — nobody has
      // to classify anyone. Sparse by design: only the international ones carry
      // a mark: only the odd ones out.
      const intlRep = (rawByCompany.get(company) ?? []).some(
        (raw) =>
          String(raw.__file ?? '') === 'INTL' &&
          keysOf(r.primary_contact_name, r.primary_contact_email).some((k) =>
            Object.entries(raw).some(
              ([key, v]) => key !== '__file' && String(v ?? '').toLowerCase().trim() === k,
            ),
          ),
      )
      contactRows.push({
        funding_source_id: row.id,
        name: r.primary_contact_name ?? null,
        email: r.primary_contact_email ?? null,
        is_international: intlRep,
      })
      preview.push({
        company,
        field: 'additional contact',
        action: 'ADD CONTACT',
        now: '',
        next: r.primary_contact_name ?? r.primary_contact_email,
        column: 'Main Contact',
        raw: String(r.primary_contact_name ?? r.primary_contact_email ?? ''),
        derived: '',
      })
    }
  }

  // Put the SOURCE OF TRUTH in the review file. Checking one lender meant
  // Cmd+F across three workbooks; the literal spreadsheet row now sits directly
  // above the current record and the proposed one, in the same column order.
  const sideBySide: Array<{
    company: string
    header: string[]
    sheet: string[][]
    before: string[]
    after: string[]
  }> = []
  if (layout) {
    const cols = layout
    const keyOf = (h: string) => h.toLowerCase().replace(/\s+/g, ' ').trim()
    for (const { company, patch } of plan) {
      const row = dbByName.get(company)
      if (!row) continue
      const contact = { name: row.primary_contact_name, email: row.primary_contact_email }
      const afterRow = { ...row, ...patch }
      sideBySide.push({
        company,
        header: cols,
        sheet: (rawByCompany.get(company) ?? []).map((raw) => {
          const byKey = new Map(Object.keys(raw).map((k) => [keyOf(k), k]))
          return cols.map((h) => {
            const k = byKey.get(keyOf(h))
            return k && k !== '__file' ? String(raw[k] ?? '').trim() : ''
          })
        }),
        before: renderRow(cols, row, contact),
        after: renderRow(cols, afterRow, {
          name: afterRow.primary_contact_name,
          email: afterRow.primary_contact_email,
        }),
      })
    }
  }

  await writeWorkbook(preview, sideBySide)

  console.log(WRITE ? 'SYNC — WRITING' : 'SYNC — PREVIEW ONLY (add --write to apply)')
  console.log('')
  console.log(`  lenders to update:          ${plan.length}`)
  console.log(`  field values to write:      ${fieldCount}`)
  console.log(`  of those, internal_notes:   ${notesTouched}  (note_signals cleared; re-extract after)`)
  console.log(`  additional contacts to add: ${contactRows.length}`)
  console.log(`  held back (edited in app):  ${heldBack.length}${heldBack.length ? '   <-- see below' : ''}`)
  if (skipped.length) console.log(`  skipped by your SKIP marks:  ${skipped.length}`)
  if (conflicts.length) {
    const across = conflicts.filter(([, f]) => f.includes('ACROSS SHEETS')).length
    const within = conflicts.length - across
    console.log(`  CONFLICTS (sheet rows disagree): ${conflicts.length}   <-- not applied`)
    console.log(`    ${across} ACROSS SHEETS    — the lender is on BOTH workbooks with different terms.`)
    console.log('                        Likely two programmes, not an error. A user decides which the database holds.')
    console.log(`    ${within} WITHIN ONE SHEET — the same workbook contradicts itself, or the column is`)
    console.log('                        per-contact rather than per-lender. Fix at source.')
    for (const [co, f, raw] of conflicts.slice(0, 12)) {
      console.log(`    ${co}  ${f}:  ${raw}`)
    }
    if (conflicts.length > 12) console.log(`    ... and ${conflicts.length - 12} more`)
  }
  if (heldBack.length) {
    console.log('')
    console.log('  These were changed by a person in the app, on purpose. The sheet')
    console.log('  disagrees. Left alone — pass --include-edited to overwrite them too:')
    for (const [co, f] of heldBack) console.log(`    ${co}  —  ${f}`)
  }
  console.log('')
  console.log('  every proposed value is in sync-preview.xlsx — review before --write')

  if (!WRITE) {
    console.log('')
    console.log('  no changes made.')
    return
  }

  // ---- rollback snapshot, written BEFORE the first update --------------
  // Every field this run is about to change, with the value it holds right now.
  // Nothing about this run is irreversible while this file exists.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const rollbackFile = `sync-rollback-${stamp}.json`
  const snapshot = plan.map(({ id, company, patch, fields }) => {
    const row = dbByName.get(company) ?? {}
    const previous: Record<string, unknown> = {}
    for (const f of fields) previous[f] = row[f] ?? null
    // note_signals is cleared as a side effect of rewriting notes; capture it too.
    if ('note_signals' in patch) previous.note_signals = row.note_signals ?? null
    return { id, company, previous }
  })
  fs.writeFileSync(rollbackFile, JSON.stringify({ takenAt: new Date().toISOString(), rows: snapshot }, null, 2))
  console.log('')
  console.log(`  rollback snapshot written: ${rollbackFile}`)
  console.log(`    undo with:  pnpm tsx scripts/restore-rollback.ts ${rollbackFile} --write`)

  let written = 0
  const touched: string[] = []
  for (const { id, company, patch, fields } of plan) {
    const { error: uErr } = await db.from('funding_sources').update(patch).eq('id', id)
    if (uErr) {
      console.warn(`  ${company}: ${uErr.message}`)
      continue
    }
    written += fields.length
    touched.push(company)
  }

  let contactsAdded = 0
  if (contactRows.length) {
    const { error: cErr } = await db.from('funding_source_contacts').insert(contactRows)
    if (cErr) console.warn(`  contacts: ${cErr.message}`)
    else contactsAdded = contactRows.length
  }

  console.log('')
  console.log(`  wrote ${written} field value(s) across ${touched.length} lender(s)`)
  console.log(`  added ${contactsAdded} contact(s)`)
  console.log('')
  console.log('  NOW RUN, IN THIS ORDER:')
  console.log('    1. pnpm tsx scripts/extract-note-signals.ts                       # refills note signals')
  console.log('    2. re-embed the changed lenders so search sees the new text')
  console.log('    3. pnpm audit:import <same two files>                             # confirm it is clean')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
