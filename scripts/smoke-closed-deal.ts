/**
 * Read-only smoke of the Past Deals import EXTRACTION hop.
 *
 * "Past Deals document importing does not work" was reported twice, and the import
 * had never once been watched succeed: the `closed_deal` table held zero rows. The
 * route was fixed, but the fix was only ever reasoned about, never run against a
 * real document.
 *
 * This drives the exact functions `/api/closed-deals` calls — spreadsheetToText /
 * extractPdfText, then extractClosedDeal against the configured AI backend — and
 * prints what came back. It WRITES NOTHING: no closed_deal row, no funding_sources
 * change. The insert half is verified separately through the signed-in UI.
 *
 * Usage:
 *   set -a && source .env.local && set +a
 *   pnpm tsx scripts/smoke-closed-deal.ts <file> [<file> ...]
 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { extractClosedDeal, resolveFundingSourceId } from '@/lib/parse/closed-deal-extract'
import { extractPdfText } from '@/lib/parse/pdf-text'
import { spreadsheetToText } from '@/lib/parse/spreadsheet-text'

const isSheet = (f: string) => /\.(xlsx|xls|csv)$/i.test(f)

async function main() {
  const files = process.argv.slice(2)
  if (files.length === 0) {
    console.error('usage: tsx scripts/smoke-closed-deal.ts <file> [<file> ...]')
    process.exit(2)
  }
  const admin = getSupabaseAdmin()

  for (const file of files) {
    const name = path.basename(file)
    console.log(`\n${'='.repeat(72)}\n${name}`)
    const buf = await readFile(file)

    const t0 = Date.now()
    const text = isSheet(file)
      ? spreadsheetToText(buf, name)
      : await extractPdfText(buf)
    console.log(`  text: ${text.length} chars in ${Date.now() - t0}ms`)
    console.log(`  head: ${JSON.stringify(text.slice(0, 220))}`)

    const t1 = Date.now()
    try {
      const extracted = await extractClosedDeal(admin, text)
      const secs = ((Date.now() - t1) / 1000).toFixed(1)
      const filled = Object.values(extracted).filter((v) => v !== null && v !== undefined).length
      console.log(`  extracted in ${secs}s — ${filled}/${Object.keys(extracted).length} fields`)
      for (const [k, v] of Object.entries(extracted)) {
        console.log(`    ${k.padEnd(20)} ${v === null ? '—' : JSON.stringify(v)}`)
      }
      if (extracted.bank_name) {
        const id = await resolveFundingSourceId(admin, extracted.bank_name)
        console.log(`  bank_name → funding_source_id: ${id ?? 'no match (would insert unlinked)'}`)
      }
    } catch (e) {
      console.log(`  FAILED after ${((Date.now() - t1) / 1000).toFixed(1)}s: ${e instanceof Error ? e.message : e}`)
    }
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
