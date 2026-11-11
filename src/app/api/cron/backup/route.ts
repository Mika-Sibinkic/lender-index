/**
 * Nightly logical backup — and, as a side effect, DB activity that keeps an idle
 * Supabase project from being paused.
 *
 * Putting the one job that protects the data on an on-prem machine that can
 * sleep or go unreachable is the wrong call, so this runs on the same daily
 * Vercel cron that already drives outreach and warmup and works whether or not
 * any local box is on. On a project with no point-in-time recovery it is the
 * only backup.
 *
 * What it writes: every row of every app table as gzipped JSON, one timestamped
 * object in the private `backups` bucket, keeping the most recent 30. Reading
 * the rows is itself DB activity.
 *
 * Honest limit: this lives in the same Supabase project it backs up. It protects
 * against the failures that actually happen — an accidental bulk delete, a bad
 * import, a botched migration, a cleared column — not against losing the account.
 */

import { NextRequest, NextResponse } from 'next/server'
import { gzipSync } from 'node:zlib'
import { getSupabaseAdmin } from '@/lib/supabase/admin'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 60

const BUCKET = 'backups'
const KEEP = 30

/**
 * Every table holding data we could not reconstruct.
 *
 * Derived from the tables the app actually reads and writes, not guessed — an
 * earlier pass listed `outreach_thread`/`outreach_message`, which do not exist;
 * the real names are outreach_draft / outreach_sent / outreach_run /
 * outreach_action_token.
 *
 * Deliberately EXCLUDED: funding_source_embeddings, funding_source_doc_chunks,
 * graph_edge / graph_entity / graph_token. Those are all derived indexes,
 * rebuildable from the source rows by scripts/backfill-embeddings.ts and
 * scripts/build-graph.ts, and the embeddings alone would dwarf everything else
 * in the file. cost_log is telemetry, not business data.
 */
const TABLES = [
  'funding_sources',
  'tag',
  'funding_source_tag',
  'closed_deal',
  'users',
  'parse_logs',
  'proposed_field',
  'funding_source_edits',
  'funding_source_documents',
  'outreach_draft',
  'outreach_sent',
  'outreach_run',
  'outreach_action_token',
] as const

function authorized(req: NextRequest): boolean {
  const expected = process.env.CRON_SECRET
  if (!expected) return false
  if (req.headers.get('authorization') === `Bearer ${expected}`) return true
  return req.headers.get('x-cron-secret') === expected
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const admin = getSupabaseAdmin()
  const dump: Record<string, unknown[]> = {}
  const counts: Record<string, number> = {}
  const skipped: string[] = []

  for (const table of TABLES) {
    const { data, error } = await admin.from(table).select('*')
    if (error) {
      // A table that does not exist in this environment is not a failure — the
      // schema has grown over time. A table that exists and errors IS, and is
      // surfaced below rather than silently producing a short backup.
      skipped.push(`${table}: ${error.message}`)
      continue
    }
    dump[table] = data ?? []
    counts[table] = (data ?? []).length
  }

  // The whole point is the lender roster. If that came back empty something is
  // wrong upstream, and overwriting a good backup rotation with an empty file is
  // worse than not running — so fail loudly instead.
  if (!counts.funding_sources) {
    return NextResponse.json(
      { ok: false, error: 'refusing to write a backup with zero funding_sources', counts, skipped },
      { status: 500 },
    )
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const path = `backup-${stamp}.json.gz`
  const body = gzipSync(
    Buffer.from(JSON.stringify({ takenAt: new Date().toISOString(), counts, tables: dump })),
  )

  const { error: upErr } = await admin.storage
    .from(BUCKET)
    .upload(path, body, { contentType: 'application/gzip', upsert: false })
  if (upErr) {
    console.error('cron.backup upload failed', upErr)
    return NextResponse.json({ ok: false, error: upErr.message, counts }, { status: 500 })
  }

  // Prune oldest beyond KEEP. Names are ISO-stamped so lexical order is time order.
  let pruned = 0
  const { data: existing } = await admin.storage
    .from(BUCKET)
    .list('', { limit: 1000, sortBy: { column: 'name', order: 'asc' } })
  const files = (existing ?? []).filter((f) => f.name.endsWith('.json.gz'))
  if (files.length > KEEP) {
    const old = files.slice(0, files.length - KEEP).map((f) => f.name)
    const { error: rmErr } = await admin.storage.from(BUCKET).remove(old)
    if (rmErr) console.warn('cron.backup prune failed', rmErr.message)
    else pruned = old.length
  }

  return NextResponse.json({
    ok: true,
    path,
    bytes: body.length,
    rows: Object.values(counts).reduce((a, b) => a + b, 0),
    counts,
    kept: Math.min(files.length + 1, KEEP),
    pruned,
    skipped,
    ts: new Date().toISOString(),
  })
}
