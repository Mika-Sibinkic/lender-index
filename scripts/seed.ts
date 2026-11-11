import { createClient } from '@supabase/supabase-js'
import * as fs from 'fs'
import * as path from 'path'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!url || !serviceKey) {
  console.error('Missing SUPABASE env vars. Source .env.local first, e.g.:')
  console.error('  set -a && source .env.local && set +a && pnpm seed')
  process.exit(1)
}

// Set PRODUCTION_SUPABASE_REF to your production project ref so `pnpm seed`
// can never write there. The `.env.local.example` template URL
// (your-project-ref) is refused too: a URL nobody edited is not a seed target.
const PRODUCTION_SUPABASE_REF = process.env.PRODUCTION_SUPABASE_REF?.trim()
const TEMPLATE_PROJECT_REF = 'your-project-ref'

// Hard refusal, and deliberately no bypass flag. Every row in seed-rows.json is
// a fabricated lender with a plausible name (Vega Equipment Finance, Rigel
// Commercial Credit), nothing in src/ filters `[SYNTHETIC SEED]` out of the
// list, search or match paths, and users have no way to tell a fake funding
// source from a real one — the one failure this app exists to prevent ("no
// wrong lender ever"). A `--force` here would just be the thing someone pastes
// at 11pm, so the only way to seed is to point NEXT_PUBLIC_SUPABASE_URL at a
// non-production project.
if (
  (PRODUCTION_SUPABASE_REF && url.includes(PRODUCTION_SUPABASE_REF)) ||
  url.includes(TEMPLATE_PROJECT_REF)
) {
  console.error('REFUSING TO SEED — NEXT_PUBLIC_SUPABASE_URL points at the PRODUCTION project')
  console.error('  (PRODUCTION_SUPABASE_REF) or is still the template URL.')
  console.error(`  target: ${url}`)
  console.error('  seed-rows.json is 26 fabricated lenders and the app does not hide them;')
  console.error('  users would see invented funding sources as real ones.')
  console.error('  There is no override flag. Point NEXT_PUBLIC_SUPABASE_URL at a local or')
  console.error('  branch Supabase project and re-run.')
  process.exit(1)
}

const supabase = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})

async function main() {
  const file = path.join(__dirname, '..', 'supabase', 'seed-data', 'seed-rows.json')
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  const arrayCols = [
    'asset_classes',
    'required_documents',
    'geographic_scope',
    'industry_filters',
    'asset_subtypes',
  ]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = raw.map((r: any) => {
    for (const c of arrayCols) if (r[c] == null) r[c] = []
    return r
  })

  const { error: delErr } = await supabase
    .from('funding_sources')
    .delete()
    .like('internal_notes', '[SYNTHETIC SEED]%')
  if (delErr) {
    console.error('Failed to clear synthetic rows:', delErr)
    process.exit(1)
  }

  const { data, error } = await supabase
    .from('funding_sources')
    .insert(rows)
    .select('id, company_name')
  if (error) {
    console.error('Insert failed:', error)
    process.exit(1)
  }
  console.log(`Inserted ${data.length} synthetic rows.`)

  // Default tags — preserve the roster spreadsheet's color semantics.
  // Idempotent via upsert.
  const DEFAULT_TAGS: { name: string; color: 'red' | 'amber' | 'green' | 'blue'; semantic: string }[] = [
    { name: 'bad-contact', color: 'red',   semantic: 'email bounced or unreachable; keep lender, replace contact' },
    { name: 'stale',       color: 'amber', semantic: 'data older than 90 days; needs refresh' },
    { name: 'preferred',   color: 'green', semantic: 'historically high close rate / repeat lender' },
    { name: 'rental',      color: 'blue',  semantic: 'open to rental-fleet usage' },
  ]
  const { data: tagRows, error: tagErr } = await supabase
    .from('tag')
    .upsert(DEFAULT_TAGS, { onConflict: 'name' })
    .select('id, name')
  if (tagErr) {
    console.error('Tag seed failed:', tagErr)
    process.exit(1)
  }
  console.log(`Upserted ${tagRows.length} default tags.`)

  // Light demo wiring: tag the first 3 inserted rows with `preferred`
  // so the UI shows chips on a fresh seed.
  const preferred = tagRows.find((t) => t.name === 'preferred')
  if (preferred && data.length) {
    const links = data.slice(0, 3).map((r) => ({
      funding_source_id: r.id,
      tag_id: preferred.id,
    }))
    const { error: linkErr } = await supabase
      .from('funding_source_tag')
      .upsert(links, { onConflict: 'funding_source_id,tag_id' })
    if (linkErr) console.warn('Demo tag-link upsert failed:', linkErr.message)
    else console.log(`Tagged ${links.length} rows as preferred for demo.`)
  }
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
