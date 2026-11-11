/**
 * Undo a sync. Restores every field to the value it held before the run.
 *
 * scripts/sync-from-sheets.ts writes sync-rollback-<timestamp>.json before its
 * first update, capturing the prior value of every field it is about to change.
 * This puts them back, so no sync is a one-way door.
 *
 *   set -a && source .env.local && set +a
 *   pnpm tsx scripts/restore-rollback.ts sync-rollback-....json            # preview
 *   pnpm tsx scripts/restore-rollback.ts sync-rollback-....json --write
 */

import * as fs from 'fs'
import { createClient } from '@supabase/supabase-js'

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!URL || !KEY) {
  console.error('Missing Supabase env. Run:  set -a && source .env.local && set +a')
  process.exit(1)
}
const args = process.argv.slice(2)
const WRITE = args.includes('--write')
const file = args.find((a) => !a.startsWith('--'))
if (!file) {
  console.error('Usage: pnpm tsx scripts/restore-rollback.ts <sync-rollback-....json> [--write]')
  process.exit(1)
}
if (!fs.existsSync(file)) {
  console.error(`No such file: ${file}`)
  process.exit(1)
}

const db = createClient(URL, KEY, { auth: { autoRefreshToken: false, persistSession: false } })

async function main() {
  const snap = JSON.parse(fs.readFileSync(file!, 'utf8')) as {
    takenAt: string
    rows: Array<{ id: string; company: string; previous: Record<string, unknown> }>
  }
  const fields = snap.rows.reduce((n, r) => n + Object.keys(r.previous).length, 0)
  console.log(WRITE ? 'RESTORE — WRITING' : 'RESTORE — PREVIEW (add --write)')
  console.log(`  snapshot taken ${snap.takenAt}`)
  console.log(`  ${snap.rows.length} lender(s), ${fields} field value(s) to put back`)
  for (const r of snap.rows.slice(0, 10)) {
    console.log(`    ${r.company.padEnd(34)} ${Object.keys(r.previous).join(', ')}`)
  }
  if (snap.rows.length > 10) console.log(`    ... and ${snap.rows.length - 10} more`)

  if (!WRITE) {
    console.log('')
    console.log('  no changes made.')
    return
  }

  let ok = 0
  for (const r of snap.rows) {
    const { error } = await db.from('funding_sources').update(r.previous).eq('id', r.id)
    if (error) console.warn(`  ${r.company}: ${error.message}`)
    else ok++
  }
  console.log('')
  console.log(`  restored ${ok}/${snap.rows.length} lender(s)`)
  console.log('  re-embed the restored rows:  pnpm reindex:changed --since <today> --write')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
