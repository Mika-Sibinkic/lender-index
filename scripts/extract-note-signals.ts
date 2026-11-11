/**
 * Read every lender's `internal_notes` into typed signals (migration 0023).
 *
 * Idempotent and re-runnable. By default it prints what it WOULD write and
 * touches nothing; `--apply` writes. A row is skipped when it already carries
 * signals from the current reader version AND its notes have not changed since,
 * so a re-run after an interruption resumes rather than restarting.
 *
 * Usage:
 *   set -a && source .env.local && set +a && \
 *     pnpm tsx scripts/extract-note-signals.ts [--apply] [--limit N] [--only "Name"]
 *
 * `--revalidate` re-applies the deterministic gates to the signals ALREADY
 * stored, without calling the model at all. Use it when a gate is tightened: the
 * gates only ever read the quote and the notes, both of which are on the row, so
 * this produces exactly what a full re-run would produce for anything a gate can
 * decide — in seconds rather than half an hour against a contended model host. It can
 * only ever remove signals, never add one.
 *
 * Sizing: roster notes are short (typically under a few hundred characters), so
 * each call is ~20-110 tokens — far under the payload that made document intake
 * a coin flip, and well inside a reverse proxy's ~120s timeout. Calls are
 * SEQUENTIAL on purpose: a self-hosted model proxy is often MAX_CONCURRENT=1, so
 * parallelism here would just fill its queue and start timing out.
 *
 * Accuracy: `validateNoteSignals` drops any signal whose quote is not literally
 * present in the notes, so a model that paraphrases or invents produces nothing
 * rather than something wrong. The dry run reports how many were dropped — a
 * rising number there is the signal that the prompt or the model regressed.
 */

import { createClient } from '@supabase/supabase-js'
import { extractNoteSignals } from '../src/lib/notes/extract'
import {
  NOTE_SIGNALS_VERSION,
  asNoteSignals,
  validateNoteSignals,
  type NoteSignals,
} from '../src/lib/notes/signals'

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!URL || !KEY) {
  console.error('Missing SUPABASE env. `set -a && source .env.local && set +a` first.')
  process.exit(1)
}

const apply = process.argv.includes('--apply')
const revalidate = process.argv.includes('--revalidate')
const limitArg = process.argv.indexOf('--limit')
const limit = limitArg > -1 ? Number(process.argv[limitArg + 1]) : Infinity
const onlyArg = process.argv.indexOf('--only')
const only = onlyArg > -1 ? process.argv[onlyArg + 1] : null

const db = createClient(URL, KEY, { auth: { autoRefreshToken: false, persistSession: false } })

/**
 * Cheap change-detector so a re-run does not pay for notes that have not moved.
 * Not a security hash — just "are these the same words as last time".
 */
const fingerprint = (s: string) => {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
  return `${s.length}:${h}`
}

const summarise = (sig: NoteSignals) => {
  const bits: string[] = []
  for (const p of sig.prefers) bits.push(`prefers ${p.place}`)
  for (const a of sig.avoids) bits.push(`AVOIDS ${a.place}`)
  for (const a of sig.assets) bits.push(`asset ${a.asset}`)
  if (sig.paused) bits.push('paused')
  return bits.length ? bits.join(', ') : '—'
}

/**
 * Re-run the gates over what is already stored.
 *
 * Feeds each stored signal back through validateNoteSignals as though the model
 * had just produced it. Every gate reads only the quote and the notes, so the
 * result is identical to a full re-extraction for anything a gate decides, and
 * it costs no model calls.
 */
