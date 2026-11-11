/**
 * One-shot graph bootstrap.
 *
 * Walks every funding_source + closed_deal + funding_source_contact,
 * runs deterministic extraction, optionally augments funding_source
 * free text via local LLM, then upserts entities + edges through
 * src/lib/graph/repo.
 *
 * Idempotent — re-run anytime. Edges keyed on (source_table, source_id)
 * are replaced per source row (delete + insert, one row at a time, after
 * extraction has finished) so stale edges from edited rows disappear
 * without the graph ever being smaller than it started.
 *
 * A mode flag is REQUIRED — the bare command refuses. --dry-run reads and
 * previews; --write is the only thing that mutates anything.
 *
 * Usage:
 *   set -a && source .env.local && set +a && \
 *     pnpm tsx scripts/build-graph.ts (--dry-run | --write) [--no-augment]
 */

import { createClient } from '@supabase/supabase-js'
import {
  extractFromFundingSource,
  extractFromClosedDeal,
  extractFromContact,
  augmentFromText,
  type FundingSourceCols,
  type ClosedDealCols,
  type ContactCols,
} from '../src/lib/graph/extract'
import {
  upsertEntities,
  upsertEdges,
  deleteEdgesBySource,
} from '../src/lib/graph/repo'
import type { EntityInput, EdgeInput } from '../src/lib/graph/types'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing SUPABASE env vars.')
  process.exit(1)
}

const args = process.argv.slice(2)
const noAugment = args.includes('--no-augment')

// Your production project ref (env) — named so the operator can see what they are aiming at.
const PRODUCTION_SUPABASE_REF = process.env.PRODUCTION_SUPABASE_REF?.trim()
const targetLabel = PRODUCTION_SUPABASE_REF && SUPABASE_URL.includes(PRODUCTION_SUPABASE_REF)
  ? `PRODUCTION (${SUPABASE_URL})`
  : SUPABASE_URL

// Writing now takes an explicit --write. It used to take the mere ABSENCE of
// --dry-run, so the bare command — the one you retype from memory — rewrote
// the live graph. "I forgot a flag" and "I rebuilt prod" were the same
// keystroke. Neither flag now means neither action: say which one you meant. --dry-run still previews, so existing
// runbooks keep working.
const writeFlag = args.includes('--write')
const previewFlag = args.includes('--dry-run')
if (writeFlag && previewFlag) {
  console.error('REFUSING TO RUN — --write and --dry-run contradict each other. Pass one.')
  process.exit(1)
}
if (!writeFlag && !previewFlag) {
  console.error(`REFUSING TO RUN — no mode given, and the target is ${targetLabel}.`)
  console.error('  This script deletes and rebuilds every graph edge. Say which you meant:')
  console.error('    pnpm tsx scripts/build-graph.ts --dry-run   # read + preview, writes nothing')
  console.error('    pnpm tsx scripts/build-graph.ts --write     # rebuild the graph for real')
  process.exit(1)
}
const dryRun = !writeFlag

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

interface Accumulator {
  entities: EntityInput[]
  edges: EdgeInput[]
}

function merge(into: Accumulator, more: { entities?: EntityInput[]; edges?: EdgeInput[] }) {
  if (more.entities) into.entities.push(...more.entities)
  if (more.edges) into.edges.push(...more.edges)
}

// Every source row we walked. The extraction passes only record here; the delete
// happens in main(), paired with that row's insert. See the comment there.
const touchedSources: Array<{ table: string; id: string }> = []

async function processFundingSources(): Promise<Accumulator> {
  const { data, error } = await supabase
    .from('funding_sources')
    .select(
      'id, company_name, primary_contact_name, primary_contact_title, primary_contact_email, asset_classes, geographic_scope, industry_filters, borrower_revenue_min_usd, internal_notes, rate_notes',
    )
  if (error) throw new Error(`read funding_sources: ${error.message}`)
  const rows = (data ?? []) as Array<
    FundingSourceCols & { internal_notes: string | null; rate_notes: string | null }
  >
  const acc: Accumulator = { entities: [], edges: [] }
  for (const r of rows) {
    touchedSources.push({ table: 'funding_sources', id: r.id })
    merge(acc, extractFromFundingSource(r))
    if (!noAugment) {
      const blob = [r.internal_notes ?? '', r.rate_notes ?? ''].join('\n\n')
      if (blob.trim()) {
        try {
          merge(acc, await augmentFromText(supabase, blob, { funding_source_id: r.id }))
        } catch (e) {
          console.warn(`  augment fs=${r.id} failed: ${(e as Error).message}`)
        }
      }
    }
  }
  console.log(`funding_sources: ${rows.length} rows → ${acc.entities.length} entities, ${acc.edges.length} edges`)
  return acc
}

