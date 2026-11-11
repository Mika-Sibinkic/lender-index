/**
 * Show every spreadsheet row a lender occupies, with the file and row number.
 *
 * The sync reports a conflict as "Yes || No", which only happens when a lender
 * sits on two or more rows that disagree. When that contradicts what you can see
 * in the workbook ("I only found one record in the domestic csv and none in the
 * intl") — the question is not who is right, it
 * is WHERE the second row is. Cmd+F stops at the first hit; a duplicate 200 rows
 * further down looks like nothing at all.
 *
 * Prints the file, the sheet, and the 1-based row number as Excel shows it, so a
 * disputed row can be opened directly instead of hunted.
 *
 *   set -a && source .env.local && set +a
 *   pnpm explain:lender "Bellatrix Capital" "<Domestic ….xlsx>" "<International ….xlsx>"
 */

import * as fs from 'fs'
import * as path from 'path'
import * as XLSX from 'xlsx'

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const needle = args[0]
const files = args.slice(1)
if (!needle || files.length === 0) {
  console.error('Usage: pnpm explain:lender "<lender name>" <domestic.xlsx> [international.xlsx]')
  process.exit(1)
}

const norm = (s: unknown) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim()

let total = 0

for (const file of files) {
  if (!fs.existsSync(file)) {
    console.error(`No such file: ${file}`)
    process.exit(1)
  }
  const wb = XLSX.read(fs.readFileSync(file), { type: 'buffer' })
  for (const sheetName of wb.SheetNames) {
    const sh = wb.Sheets[sheetName]
    if (!sh) continue
    const grid = XLSX.utils.sheet_to_json<unknown[]>(sh, { header: 1, raw: false, blankrows: true })

    let headerRow = -1
    let nameCol = -1
    for (let i = 0; i < Math.min(10, grid.length); i++) {
      const cells = [...(grid[i] ?? [])].map((c) => String(c ?? ''))
      const idx = cells.findIndex((c) => norm(c).includes('account name'))
      if (idx >= 0) {
        headerRow = i
        nameCol = idx
        break
      }
    }
    if (headerRow < 0) continue

    const header = [...(grid[headerRow] ?? [])].map((c) => String(c ?? ''))
    for (let r = headerRow + 1; r < grid.length; r++) {
      const cells = [...(grid[r] ?? [])].map((c) => String(c ?? ''))
      if (norm(cells[nameCol]) !== norm(needle)) continue
      total++
      console.log('')
      console.log('='.repeat(72))
      console.log(`${path.basename(file)}  ·  sheet "${sheetName}"  ·  EXCEL ROW ${r + 1}`)
      console.log('='.repeat(72))
      for (let c = 0; c < Math.max(header.length, cells.length); c++) {
        const h = String(header[c] ?? '').split(/\s{2,}|\n/)[0].trim() || `col ${c + 1}`
        const v = String(cells[c] ?? '').trim()
        if (!v) continue
        console.log(`  ${h.padEnd(26)} ${v}`)
      }
    }
  }
}

console.log('')
if (total === 0) {
  console.log(`No row named "${needle}" in any of those files.`)
  console.log('  The name must match exactly (ignoring case and extra spaces).')
} else if (total === 1) {
  console.log(`1 row total. A conflict reported for this lender would be a BUG — tell Claude.`)
} else {
  console.log(`${total} rows total. A "a || b" conflict means these rows disagree on that column.`)
  console.log('  The Excel row numbers above are where to look.')
}
console.log('')
