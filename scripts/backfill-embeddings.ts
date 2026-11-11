/**
 * One-shot embedding backfill for funding_sources.
 *
 * Reads every row, runs the unified llm.embed (respects LLM_BACKEND +
 * OPENAI_COMPAT_BASE_URL — so this works against local Ollama, a self-hosted
 * NIM, or AI Gateway), and upserts into funding_source_embeddings.
 *
 * Usage:
 *   set -a && source .env.local && set +a && pnpm tsx scripts/backfill-embeddings.ts
 */

import { createClient } from '@supabase/supabase-js'
import { llm, LLM_MODELS } from '../src/lib/llm/client'
import { sourceText, EMBEDDING_DIMS } from '../src/lib/embeddings'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing SUPABASE env vars. Source .env.local first.')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

async function main() {
  const { data: rows, error } = await supabase
    .from('funding_sources')
    // Select the WHOLE row. This list used to name 12 columns while sourceText()
    // reads 16 — asset_subtypes, specific_geographic, lender_type,
    // operation_category and vintage_restriction were silently absent, so every
    // embedding this script wrote was built from less text than the app's own
    // indexer uses, and running it DEGRADED the index it was meant to repair.
    // A column added to sourceText can no longer be forgotten here.
    .select('*')
    .order('updated_at', { ascending: false })
  if (error) {
    console.error('Failed to read funding_sources:', error)
    process.exit(1)
  }
  if (!rows || rows.length === 0) {
    console.log('No funding_sources to embed.')
    return
  }

  console.log(`Embedding ${rows.length} rows via ${LLM_MODELS.embed}…`)

  let ok = 0
  let skipped = 0
  for (const r of rows) {
    const text = sourceText(r)
    if (!text.trim()) {
      skipped += 1
      continue
    }
    try {
      const { embeddings } = await llm.embed({
        supabase,
        module: 'embeddings.backfill',
        values: [text],
      })
      const vec = embeddings[0]
      if (!Array.isArray(vec) || vec.length !== EMBEDDING_DIMS) {
        console.warn(`  skip ${r.id} — dim mismatch ${vec?.length} != ${EMBEDDING_DIMS}`)
        skipped += 1
        continue
      }
      const { error: upErr } = await supabase
        .from('funding_source_embeddings')
        .upsert(
          {
            funding_source_id: r.id,
            embedding: vec,
            model: LLM_MODELS.embed,
            dims: EMBEDDING_DIMS,
            indexed_at: new Date().toISOString(),
          },
          { onConflict: 'funding_source_id' },
        )
      if (upErr) {
        console.warn(`  skip ${r.id} — upsert failed: ${upErr.message}`)
        skipped += 1
        continue
      }
      ok += 1
      if (ok % 5 === 0) console.log(`  ${ok}/${rows.length}`)
    } catch (e) {
      console.warn(`  skip ${r.id} — embed failed: ${(e as Error).message}`)
      skipped += 1
    }
  }

  console.log(`Done. ${ok} embedded, ${skipped} skipped.`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
