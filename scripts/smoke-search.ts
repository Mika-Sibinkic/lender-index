/**
 * End-to-end smoke test for the iteration-3 AI pipeline:
 *   - NL query rewrite (semantic_query + filters)
 *   - Funding-source kNN
 *   - Doc-chunk kNN
 *   - RRF fusion
 *
 * Usage: set -a && source .env.local && set +a && pnpm tsx scripts/smoke-search.ts
 */

import { createClient } from '@supabase/supabase-js'
import { rewriteQuery } from '../src/lib/search/query-rewrite'
import { llm } from '../src/lib/llm/client'
import { rrf } from '../src/lib/embeddings'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

const QUERIES = [
  'equipment finance under $5M for Texas logistics operators',
  'medical equipment deals up to 10 million dollars',
  'high LTV construction equipment financing low rate flexible covenants',
]

async function main() {
  for (const q of QUERIES) {
    console.log(`\n=== query: ${q}`)
    const rw = await rewriteQuery(supabase, q)
    console.log('rewrite:', JSON.stringify(rw, null, 2))

    const t0 = Date.now()
    const { embeddings } = await llm.embed({
      supabase,
      module: 'smoke',
      values: [rw.semantic_query],
    })
    console.log(`embed: ${embeddings[0].length} dims · ${Date.now() - t0}ms`)

    const { data: fsHits } = await supabase.rpc('match_funding_sources', {
      query_embedding: embeddings[0],
      match_count: 10,
    })
    const fsIds = (fsHits ?? []).map((r: { id: string }) => r.id)
    console.log(`fs kNN: ${fsIds.length} hits`)

    const { data: docHits } = await supabase.rpc('match_doc_chunks', {
      query_embedding: embeddings[0],
      match_count: 10,
    })
    const docFsIds = Array.from(
      new Set((docHits ?? []).map((r: { funding_source_id: string }) => r.funding_source_id)),
    )
    console.log(`doc kNN: ${docHits?.length ?? 0} chunks → ${docFsIds.length} sources`)

    const fused = rrf([fsIds, docFsIds]).slice(0, 5)
    console.log(`fused top-5: ${fused.join(', ')}`)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
