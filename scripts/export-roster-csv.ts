/**
 * Export the funding-source database back out as CSVs shaped like your roster spreadsheets.
 *
 * Teams that moved off spreadsheets still know those workbooks. This produces a
 * readable, openable backup in the layout they already know — a rollback point
 * that does not require the app or a database client.
 *
 * HOW IT MATCHES THE ROSTER FORMAT
 *   It reads the ORIGINAL workbooks for their HEADER ROW ONLY and reuses those
 *   exact column names, in their exact order. Nothing about the layout is
 *   hardcoded here, so if a column is renamed or reordered, pass the newer
 *   workbook and the export follows it. Cell VALUES come entirely from the
 *   database; the workbooks are touched only to learn the shape.
 *
 *   Values are written back in the sheets' own encodings, not the database's:
 *   lender type as B / C / NB / PE, asset subtypes as their labels,
 *   international-domestic as I / D, and loan amounts in MILLIONS when the
 *   column header says MM — the same convention the importer reads.
 *
 *   Rows are contact-level, like the originals: a company with three contacts
 *   produces three rows, primary first.
 *
 *   set -a && source .env.local && set +a
 *   pnpm export:csv "<Domestic ….xlsx>" "<International ….xlsx>"
 *
 * Writes roster-export-domestic.csv and roster-export-international.csv next to you.
 * Both may contain roster data — they are gitignored.
 */

import * as fs from 'fs'
import * as path from 'path'
import * as XLSX from 'xlsx'
import { createClient } from '@supabase/supabase-js'
import { readHeaderRow, renderRow } from '../src/lib/parse/roster-layout'

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!URL || !KEY) {
  console.error('Missing Supabase env. Run:  set -a && source .env.local && set +a')
  process.exit(1)
}

const files = process.argv.slice(2).filter((a) => !a.startsWith('--'))
if (files.length === 0) {
  console.error('Usage: pnpm export:csv <domestic.xlsx> [international.xlsx]')
  console.error('  The workbooks are read for their HEADER ROW only, to match your column layout.')
  process.exit(1)
}

const db = createClient(URL, KEY, { auth: { autoRefreshToken: false, persistSession: false } })

const csvCell = (v: unknown): string => {
  const s = v == null ? '' : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

async function main() {
  const { data, error } = await db.from('funding_sources').select('*').order('company_name')
  if (error) throw new Error(error.message)
  const rows = (data ?? []) as Array<Record<string, unknown>>

  const { data: extra } = await db.from('funding_source_contacts').select('funding_source_id,name,email')
  const extraBySource = new Map<string, Array<{ name?: unknown; email?: unknown }>>()
  for (const c of (extra ?? []) as Array<Record<string, unknown>>) {
    const k = String(c.funding_source_id)
    if (!extraBySource.has(k)) extraBySource.set(k, [])
    extraBySource.get(k)!.push({ name: c.name, email: c.email })
  }

  for (const file of files) {
    if (!fs.existsSync(file)) {
      console.error(`No such file: ${file}`)
      process.exit(1)
    }
    const header = readHeaderRow(fs.readFileSync(file))?.columns ?? []
    if (!header.length) {
      console.error(`No "Account Name" column found in ${path.basename(file)} — cannot learn its layout.`)
      process.exit(1)
    }
    const isIntl = /international/i.test(path.basename(file))
    // Match the sheet this workbook represents. "Both" belongs on both sheets,
    // exactly as it does in the roster originals.
    const mine = rows.filter((r) => {
      const v = String(r.intl_domestic ?? '')
      if (isIntl) return v === 'International' || v === 'Both'
      return v === 'Domestic' || v === 'Both' || v === ''
    })

    const lines: string[] = [header.map(csvCell).join(',')]
    let rowCount = 0
    for (const r of mine) {
      const contacts: Array<{ name?: unknown; email?: unknown }> = [
        { name: r.primary_contact_name, email: r.primary_contact_email },
        ...(extraBySource.get(String(r.id)) ?? []),
      ]
      for (const c of contacts) {
        const cells = renderRow(header, r, c).map(csvCell)
        lines.push(cells.join(','))
        rowCount++
      }
    }

    const out = isIntl ? 'roster-export-international.csv' : 'roster-export-domestic.csv'
    fs.writeFileSync(out, lines.join('\n') + '\n')
    console.log(`  ${out}  —  ${mine.length} lenders, ${rowCount} contact rows`)
    console.log(`    columns copied from ${path.basename(file)}: ${header.filter(Boolean).length}`)
  }

  console.log('')
  console.log('  Both files may contain roster data and are gitignored.')
  console.log('  Open them in Excel to confirm the layout matches before relying on them.')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
