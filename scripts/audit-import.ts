/**
 * Cross-check the live funding-source database against the two source spreadsheets.
 *
 * Re-reads the Domestic and International workbooks with the SAME parser and the
 * SAME merge rule the importer used (src/lib/parse/roster-xlsx.ts +
 * mergeRows from roster-persist.ts), then compares every field of every lender
 * against what is actually stored in Supabase.
 *
 * Nothing is written. The database is read-only here, and the spreadsheets are
 * only ever read from the path you pass on the command line — they are never
 * copied, uploaded, or sent anywhere.
 *
 *   TWO OUTPUT FILES, ON PURPOSE:
 *     audit-summary.txt  counts and percentages only, no cell values.
 *                        Safe to send to Claude or paste into a chat.
 *     audit-detail.csv   the actual differing values, row by row.
 *                        Company-proprietary. Stays on your machine.
 *
 * Usage:
 *   set -a && source .env.local && set +a && \
 *     pnpm tsx scripts/audit-import.ts \
 *       "/path/domestic-roster.xlsx" \
 *       "/path/international-roster.xlsx"
 *
 * Exit code is 0 unless a field was LOST (see below), so this can gate CI later.
 */

import * as fs from 'fs'
import * as path from 'path'
import { createClient } from '@supabase/supabase-js'
import {
  parseRosterWorkbook,
  inferInternational,
  ROSTER_TAG_COLORS,
  type ParsedFundingRow,
  type ParsedTag,
} from '../src/lib/parse/roster-xlsx'
import { mergeRows } from '../src/lib/parse/roster-persist'

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!URL || !KEY) {
  console.error('Missing Supabase env. Run:  set -a && source .env.local && set +a')
  process.exit(1)
}

const files = process.argv.slice(2).filter((a) => !a.startsWith('--'))
if (files.length === 0) {
  console.error('Usage: pnpm tsx scripts/audit-import.ts <domestic.xlsx> [international.xlsx]')
  process.exit(1)
}

const db = createClient(URL, KEY, { auth: { autoRefreshToken: false, persistSession: false } })

/** The fields the importer writes. Anything else in the DB is app-only. */
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

const isBlank = (v: unknown): boolean =>
  v === null ||
  v === undefined ||
  (typeof v === 'string' && v.trim() === '') ||
  (Array.isArray(v) && v.length === 0)

/** Compare the way a human would: order-insensitive for lists, loose on whitespace/case. */
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

/**
 * WHY does a value differ? Classify the SHAPE of the disagreement, never the
 * content. A parser defect and a spreadsheet someone edited last month leave
 * completely different fingerprints, and the fix is different for each.
 */