async function processClosedDeals(): Promise<Accumulator> {
  const { data, error } = await supabase
    .from('closed_deal')
    .select('id, funding_source_id, asset_year, asset_make, asset_model, source_kind')
  if (error) throw new Error(`read closed_deal: ${error.message}`)
  const rows = (data ?? []) as ClosedDealCols[]
  const acc: Accumulator = { entities: [], edges: [] }
  for (const r of rows) {
    touchedSources.push({ table: 'closed_deal', id: r.id })
    merge(acc, extractFromClosedDeal(r))
  }
  console.log(`closed_deal:     ${rows.length} rows → ${acc.entities.length} entities, ${acc.edges.length} edges`)
  return acc
}

async function processContacts(): Promise<Accumulator> {
  const { data, error } = await supabase
    .from('funding_source_contacts')
    .select('id, funding_source_id, name, title, email')
  if (error) throw new Error(`read funding_source_contacts: ${error.message}`)
  const rows = (data ?? []) as ContactCols[]
  const acc: Accumulator = { entities: [], edges: [] }
  for (const r of rows) {
    touchedSources.push({ table: 'funding_source_contacts', id: r.id })
    merge(acc, extractFromContact(r))
  }
  console.log(`fsc contacts:    ${rows.length} rows → ${acc.entities.length} entities, ${acc.edges.length} edges`)
  return acc
}

async function main() {
  console.log(`build-graph${dryRun ? ' (dry-run)' : ' (WRITE)'}${noAugment ? ' (no-augment)' : ''} → ${targetLabel}\n`)

  const a1 = await processFundingSources()
  const a2 = await processClosedDeals()
  const a3 = await processContacts()

  const all: Accumulator = { entities: [], edges: [] }
  merge(all, a1)
  merge(all, a2)
  merge(all, a3)

  // De-dup entities by natural_key across sources (extractors already
  // de-dup within a single call; this catches cross-source overlap)
  const seen = new Set<string>()
  const entities = all.entities.filter((e) => {
    if (seen.has(e.natural_key)) return false
    seen.add(e.natural_key)
    return true
  })

  console.log(`\ntotal: ${entities.length} unique entities, ${all.edges.length} edges (${touchedSources.length} source-rows to rebuild)`)

  if (dryRun) {
    console.log('\nsample entities (first 5):')
    console.dir(entities.slice(0, 5), { depth: 3 })
    console.log('\nsample edges (first 5):')
    console.dir(all.edges.slice(0, 5), { depth: 3 })
    console.log(`\nREFUSING TO WRITE — dry run. Target is ${targetLabel}.`)
    console.log('Re-run with --write once the counts above look right:')
    console.log('  pnpm tsx scripts/build-graph.ts --write')
    return
  }

  await upsertEntities(supabase, entities)

  // Rebuild one source row at a time: delete that row's stale edges, then
  // immediately insert its freshly-extracted replacements. The old order wiped
  // every row's edges up front and only inserted after all three passes had
  // finished — with the per-row LLM augment calls sitting inside that gap — so a
  // timeout, a 530 off the AI tunnel, or a Ctrl-C left production holding fewer
  // edges than it started with and no way to tell which ones went missing.
  // Per-source, any crash leaves each row either fully rebuilt or entirely
  // untouched, and re-running finishes the job. The edges are already computed
  // in memory here, so the delete→insert gap per row is one round trip.
  const sourceKey = (table: string, id: string | null | undefined) => `${table}|${id ?? ''}`
  const edgesBySource = new Map<string, EdgeInput[]>()
  for (const e of all.edges) {
    const k = sourceKey(e.source_table, e.source_id)
    const list = edgesBySource.get(k)
    if (list) list.push(e)
    else edgesBySource.set(k, [e])
  }

  let written = 0
  for (const s of touchedSources) {
    const k = sourceKey(s.table, s.id)
    await deleteEdgesBySource(supabase, s.table, s.id)
    const batch = edgesBySource.get(k)
    if (batch?.length) written += await upsertEdges(supabase, batch)
    edgesBySource.delete(k)
  }
  // Any edge stamped with a source row the passes above didn't walk still gets
  // written — silently dropping it would shrink the graph just as quietly.
  for (const batch of edgesBySource.values()) {
    written += await upsertEdges(supabase, batch)
  }
  console.log(`\nwrote ${entities.length} entities, ${written} edges across ${touchedSources.length} source rows`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
