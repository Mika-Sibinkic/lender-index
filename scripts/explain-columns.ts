/**
 * Show which spreadsheet COLUMN the importer reads for each field — and where
 * that mapping is ambiguous.
 *
 * The importer resolves columns by SUBSTRING, first match wins:
 *     keys.find((k) => frags.some((f) => norm(k).includes(norm(f))))
 * So a fragment like 'notes' matches the leftmost header containing "notes" —
 * `Rate Notes` and `Credit Notes` are just as good a match as `Notes`. Nothing
 * has ever printed which column actually won, so a wrong mapping produced
 * confident, wrong values with no symptom.
 *
 * This reads HEADERS ONLY. It prints no cell values, so the output is safe to
 * share.
 *
 *   set -a && source .env.local && set +a
 *   pnpm explain:columns "<Domestic ….xlsx>" "<International ….xlsx>"
 */

import * as fs from 'fs'
import * as path from 'path'
import * as XLSX from 'xlsx'

const files = process.argv.slice(2).filter((a) => !a.startsWith('--'))
if (files.length === 0) {
  console.error('Usage: pnpm explain:columns <domestic.xlsx> [international.xlsx]')
  process.exit(1)
}

/** The fragments the importer actually searches for, field by field. */
const FIELD_FRAGMENTS: Array<[string, string[]]> = [
  ['company_name', ['account name']],
  ['primary_contact_name', ['main contact']],
  ['contact first name', ['first name']],
  ['contact last name', ['last name']],
  ['primary_contact_email', ['email']],
  ['geographic_scope', ['geographic target']],
  ['specific_geographic', ['specific geographic']],
  ['deal_size_min_usd', ['loan minimum']],
  ['deal_size_max_usd', ['loan maximum']],
  ['usage_codes', ['usage']],
  ['asset_subtypes', ['asset subtypes', 'asset subtype']],
  ['vintage_restriction', ['vintage restriction']],
  ['lending_status', ['lending status']],
  ['bank_paid_fee', ['bank paid fee']],
  ['internal_notes', ['notes']],
]

const norm = (s: unknown) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim()

function headerRow(file: string): { columns: string[]; rowIndex: number; sheet: string } | null {
  const wb = XLSX.read(fs.readFileSync(file), { type: 'buffer' })
  for (const name of wb.SheetNames) {
    const sh = wb.Sheets[name]
    if (!sh) continue
    const grid = XLSX.utils.sheet_to_json<unknown[]>(sh, { header: 1, raw: false, blankrows: true })
    for (let i = 0; i < Math.min(10, grid.length); i++) {
      const cells = [...(grid[i] ?? [])].map((c) => String(c ?? ''))
      if (cells.some((c) => norm(c).includes('account name'))) {
        return { columns: cells, rowIndex: i, sheet: name }
      }
    }
  }
  return null
}

for (const file of files) {
  if (!fs.existsSync(file)) {
    console.error(`No such file: ${file}`)
    process.exit(1)
  }
  const found = headerRow(file)
  console.log('')
  console.log('='.repeat(78))
  console.log(path.basename(file))
  if (!found) {
    console.log('  NO header row with an "Account Name" column in the first 10 rows.')
    continue
  }
  console.log(`  sheet "${found.sheet}", header on row ${found.rowIndex + 1}, ${found.columns.filter(Boolean).length} named columns`)
  console.log('')

  // Resolve exactly the way the importer does: first substring hit wins.
  const resolve = (frags: string[]) =>
    found.columns.find((k) => norm(k) !== '' && frags.some((f) => norm(k).includes(norm(f))))

  const claimed = new Map<string, string[]>()
  console.log('  FIELD                     READS THIS COLUMN')
  console.log('  ' + '-'.repeat(74))
  for (const [field, frags] of FIELD_FRAGMENTS) {
    const col = resolve(frags)
    if (col) {
      if (!claimed.has(col)) claimed.set(col, [])
      claimed.get(col)!.push(field)
    }
    const shown = col ?? '*** NOTHING — this field is never populated from this file ***'
    console.log(`  ${field.padEnd(25)} ${shown}`)
  }

  // Two fields reading one column is always a bug: one of them is wrong.
  const collisions = [...claimed.entries()].filter(([, fields]) => fields.length > 1)
  if (collisions.length) {
    console.log('')
    console.log('  *** COLLISIONS — more than one field resolves to the SAME column ***')
    for (const [col, fields] of collisions) {
      console.log(`    "${col}"  is read as:  ${fields.join('  AND  ')}`)
    }
  }

  // A column whose name contains another field's fragment is how the wrong one wins.
  const risky: string[] = []
  for (const col of found.columns) {
    if (!norm(col)) continue
    const matches = FIELD_FRAGMENTS.filter(([, frags]) => frags.some((f) => norm(col).includes(norm(f))))
    if (matches.length && resolve(matches[0][1]) !== col) {
      risky.push(`    "${col}"  looks like ${matches.map((m) => m[0]).join('/')} but LOSES to "${resolve(matches[0][1])}"`)
    }
  }
  if (risky.length) {
    console.log('')
    console.log('  *** SHADOWED — these columns match a field but are NOT the one chosen ***')
    for (const r of risky) console.log(r)
  }

  const used = new Set(claimed.keys())
  const unread = found.columns.filter((c) => norm(c) && !used.has(c) && norm(c) !== norm(found.columns[0]))
  if (unread.length) {
    console.log('')
    console.log(`  NOT READ AT ALL (${unread.length}):`)
    for (const c of unread) console.log(`    ${c}`)
  }

  console.log('')
  console.log('  Column 1 is read positionally as the lender-type code (B / C / NB / PE / L),')
  console.log(`  regardless of its header. Here that column is: "${found.columns[0] ?? '(blank)'}"`)
}

console.log('')
