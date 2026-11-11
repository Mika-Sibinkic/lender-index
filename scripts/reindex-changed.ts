/**
 * Re-embed only the lenders whose text actually changed.
 *
 * After scripts/sync-from-sheets.ts rewrites a batch of records, their stored
 * embeddings still describe the OLD text. Nothing errors; semantic search simply
 * keeps ranking those lenders on content that is no longer in the record. That
 * is the quiet kind of wrong this project exists to avoid, so this closes the
 * loop rather than leaving it to be remembered.
 *
 * Uses the app's own indexFundingSource, so the embedded text is byte-identical
 * to what the running app would produce. No second definition to drift.
 *
 *   set -a && source .env.local && set +a
 *   export OPENAI_COMPAT_BASE_URL=... OPENAI_COMPAT_API_KEY=... EMBED_MODEL=nomic-embed-text LLM_BACKEND=openai-compat
 *   pnpm tsx scripts/reindex-changed.ts --since 2026-09-18      # preview
 *   pnpm tsx scripts/reindex-changed.ts --since 2026-09-18 --write
 *
 * --since accepts a date or full ISO timestamp; defaults to the last 24 hours.
 * Omit it and pass --all to re-embed the entire roster.
 */

import { createClient } from '@supabase/supabase-js'
import { indexFundingSource } from '../src/lib/embeddings'

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!URL || !KEY) {
  console.error('Missing Supabase env. Run:  set -a && source .env.local && set +a')
  process.exit(1)
}

const args = process.argv.slice(2)
const WRITE = args.includes('--write')
const ALL = args.includes('--all')
const sinceArg = args[args.indexOf('--since') + 1]
const since =
  ALL
    ? null
    : args.includes('--since') && sinceArg && !sinceArg.startsWith('--')
      ? new Date(sinceArg).toISOString()
      : new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

// Fail loudly BEFORE touching anything. A missing embed endpoint used to surface
// as a per-row warning, which is easy to scroll past and leaves a half-reindexed
// roster that looks finished.
// .env.local ships these as EMPTY STRINGS, not unset, so `??` does not catch
// them — that is precisely how a "configured" run can embed nothing.
const env = (k: string): string => (process.env[k] ?? '').trim()
const backend = env('LLM_BACKEND') || (env('OPENAI_COMPAT_BASE_URL') ? 'openai-compat' : '')
if (!backend) {
  console.error(
    'No embedding backend configured — LLM_BACKEND and OPENAI_COMPAT_BASE_URL are both empty.\n' +
      '  .env.local ships the AI vars blank, so nothing here will embed until you set them.\n' +
      '  Copy the values from your Vercel project env and export them:\n' +
      '    export LLM_BACKEND=openai-compat\n' +
      '    export OPENAI_COMPAT_BASE_URL=<your OpenAI-compatible /v1 endpoint>\n' +
      '    export OPENAI_COMPAT_API_KEY=<the Ollama bearer>\n' +
      '    export EMBED_MODEL=nomic-embed-text',
  )
  process.exit(1)
}
if (backend === 'openai-compat' && !env('OPENAI_COMPAT_BASE_URL')) {
  console.error('LLM_BACKEND=openai-compat but OPENAI_COMPAT_BASE_URL is empty.')
  process.exit(1)
}
if (backend === 'gateway' && !env('AI_GATEWAY_API_KEY')) {
  console.error('LLM_BACKEND=gateway but AI_GATEWAY_API_KEY is empty.')
  process.exit(1)
}
if (!env('EMBED_MODEL')) {
  console.error('EMBED_MODEL is empty. Set it (nomic-embed-text for local Ollama) before re-embedding.')
  process.exit(1)
}

const db = createClient(URL, KEY, { auth: { autoRefreshToken: false, persistSession: false } })

async function main() {
  let q = db.from('funding_sources').select('*').order('updated_at', { ascending: false })
  if (since) q = q.gte('updated_at', since)
  const { data, error } = await q
  if (error) throw new Error(error.message)
  const rows = (data ?? []) as Array<Record<string, unknown>>

  console.log(
    since ? `${rows.length} lender(s) modified since ${since}` : `${rows.length} lender(s) (--all)`,
  )
  console.log(`  backend: ${backend}  ·  model: ${env('EMBED_MODEL')}`)

  if (!rows.length) {
    console.log('  nothing to do.')
    return
  }
  if (!WRITE) {
    console.log('')
    for (const r of rows.slice(0, 20)) console.log(`    ${String(r.company_name)}`)
    if (rows.length > 20) console.log(`    ... and ${rows.length - 20} more`)
    console.log('')
    console.log('  PREVIEW ONLY — add --write to re-embed these.')
    return
  }

  let ok = 0
  const failed: string[] = []
  for (const r of rows) {
    try {
      await indexFundingSource(db, r as unknown as Parameters<typeof indexFundingSource>[1])
      ok++
      if (ok % 25 === 0) console.log(`  ${ok}/${rows.length}…`)
    } catch (e) {
      failed.push(`${String(r.company_name)}: ${(e as Error).message}`)
    }
  }

  console.log('')
  console.log(`  re-embedded ${ok}/${rows.length}`)
  if (failed.length) {
    console.log(`  FAILED ${failed.length} — these still carry stale embeddings:`)
    for (const f of failed.slice(0, 15)) console.log(`    ${f}`)
    process.exit(1)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
