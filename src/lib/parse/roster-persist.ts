/**
 * Persist parsed roster rows + tags into Supabase, then trigger
 * embedding + graph re-index for each upserted source.
 *
 * Shared by the drag-drop API route and (optionally) the CLI script.
 * Returns a summary the caller can surface to the user.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  type ParsedFundingRow,
  type ParsedTag,
  ROSTER_TAG_COLORS,
} from './roster-xlsx'
import { indexFundingSource } from '@/lib/embeddings'
import { indexGraphForFundingSource } from '@/lib/graph/index-funding-source'

export interface PersistSummary {
  upserted: number
  tagLinks: number
  reindexed: number
  /**
   * Companies that appeared on more than one sheet row. These used to vanish:
   * a Map keyed on company_name kept the LAST row and dropped the rest with no
   * counter anywhere, so a real import lost a large share of its rows,
   * unrecorded. The sheets carry one row per CONTACT, so a bank with three
   * people lost two of them.
   */
  merged: Array<{ company_name: string; sheetRows: number }>
  /** Extra contacts preserved instead of discarded. */
  contactsKept: number
  /** Fields NOT overwritten because the incoming cell was blank. */
  blanksIgnored: number
}

export async function persistRosterData(
  supabase: SupabaseClient,
  rows: ParsedFundingRow[],
  tags: ParsedTag[],
  opts: { reindex?: boolean } = {},
): Promise<PersistSummary> {
  // Group by company instead of overwriting. Same one-row-per-company result the
  // index needs, but nothing is thrown away: the first row seeds the record, any
  // later row fills fields the first left blank, and every additional CONTACT is
  // kept (see funding_source_contacts below).
  const byCompany = new Map<string, ParsedFundingRow[]>()
  for (const r of rows) {
    const list = byCompany.get(r.company_name)
    if (list) list.push(r)
    else byCompany.set(r.company_name, [r])
  }
  const merged: Array<{ company_name: string; sheetRows: number }> = []
  const dedup: ParsedFundingRow[] = []
  for (const [company, list] of byCompany) {
    if (list.length > 1) merged.push({ company_name: company, sheetRows: list.length })
    dedup.push(mergeRows(list))
  }
  if (dedup.length === 0) {
    return { upserted: 0, tagLinks: 0, reindexed: 0, merged: [], contactsKept: 0, blanksIgnored: 0 }
  }

  // Never let a blank cell erase a value that is already in the database.
  // The upsert wrote the whole row object, so a re-import blanked internal_notes
  // whenever the Notes column was empty, nulled bank_paid_fee for every lender
  // that also appeared on the international sheet (which has no such column),
  // and wiped rate_notes unconditionally because the parser hardcodes it null.
  const names = dedup.map((r) => r.company_name)
  const existingByName = new Map<string, Record<string, unknown>>()
  for (let i = 0; i < names.length; i += 200) {
    const { data, error: lookupError } = await supabase
      .from('funding_sources')
      .select('*')
      .in('company_name', names.slice(i, i + 200))
    // Abort the whole import if this lookup fails. The error used to be dropped,
    // which left the map EMPTY, and an empty map makes the guard below preserve
    // NOTHING: every curated internal_notes / rate_notes / bank_paid_fee the
    // sheet leaves blank gets overwritten, and the summary still reads
    // `blanksIgnored: 0, upserted: N` — data destruction reported as a clean
    // import. No import is the safe outcome; the callers already handle a throw
    // (the API route records the file as failed, the CLI scripts exit non-zero).
    if (lookupError || !data) {
      throw new Error(
        `funding_sources existing-row lookup: ${lookupError?.message ?? 'no rows returned'} ` +
          `— aborting so blank cells cannot overwrite curated data`,
      )
    }
    for (const row of data as Array<Record<string, unknown>>) {
      existingByName.set(String(row.company_name), row)
    }
  }
  let blanksIgnored = 0
  const payload = dedup.map((r) => {
    const prior = existingByName.get(r.company_name)
    if (!prior) return r
    const out: Record<string, unknown> = { ...r }
    for (const [k, v] of Object.entries(out)) {
      if (k === 'company_name') continue
      const incomingBlank =
        v === null || v === undefined || (typeof v === 'string' && v.trim() === '') ||
        (Array.isArray(v) && v.length === 0)
      const priorHas =
        prior[k] !== null && prior[k] !== undefined &&
        !(typeof prior[k] === 'string' && (prior[k] as string).trim() === '') &&
        !(Array.isArray(prior[k]) && (prior[k] as unknown[]).length === 0)
      if (incomingBlank && priorHas) {
        delete out[k]
        blanksIgnored += 1
      }
    }
    return out as unknown as ParsedFundingRow
  })

  // A row whose `internal_notes` this import rewrites must lose its
  // `note_signals`, for the same reason the PATCH route clears them: the signals
  // are read out of the notes, and a signal quoting a sentence that is no longer
  // in the record keeps reordering the shortlist off text nobody can see. Absent
  // is the honest state; scripts/extract-note-signals.ts refills it.
  //
  // It does not self-heal if skipped — the reader's change-detector compares a
  // fingerprint of the current notes, and a row carrying signals from the OLD
  // notes with no marker of that fact is indistinguishable from an up-to-date one.
  const payloadWithSignals = payload.map((row) =>
    'internal_notes' in row ? { ...row, note_signals: null } : row,
  )

  const { data: inserted, error } = await supabase
    .from('funding_sources')
    .upsert(payloadWithSignals, { onConflict: 'company_name' })
    .select('*')
  if (error) throw new Error(`funding_sources upsert: ${error.message}`)

  // Ensure tags exist
  const tagNames = new Set(tags.map((t) => t.tag))
  const tagRows = [...tagNames].map((name) => ({
    name,
    color: ROSTER_TAG_COLORS[name] ?? 'slate',
    semantic: 'auto-imported from roster spreadsheet',
  }))
  if (tagRows.length) {
    await supabase.from('tag').upsert(tagRows, { onConflict: 'name' })
  }
  const { data: tagIdRows } = await supabase.from('tag').select('id, name')
  const tagIdByName = new Map(
    (tagIdRows ?? []).map((t: { id: string; name: string }) => [t.name, t.id]),
  )

  const idByCompany = new Map(
    (inserted ?? []).map((r: { id: string; company_name: string }) => [r.company_name, r.id]),
  )
  const links = tags
    .map((t) => {
      const fsId = idByCompany.get(t.company_name)
      const tagId = tagIdByName.get(t.tag)
      return fsId && tagId ? { funding_source_id: fsId, tag_id: tagId } : null
    })
    .filter((x): x is { funding_source_id: string; tag_id: string } => x !== null)
  if (links.length) {
    await supabase
      .from('funding_source_tag')
      .upsert(links, { onConflict: 'funding_source_id,tag_id', ignoreDuplicates: true })
  }

  // Re-index for AI search (embeddings + graph). Best-effort.
  let reindexed = 0
  if (opts.reindex !== false) {
    for (const row of inserted ?? []) {
      try {
        await indexFundingSource(
          supabase,
          row as unknown as Parameters<typeof indexFundingSource>[1],
        )
        await indexGraphForFundingSource(
          supabase,
          row as unknown as Parameters<typeof indexGraphForFundingSource>[1],
          { augment: false },
        )
        reindexed += 1
      } catch (e) {
        console.warn(`reindex ${row.company_name} failed: ${(e as Error).message}`)
      }
    }
  }

  // Preserve every additional contact the sheets carried. The sheets are
  // contact-level (Domestic even has First Name / Last Name columns beside Main
  // Contact); the index is company-level. funding_source_contacts was built for
  // exactly this and had sat empty since it was created.
  let contactsKept = 0
  const extraContacts: Array<{
    funding_source_id: string
    name: string | null
    email: string | null
  }> = []
  for (const [company, list] of byCompany) {
    if (list.length < 2) continue
    const fsId = idByCompany.get(company)
    if (!fsId) continue
    const primaryEmail = (list[0].primary_contact_email ?? '').toLowerCase()
    const seen = new Set<string>([primaryEmail])
    for (const r of list.slice(1)) {
      const key = (r.primary_contact_email ?? r.primary_contact_name ?? '').toLowerCase()
      if (!key || seen.has(key)) continue
      seen.add(key)
      extraContacts.push({
        funding_source_id: fsId,
        name: r.primary_contact_name ?? null,
        email: r.primary_contact_email ?? null,
      })
    }
  }
  if (extraContacts.length) {
    const { error: cErr } = await supabase.from('funding_source_contacts').insert(extraContacts)
    if (!cErr) contactsKept = extraContacts.length
    else console.warn(`funding_source_contacts insert: ${cErr.message}`)
  }

  return {
    upserted: inserted?.length ?? 0,
    tagLinks: links.length,
    reindexed,
    merged,
    contactsKept,
    blanksIgnored,
  }
}

/**
 * Fold several sheet rows for the same company into one record.
 *
 * First non-blank value wins per field, so a later row can only ADD information.
 * Last-wins was the old behaviour and it silently replaced a complete row with a
 * sparser one whenever the sparser row happened to come second.
 */
export function mergeRows(list: ParsedFundingRow[]): ParsedFundingRow {
  if (list.length === 1) return list[0]
  const out = { ...list[0] } as Record<string, unknown>
  for (const r of list.slice(1)) {
    for (const [k, v] of Object.entries(r)) {
      const cur = out[k]
      const curBlank =
        cur === null || cur === undefined ||
        (typeof cur === 'string' && cur.trim() === '') ||
        (Array.isArray(cur) && cur.length === 0)
      const incomingHas =
        v !== null && v !== undefined &&
        !(typeof v === 'string' && v.trim() === '') &&
        !(Array.isArray(v) && (v as unknown[]).length === 0)
      if (curBlank && incomingHas) out[k] = v
    }
  }
  return out as unknown as ParsedFundingRow
}
