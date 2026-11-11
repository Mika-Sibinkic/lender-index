import { createClient } from '@supabase/supabase-js'
import { aiExtract } from '../src/lib/parse/ai-extract'

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
)

async function main() {
  const text = `Pat Example, President at Vega Equipment Finance. pat@vega.example. We finance construction equipment and commercial trucks, deals from $500k to $20M, US only. Rate notes: 5y term floating.`
  const t0 = Date.now()
  const res = await aiExtract(text, { supabase: sb, module: 'smoke.parse' })
  console.log(`provider=${res.provider} model=${res.model} latencyMs=${Date.now() - t0}`)
  console.log('parsed:', JSON.stringify(res.parsed, null, 2))
  console.log('rawResponse first 200:', res.rawResponse.slice(0, 200))
}
main().catch((e) => { console.error(e); process.exit(1) })