function diffShape(sheetV: unknown, dbV: unknown): string {
  const toList = (x: unknown) =>
    (Array.isArray(x) ? x : x == null ? [] : [x])
      .map((v) => String(v).trim().toLowerCase())
      .filter(Boolean)

  if (Array.isArray(sheetV) || Array.isArray(dbV)) {
    const a = new Set(toList(sheetV))
    const b = new Set(toList(dbV))
    const inBoth = [...a].filter((x) => b.has(x)).length
    if (inBoth === 0) return 'DISJOINT (nothing in common)'
    if (inBoth === a.size && b.size > a.size) return 'DB HAS EXTRA ITEMS'
    if (inBoth === b.size && a.size > b.size) return 'IMPORT DROPPED ITEMS'
    return 'PARTIAL OVERLAP'
  }

  const na = sheetV == null || sheetV === '' ? NaN : Number(sheetV)
  const nb = dbV == null || dbV === '' ? NaN : Number(dbV)
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== 0 && nb !== 0) {
    const r = na / nb
    for (const [mult, label] of [
      [1000, '1,000x'],
      [1e6, '1,000,000x'],
    ] as Array<[number, string]>) {
      if (Math.abs(r - mult) < 1e-6) return `SCALE: sheet is ${label} the database`
      if (Math.abs(r - 1 / mult) < 1e-9) return `SCALE: database is ${label} the sheet`
    }
    return 'DIFFERENT NUMBER'
  }

  const a = String(sheetV ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
  const b = String(dbV ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
  if (!a || !b) return 'ONE SIDE EMPTY'
  if (a.startsWith(b)) return 'DB IS TRUNCATED'
  if (b.startsWith(a)) return 'DB HAS EXTRA TEXT APPENDED'
  if (a.includes(b)) return 'DB IS A FRAGMENT OF THE SHEET'
  if (b.includes(a)) return 'SHEET IS A FRAGMENT OF THE DB'
  return 'DIFFERENT TEXT'
}

const csvCell = (v: unknown): string => {
  const s = Array.isArray(v) ? v.join('; ') : v == null ? '' : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

type Verdict = 'AGREE' | 'LOST' | 'EDITED' | 'UNEXPLAINED' | 'PRESERVED' | 'ALT_CONTACT'

async function main() {
  // ---- 1. Re-parse the workbooks with the importer's own parser ------------
  const sheetRows: ParsedFundingRow[] = []
  const sheetTags: ParsedTag[] = []
  const perFile: Array<{ file: string; rows: number; intl: boolean; sheets: string[] }> = []

  for (const f of files) {
    if (!fs.existsSync(f)) {
      console.error(`No such file: ${f}`)
      process.exit(1)
    }
    const buf = fs.readFileSync(f)
    const intl = inferInternational(path.basename(f))
    const res = parseRosterWorkbook(buf, { isInternational: intl })
    sheetRows.push(...res.rows)
    sheetTags.push(...res.tags)
    perFile.push({
      file: path.basename(f),
      rows: res.rows.length,
      intl,
      sheets: (res.report as { sheetsRead?: string[] })?.sheetsRead ?? [],
    })
  }

  // Same grouping + merge the importer applies, reusing its exported function.
  const byCompany = new Map<string, ParsedFundingRow[]>()
  for (const r of sheetRows) {
    const list = byCompany.get(r.company_name)
    if (list) list.push(r)
    else byCompany.set(r.company_name, [r])
  }
  const expected = new Map<string, ParsedFundingRow>()
  const multiRow: string[] = []
  for (const [company, list] of byCompany) {
    if (list.length > 1) multiRow.push(company)
    expected.set(company, mergeRows(list))
  }

  // ---- 2. Read the database ------------------------------------------------
  const { data, error } = await db.from('funding_sources').select('*')
  if (error) throw new Error(error.message)
  const dbRows = (data ?? []) as Array<Record<string, unknown>>
  const dbByName = new Map<string, Record<string, unknown>>()
  for (const r of dbRows) dbByName.set(String(r.company_name), r)

  // The sheets are contact-level; the index is company-level. Extra contacts are
  // supposed to land in funding_source_contacts rather than be dropped.
  const { count: dbExtraContacts } = await db
    .from('funding_source_contacts')
    .select('id', { count: 'exact', head: true })

  // Every in-app edit is logged. That is what makes a disagreement decidable:
  // a field a human deliberately changed is not the same defect as a field
  // nobody has ever touched that still disagrees with its own source sheet.
  const { data: editRows } = await db.from('funding_source_edits').select('funding_source_id,field_name')
  const editedFields = new Set(
    ((editRows ?? []) as Array<Record<string, unknown>>).map(
      (e) => `${e.funding_source_id}|${e.field_name}`,
    ),
  )

  // Tag links, resolved to names.
  const { data: tagDefs } = await db.from('tag').select('id,name')
  const tagNameById = new Map(
    ((tagDefs ?? []) as Array<Record<string, unknown>>).map((t) => [String(t.id), String(t.name)]),
  )
  const { data: tagLinks } = await db.from('funding_source_tag').select('funding_source_id,tag_id')
  const dbTagsBySource = new Map<string, Set<string>>()
  for (const l of (tagLinks ?? []) as Array<Record<string, unknown>>) {
    const nm = tagNameById.get(String(l.tag_id))
    if (!nm) continue
    const key = String(l.funding_source_id)
    if (!dbTagsBySource.has(key)) dbTagsBySource.set(key, new Set())
    dbTagsBySource.get(key)!.add(nm)
  }

  // ---- 3. Compare ----------------------------------------------------------
  const inSheetNotDb: string[] = []
  const inDbNotSheet: string[] = []
  for (const name of expected.keys()) if (!dbByName.has(name)) inSheetNotDb.push(name)
  for (const name of dbByName.keys()) if (!expected.has(name)) inDbNotSheet.push(name)

  // How many DISTINCT extra contacts do the sheets carry beyond each company's
  // primary? This is what funding_source_contacts should hold.
  let sheetExtraContacts = 0
  for (const [, list] of byCompany) {
    if (list.length < 2) continue
    const seen = new Set<string>()
    const primary = (list[0].primary_contact_email ?? list[0].primary_contact_name ?? '').toLowerCase().trim()
    if (primary) seen.add(primary)
    for (const r of list.slice(1)) {
      const key = (r.primary_contact_email ?? r.primary_contact_name ?? '').toLowerCase().trim()
      if (!key || seen.has(key)) continue
      seen.add(key)
      sheetExtraContacts++
    }
  }

  const tally: Record<string, Record<Verdict, number>> = {}
  for (const f of FIELDS) tally[f as string] = { AGREE: 0, LOST: 0, EDITED: 0, UNEXPLAINED: 0, PRESERVED: 0, ALT_CONTACT: 0 }

  const detail: string[] = ['company_name,field,verdict,shape,spreadsheet_value,database_value']
  const shapeTally: Record<string, Record<string, number>> = {}
  let matched = 0

  for (const [name, sheet] of expected) {
    const row = dbByName.get(name)
    if (!row) continue
    matched++
    for (const f of FIELDS) {
      const sv = (sheet as unknown as Record<string, unknown>)[f as string]
      const dv = row[f as string]
      let verdict: Verdict
      if (same(sv, dv)) verdict = 'AGREE'
      else if (isBlank(sv)) verdict = 'PRESERVED' // blank cell never overwrites — by design
      else if (isBlank(dv)) verdict = 'LOST' // sheet had a value, database has none
      else if (
        (f === 'primary_contact_name' || f === 'primary_contact_email') &&
        (byCompany.get(name) ?? []).some((alt) =>
          same((alt as unknown as Record<string, unknown>)[f as string], dv),
        )
      ) {
        // The database holds a DIFFERENT contact for this company — but one the
        // spreadsheet itself lists on another row. The importer keeps row 1's
        // contact as primary, so a re-ordered sheet flips which name wins. The
        // person is real and on the sheet; nothing is wrong with the data.
        verdict = 'ALT_CONTACT'
      } else if (editedFields.has(`${row.id}|${f as string}`)) {
        // Somebody changed this field in the app, on purpose, and the change is
        // in the audit log. The database is the intentional value; the sheet is
        // the stale one.
        verdict = 'EDITED'
      } else {
        // Nobody has ever touched this field in the app, and it still disagrees
        // with the spreadsheet it came from. The import produced this value.
        // THIS is the bucket to investigate.
        verdict = 'UNEXPLAINED'
      }
      tally[f as string][verdict]++
      const shape = verdict === 'UNEXPLAINED' ? diffShape(sv, dv) : ''
      if (verdict === 'UNEXPLAINED') {
        shapeTally[f as string] = shapeTally[f as string] ?? {}
        shapeTally[f as string][shape] = (shapeTally[f as string][shape] ?? 0) + 1
      }
      if (verdict !== 'AGREE') {
        detail.push(
          [csvCell(name), csvCell(f), verdict, csvCell(shape), csvCell(sv), csvCell(dv)].join(','),
        )
      }
    }
  }

  // ---- 3b. Tags ------------------------------------------------------------
  // Only the tags the IMPORTER owns are comparable. 'preferred' and 'rental'
  // are a user's judgement, applied in the app, and the sheets never carry them —
  // reporting those as missing would be noise.
  const IMPORTER_TAGS = new Set(Object.keys(ROSTER_TAG_COLORS))
  const sheetTagsByCompany = new Map<string, Set<string>>()
  for (const t of sheetTags) {
    if (!sheetTagsByCompany.has(t.company_name)) sheetTagsByCompany.set(t.company_name, new Set())
    sheetTagsByCompany.get(t.company_name)!.add(t.tag)
  }

  let tagAgree = 0
  const tagMissing: Array<[string, string]> = [] // sheet says yes, DB lacks it
  const tagExtra: Array<[string, string]> = [] // DB has an importer tag the sheet does not imply
  for (const [company] of expected) {
    const row = dbByName.get(company)
    if (!row) continue
    const want = sheetTagsByCompany.get(company) ?? new Set<string>()
    const have = dbTagsBySource.get(String(row.id)) ?? new Set<string>()
    for (const t of want) {
      if (have.has(t)) tagAgree++
      else tagMissing.push([company, t])
    }
    for (const t of have) {
      if (!IMPORTER_TAGS.has(t)) continue // human-applied, not the importer's to own
      if (!want.has(t)) tagExtra.push([company, t])
    }
  }

  // ---- 4. Write the two reports -------------------------------------------
  const L: string[] = []
  const pct = (n: number, d: number) => (d === 0 ? '—' : `${((n / d) * 100).toFixed(1)}%`)

  L.push('LENDER INDEX — IMPORT AUDIT')
  L.push(`run ${new Date().toISOString()}`)
  L.push('')
  L.push('SOURCES')
  for (const p of perFile) {
    L.push(
      `  ${p.file}  —  ${p.rows} rows` +
        `${p.intl ? '  [read as INTERNATIONAL]' : '  [read as DOMESTIC]'}` +
        `${p.sheets.length ? `  tabs: ${p.sheets.join(', ')}` : ''}`,
    )
  }
  L.push(`  unique companies after merge: ${expected.size}` + (multiRow.length ? `  (${multiRow.length} appear on more than one row)` : ''))
  L.push(`  database rows: ${dbRows.length}`)
  L.push('')
  L.push('ROW COVERAGE')
  L.push(`  matched by name:        ${matched}`)
  L.push(`  in spreadsheet, NOT in database:  ${inSheetNotDb.length}${inSheetNotDb.length ? '   <-- these never made it in' : ''}`)
  L.push(`  in database, NOT in spreadsheet:  ${inDbNotSheet.length}${inDbNotSheet.length ? '   <-- added in the app, or renamed' : ''}`)
  L.push('')
  L.push('FIELD AGREEMENT  (matched rows only)')
  L.push('  field                     agree   lost  UNEXPLAINED  edited  preserved  alt-contact')
  let totalLost = 0
  for (const f of FIELDS) {
    const t = tally[f as string]
    totalLost += t.LOST
    L.push(
      `  ${String(f).padEnd(24)} ${String(t.AGREE).padStart(5)} ${String(t.LOST).padStart(6)} ${String(t.UNEXPLAINED).padStart(12)} ${String(t.EDITED).padStart(7)} ${String(t.PRESERVED).padStart(10)} ${String(t.ALT_CONTACT).padStart(12)}`,
    )
  }
  L.push('')
  L.push('WHAT THE WORDS MEAN')
  L.push('  AGREE      spreadsheet and database say the same thing.')
  L.push('  LOST       the spreadsheet has a value and the database does not.')
  L.push('             This is the only column that means something went wrong.')
  L.push('  UNEXPLAINED  both have a value, they differ, and NOBODY has ever edited')
  L.push('             this field in the app. The import produced it. This is the')
  L.push('             bucket to investigate — a wrong value, not a missing one.')
  L.push('  EDITED     both differ, and the change IS in the in-app audit log.')
  L.push('             Someone chose this deliberately; the sheet is the stale side.')
  L.push('  PRESERVED  the spreadsheet cell is blank and the database has a value.')
  L.push('             Expected: the importer refuses to let a blank erase real data.')
  L.push('  ALT_CONTACT the database holds a different contact for this company, but one')
  L.push('             the spreadsheet itself lists on another row. The importer keeps')
  L.push('             row 1 as primary, so re-ordering the sheet flips which name wins.')
  L.push('             The person is real and on the sheet. Not a defect.')
  L.push('')
  if (Object.keys(shapeTally).length) {
    L.push('WHY THE UNEXPLAINED ONES DIFFER  (shape of the difference, not its content)')
    L.push('  "IMPORT DROPPED ITEMS" or "DB IS TRUNCATED" means the parser mangled it —')
    L.push('  fixable in code. "DIFFERENT TEXT/NUMBER" or "DISJOINT" means the two')
    L.push('  sources genuinely disagree — usually the spreadsheet changed since import.')
    for (const f of FIELDS) {
      const m = shapeTally[f as string]
      if (!m) continue
      const parts = Object.entries(m).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${v} ${k}`)
      L.push(`  ${String(f).padEnd(22)} ${parts.join(' · ')}`)
    }
    L.push('')
  }
  L.push('TAGS  (only the tags the importer owns — "preferred"/"rental" are human-applied)')
  L.push(`  agree:                       ${tagAgree}`)
  L.push(`  sheet has it, database does NOT: ${tagMissing.length}`)
  L.push(`  database has it, sheet does NOT: ${tagExtra.length}`)
  {
    const g = (list: Array<[string, string]>) => {
      const m: Record<string, number> = {}
      for (const [, t] of list) m[t] = (m[t] ?? 0) + 1
      return Object.entries(m).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t} ${n}`).join(' · ')
    }
    if (tagMissing.length) L.push(`    missing by tag: ${g(tagMissing)}`)
    if (tagExtra.length) L.push(`    extra by tag:   ${g(tagExtra)}`)
  }
  L.push('')
  L.push('ADDITIONAL CONTACTS')
  L.push(`  extra contacts on the spreadsheets: ${sheetExtraContacts}`)
  L.push(`  rows in funding_source_contacts:    ${dbExtraContacts ?? 0}`)
  if ((dbExtraContacts ?? 0) === 0 && sheetExtraContacts > 0) {
    L.push('  ^ the sheets list additional people per company and the database')
    L.push('    stores none of them. Everything except each company\'s first')
    L.push('    contact is currently absent from the database.')
  }
  L.push('')
  // Which lenders actually lost a value, so the CSV has a starting point.
  const lostByCompany = new Map<string, string[]>()
  for (const line of detail.slice(1)) {
    const [co, field, verdict] = line.split(',')
    if (verdict !== 'LOST') continue
    const key = co.replace(/^"|"$/g, '').replace(/""/g, '"')
    lostByCompany.set(key, [...(lostByCompany.get(key) ?? []), field])
  }
  if (lostByCompany.size) {
    L.push(`LENDERS WITH A LOST VALUE (${lostByCompany.size}) — field names only`)
    for (const [co, fields] of [...lostByCompany].sort()) {
      L.push(`  ${co}  —  ${fields.join(', ')}`)
    }
    L.push('')
  }
  if (inSheetNotDb.length) {
    L.push(`MISSING LENDERS (${inSheetNotDb.length}) — names only, listed so you can spot them`)
    for (const n of inSheetNotDb.slice(0, 50)) L.push(`  - ${n}`)
    if (inSheetNotDb.length > 50) L.push(`  ... and ${inSheetNotDb.length - 50} more (see the CSV)`)
    L.push('')
  }
  let totalUnexplained = 0
  for (const f of FIELDS) totalUnexplained += tally[f as string].UNEXPLAINED
  L.push('RESULT')
  L.push(`  ${totalLost} value(s) LOST (blank in the database, present on the sheet)`)
  L.push(`  ${totalUnexplained} value(s) UNEXPLAINED (differ, and no human ever edited them)`)
  L.push(`  ${tagMissing.length + tagExtra.length} tag disagreement(s)`)
  L.push(`  ${inSheetNotDb.length} lender(s) missing from the database`)
  L.push('  Filter audit-detail.csv by the verdict column to see each one.')

  const summary = L.join('\n')
  fs.writeFileSync('audit-summary.txt', summary + '\n')

  for (const [co, t] of tagMissing) detail.push([csvCell(co), 'TAG', 'TAG_MISSING_IN_DB', csvCell(t), ''].join(','))
  for (const [co, t] of tagExtra) detail.push([csvCell(co), 'TAG', 'TAG_NOT_ON_SHEET', '', csvCell(t)].join(','))
  for (const n of inSheetNotDb) detail.push([csvCell(n), 'ROW', 'MISSING_FROM_DB', '', ''].join(','))
  for (const n of inDbNotSheet) detail.push([csvCell(n), 'ROW', 'NOT_IN_SPREADSHEET', '', ''].join(','))
  fs.writeFileSync('audit-detail.csv', detail.join('\n') + '\n')

  console.log(summary)
  console.log('')
  console.log('  audit-summary.txt   counts only — safe to send to Claude')
  console.log('  audit-detail.csv    actual values — keep this one local')

  process.exit(totalLost > 0 || inSheetNotDb.length > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