async function revalidateStored() {
  console.log(`note-signal revalidation${apply ? ' (APPLY)' : ' (dry-run)'}\n`)

  const { data: rows, error } = await db
    .from('funding_sources')
    .select('id, company_name, internal_notes, note_signals')
    .not('note_signals', 'is', null)
    .order('company_name')
  if (error) throw new Error(error.message)

  let changed = 0
  let cleared = 0
  for (const r of rows ?? []) {
    const stored = asNoteSignals(r.note_signals)
    if (!stored) continue
    const notes = (r.internal_notes ?? '').trim()

    const next = validateNoteSignals(
      notes,
      {
        prefers: stored.prefers,
        avoids: stored.avoids,
        assets: stored.assets,
        paused: stored.paused,
      },
      { model: stored.model, now: new Date(stored.extracted_at || Date.now()) },
    )

    const before = JSON.stringify([stored.prefers, stored.avoids, stored.assets, stored.paused])
    const after = JSON.stringify([next.prefers, next.avoids, next.assets, next.paused])
    if (before === after) continue

    changed++
    const dropped: string[] = []
    if (stored.paused && !next.paused) dropped.push(`paused ("${stored.paused.quote}")`)
    for (const p of stored.prefers)
      if (!next.prefers.some((x) => x.quote === p.quote)) dropped.push(`prefers ${p.place}`)
    for (const a of stored.avoids)
      if (!next.avoids.some((x) => x.quote === a.quote)) dropped.push(`avoids ${a.place}`)
    for (const a of stored.assets)
      if (!next.assets.some((x) => x.quote === a.quote)) dropped.push(`asset ${a.asset}`)

    const empty =
      next.prefers.length + next.avoids.length + next.assets.length === 0 && !next.paused
    if (empty) cleared++
    console.log(`  ${r.company_name.padEnd(40)} drop: ${dropped.join(', ')}`)

    if (apply) {
      const { error: upErr } = await db
        .from('funding_sources')
        .update({ note_signals: { ...next, source: stored.source } })
        .eq('id', r.id)
      if (upErr) throw new Error(`${r.company_name}: ${upErr.message}`)
    }
  }

  console.log(`\n${rows?.length ?? 0} rows checked  ·  ${changed} changed  ·  ${cleared} now carry no signal`)
  console.log(apply ? 'written.' : 'dry run — nothing written. Re-run with --apply.')
}

async function main() {
  if (revalidate) return revalidateStored()
  console.log(`note-signal extraction${apply ? ' (APPLY)' : ' (dry-run)'}\n`)

  let q = db
    .from('funding_sources')
    .select('id, company_name, internal_notes, note_signals')
    .order('company_name')
  if (only) q = q.eq('company_name', only)

  const { data: rows, error } = await q
  if (error) throw new Error(error.message)

  const candidates = (rows ?? []).filter((r) => (r.internal_notes ?? '').trim().length > 0)
  console.log(`${rows?.length ?? 0} lenders, ${candidates.length} with notes\n`)

  let done = 0
  let skipped = 0
  let written = 0
  let rejectedTotal = 0
  let withSignal = 0
  let failed = 0
  const latencies: number[] = []

  for (const r of candidates) {
    if (done >= limit) break
    const notes = (r.internal_notes ?? '').trim()

    const existing = asNoteSignals(r.note_signals)
    if (
      existing &&
      existing.version === NOTE_SIGNALS_VERSION &&
      existing.source === fingerprint(notes)
    ) {
      skipped++
      continue
    }

    done++
    try {
      const { signals, latencyMs, rejected } = await extractNoteSignals(
        { supabase: db, module: 'notes.signals' },
        notes,
      )
      latencies.push(latencyMs)
      rejectedTotal += rejected

      const payload = { ...signals, source: fingerprint(notes) }
      const has =
        signals.prefers.length + signals.avoids.length + signals.assets.length > 0 || signals.paused
      if (has) withSignal++

      const flag = rejected > 0 ? ` [${rejected} dropped]` : ''
      console.log(
        `  ${String(done).padStart(3)}. ${r.company_name.padEnd(38)} ${Math.round(latencyMs / 100) / 10}s  ${summarise(signals)}${flag}`,
      )

      if (apply) {
        const { error: upErr } = await db
          .from('funding_sources')
          .update({ note_signals: payload })
          .eq('id', r.id)
        if (upErr) throw new Error(upErr.message)
        written++
      }
    } catch (e) {
      failed++
      console.log(`  ${String(done).padStart(3)}. ${r.company_name.padEnd(38)} FAILED: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const p50 = latencies.length
    ? [...latencies].sort((a, b) => a - b)[Math.floor(latencies.length / 2)]
    : 0
  console.log(
    `\nread ${done}  ·  already current ${skipped}  ·  carried a signal ${withSignal}  ·  ` +
      `quotes dropped ${rejectedTotal}  ·  failed ${failed}  ·  p50 ${Math.round(p50 / 100) / 10}s`,
  )
  console.log(apply ? `wrote ${written} rows` : 'dry run — nothing written. Re-run with --apply.')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
