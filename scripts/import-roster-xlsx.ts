/**
 * Roster spreadsheet funding-source importer (CLI).
 *
 * Thin wrapper around the shared parser (src/lib/parse/roster-xlsx.ts)
 * and persistence helper (src/lib/parse/roster-persist.ts) — same code
 * path the drag-drop API route uses, so the CLI and the webapp can never
 * drift.
 *
 * Usage:
 *   set -a && source .env.local && set +a && \
 *     pnpm tsx scripts/import-roster-xlsx.ts \
 *       "/path/domestic-roster.xlsx" \
 *       "/path/international-roster.xlsx" [--dry-run] [--no-reindex]
 *
 * --dry-run: parse + print summary, no writes.
 * --no-reindex: skip embeddings + graph (run scripts/backfill-embeddings
 *   and scripts/build-graph yourself after).
 */

import { createClient } from '@supabase/supabase-js'
import * as XLSX from 'xlsx'
import { parseRosterWorkbook, inferInternational } from '../src/lib/parse/roster-xlsx'
import { persistRosterData } from '../src/lib/parse/roster-persist'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing SUPABASE env vars. Source .env.local first.')
  process.exit(1)
}

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const noReindex = args.includes('--no-reindex')
const files = args.filter((a) => !a.startsWith('--'))
if (files.length === 0) {
  console.error('Usage: pnpm tsx scripts/import-roster-xlsx.ts <file.xlsx> [...] [--dry-run] [--no-reindex]')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

async function main() {
  console.log(`Roster import${dryRun ? ' (dry-run)' : ''} — ${files.length} file(s)\n`)
  const allRows = []
  const allTags = []
  for (const f of files) {
    const wb = XLSX.readFile(f)
    const { rows, tags, report } = parseRosterWorkbook(wb, {
      isInternational: inferInternational(f),
    })
    const name = f.split('/').pop()
    console.log(`\n  ${name}`)
    console.log(`    sheets in file : ${report.sheetNames.join(', ')}`)
    console.log(`    sheets read    : ${report.sheetsRead.join(', ') || '(none)'}`)
    console.log(`    header row     : ${report.headerRowIndex + 1}`)
    console.log(`    rows in sheet  : ${report.inputRows}`)
    console.log(`    rows parsed    : ${report.parsedRows}`)
    console.log(`    rows skipped   : ${report.skipped.length}`)
    for (const sk of report.skipped.slice(0, 15)) {
      console.log(`      row ${sk.sheetRow}: ${sk.reason}`)
    }
    if (report.skipped.length > 15) console.log(`      … ${report.skipped.length - 15} more`)
    if (report.unmapped.length) console.log(`    UNMAPPED cols  : ${report.unmapped.join(' | ')}`)
    for (const w of report.warnings) console.log(`    WARNING        : ${w}`)
    const reconciles = report.parsedRows + report.skipped.length === report.inputRows
    console.log(`    reconciles     : ${reconciles ? 'yes' : 'NO — rows unaccounted for'}`)
    allRows.push(...rows)
    allTags.push(...tags)
  }

  const unique = new Set(allRows.map((r) => r.company_name)).size
  console.log(`\n  ${allRows.length} parsed → ${unique} unique companies`)
  if (allRows.length !== unique) {
    const counts = new Map<string, number>()
    for (const r of allRows) counts.set(r.company_name, (counts.get(r.company_name) ?? 0) + 1)
    const dupes = [...counts.entries()].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1])
    console.log(`  ${allRows.length - unique} row(s) share a company name with another row.`)
    console.log('  These are merged into one record; extra contacts are preserved:')
    for (const [name, n] of dupes.slice(0, 20)) console.log(`    ${n}x  ${name}`)
    if (dupes.length > 20) console.log(`    … ${dupes.length - 20} more companies`)
  }

  if (dryRun) {
    console.log('\n  Sample (first 3):')
    console.dir(allRows.slice(0, 3), { depth: 4 })
    console.log('\n  (dry run — no writes)')
    return
  }

  const summary = await persistRosterData(supabase, allRows, allTags, {
    reindex: !noReindex,
  })
  console.log(
    `\n  Upserted ${summary.upserted}, ${summary.tagLinks} tag links, ${summary.reindexed} re-indexed.`,
  )
  console.log(`  Companies built from more than one sheet row: ${summary.merged.length}`)
  console.log(`  Extra contacts preserved: ${summary.contactsKept}`)
  console.log(`  Blank cells that did NOT overwrite existing data: ${summary.blanksIgnored}`)
  if (noReindex) {
    console.log('  Skipped re-index. Run backfill-embeddings.ts + build-graph.ts.')
  }
  console.log('\nDone.')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
