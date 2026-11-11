/**
 * Past-deal extractor. Pulls structured fields out of a term sheet,
 * proposal letter, or signed loan doc PDF text and maps them to the
 * closed_deal row shape.
 *
 * Uses llm.object via the unified client so the same code path runs in
 * cloud (AI Gateway) and on the on-prem box (local OpenAI-compatible).
 */

import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { llm } from '@/lib/llm/client'
import { DOMAIN_DESCRIPTION, promptMakes } from '@/lib/config/domain'
import { ORG_NAME } from '@/lib/config/org'

export const ClosedDealExtractSchema = z.object({
  asset_year: z.number().int().nullable(),
  asset_make: z.string().nullable(),
  asset_model: z.string().nullable(),
  loan_amount_usd: z.number().nullable(),
  purchase_price_usd: z.number().nullable(),
  rate_pct: z.number().nullable(),
  ltv_pct: z.number().nullable(),
  prepayment_penalty: z.string().nullable(),
  fees: z.record(z.string(), z.any()).nullable(),
  // Deliberately NO .regex() here. The on-prem backend compiles this schema into
  // a GBNF grammar to constrain decoding, and it mistranslates a regex: given
  // /^\d{4}-\d{2}-\d{2}$/ it emitted the literal string "\dddd-\dd-\dd" on a short
  // prompt, and on a real document the grammar blew up and killed the model runner
  // ("model runner has unexpectedly stopped"). That is why Past Deals import
  // never once succeeded while the regex was here. The shape is enforced
  // after extraction by normalizeClosedOn instead, which also salvages a date the
  // model returns in another format rather than failing the whole import.
  closed_on: z.string().nullable(),
  bank_name: z.string().nullable(),
})
export type ClosedDealExtract = z.infer<typeof ClosedDealExtractSchema>

/**
 * Coerce whatever the model returned into YYYY-MM-DD, or null.
 *
 * Day-first is the default for anything ambiguous: deal flow that is
 * Brazilian or European writes 05/06/2026 for 5 June. Guessing US order on a
 * Brazilian term sheet silently books the wrong close date, and a wrong date on
 * a past deal skews the past-deal boost in search.
 */
export function normalizeClosedOn(raw: string | null | undefined): string | null {
  if (!raw) return null
  const s = raw.trim()
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s)
  if (iso) return ymd(+iso[1], +iso[2], +iso[3])
  // d/m/y or d-m-y or d.m.y — day-first unless the first part can't be a day.
  const parts = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s)
  if (parts) {
    let [, a, b] = parts
    const year = +parts[3]
    let day = +a
    let month = +b
    if (day > 12 && month <= 12) {
      // unambiguous day-first, keep
    } else if (month > 12 && day <= 12) {
      ;[day, month] = [month, day] // it was month-first
    }
    return ymd(year, month, day)
  }
  return null
}

function ymd(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  const d = new Date(Date.UTC(year, month - 1, day))
  if (d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

const SYSTEM_PROMPT = `You extract structured records of past ${DOMAIN_DESCRIPTION} deals from supplied prose (term sheets, proposal letters, or signed loan documents).

Source text may be in any language. Translate values to English where helpful but keep proper nouns (company / person names) verbatim. Read localised number and date formats correctly: "1.500.000,00" is 1500000 and "31/05/2026" is 2026-05-31 (day-first outside the US).

Return ONLY a JSON object matching the provided schema. No prose, no markdown fences.

NOT STATED IS NOT A VALUE. If the document does not state a field, return null. Never
write "none", "N/A" or 0 to mean "the document didn't say" — those assert a fact. Only
say "none" when the document itself states the term is absent (e.g. "no prepayment
penalty"). A null is always safe; an invented value is a serious error. Never take a
value from a sheet tab name, a page header, a filename or a column label.

Conventions:
- Amounts in plain dollars: "$5MM" -> 5000000. Prefer a figure the document labels in
  USD; do not convert from another currency yourself.
- Rates as decimals: "8.25%" -> 8.25, "SOFR + 250" -> null (don't guess). An index rate
  (e.g. SOFR, EURIBOR, Prime) on its own is not the deal's rate — return null unless the document
  states the all-in contract rate.
- Dates as YYYY-MM-DD, and only a date the document gives. closed_on is the date the deal
  CLOSED — a quote, indicative sheet or proposal has no close date, so return null.
- asset_make: brand / manufacturer only (e.g. ${promptMakes()}).
- asset_model: bare model designator, without the make.
- bank_name: the lender / lessor from the letterhead or signature block. Not the broker,
  not the borrower, not ${ORG_NAME}.
- prepayment_penalty: terse description ("3% Y1, 2% Y2, 1% Y3", or "none" only if stated).
- fees: JSON object keyed by fee type (e.g. { "origination": 0.005, "doc": 1500 }), or
  null if the document lists no fees.`

export async function extractClosedDeal(
  supabase: SupabaseClient,
  text: string,
): Promise<ClosedDealExtract> {
  const { object } = await llm.object<ClosedDealExtract>({
    supabase,
    module: 'closed_deal_extract',
    schema: ClosedDealExtractSchema,
    system: SYSTEM_PROMPT,
    prompt: text.slice(0, 50_000),
  })
  return {
    ...object,
    asset_make: blankToNull(object.asset_make),
    asset_model: blankToNull(object.asset_model),
    bank_name: blankToNull(object.bank_name),
    prepayment_penalty: blankToNull(object.prepayment_penalty, { keepNone: true }),
    fees: object.fees && Object.keys(object.fees).length > 0 ? object.fees : null,
    closed_on: normalizeClosedOn(object.closed_on),
  }
}

/**
 * Collapse the placeholders models reach for when a field isn't in the document.
 * "N/A" or "unknown" in a lender name reads as data downstream and gets indexed;
 * null reads as a gap the intake card asks a human to fill.
 *
 * `keepNone` guards prepayment_penalty, where "none" is a real answer meaning the
 * document states there is no penalty — the prompt is what keeps that honest.
 */
export function blankToNull(
  raw: string | null | undefined,
  opts: { keepNone?: boolean } = {},
): string | null {
  if (raw == null) return null
  const s = raw.trim()
  if (s === '') return null
  const placeholders = ['n/a', 'na', 'unknown', 'not specified', 'not stated', 'not provided', 'tbd', '-', '—', 'null', 'undefined']
  if (!opts.keepNone) placeholders.push('none', 'no', 'nil')
  return placeholders.includes(s.toLowerCase()) ? null : s
}

/**
 * Why a bank name did or did not resolve to a lender.
 *
 * All four null cases used to be the same bare null, so a deal filed with
 * funding_source_id null could equally mean "the document names no lender",
 * "that lender isn't in the index yet", "two lenders match and guessing one is
 * forbidden", or "the lookup itself failed". Only the first three are a clean
 * import, and the operator has a different next action for each.
 */
export type FundingSourceResolution =
  | { id: string; reason: 'exact' | 'unique_substring' }
  | {
      id: null
      reason: 'no_bank_name' | 'not_found' | 'ambiguous' | 'lookup_failed'
      detail?: string
    }

/**
 * Bank → funding_source matcher under the accuracy-first mandate
 * (no wrong lender, ever — a mislinked closed deal is a fireable error).
 *
 * Two passes, exact wins:
 *   1. Exact, case-insensitive, whitespace-trimmed match on company_name
 *      (ILIKE with the literal name, no wildcards). One row → that id.
 *   2. Fallback substring ILIKE. Exactly ONE candidate → return it.
 *      Zero or MULTIPLE candidates → return null (never guess which lender).
 *
 * Returning null leaves funding_source_id unset rather than linking the
 * deal to the wrong lender; a human confirms the association instead.
 */
export async function resolveFundingSourceIdDetailed(
  supabase: SupabaseClient,
  bankName: string | null,
): Promise<FundingSourceResolution> {
  if (!bankName) return { id: null, reason: 'no_bank_name' }
  const trimmed = bankName.trim()
  if (!trimmed) return { id: null, reason: 'no_bank_name' }
  // Escape ILIKE metacharacters so a literal % or _ in the name can't widen
  // the match. Cap length to keep the query bounded.
  const escaped = trimmed.replace(/[%_\\]/g, '\\$&').slice(0, 100)

  // Pass 1: exact (case-insensitive, trimmed) — ILIKE without wildcards.
  const exact = await supabase
    .from('funding_sources')
    .select('id')
    .ilike('company_name', escaped)
    .limit(1)
    .maybeSingle()
  // A query that errored says nothing about whether this lender is in the index.
  // Falling through on it would turn "could not check" into "not found" and file
  // the deal unlinked.
  if (exact.error) return { id: null, reason: 'lookup_failed', detail: exact.error.message }
  if (exact.data?.id) return { id: exact.data.id, reason: 'exact' }

  // Pass 2: substring fallback. Pull two rows so we can detect ambiguity;
  // only a single unambiguous candidate is allowed to link.
  const fuzzy = await supabase
    .from('funding_sources')
    .select('id')
    .ilike('company_name', `%${escaped}%`)
    .limit(2)
  if (fuzzy.error) return { id: null, reason: 'lookup_failed', detail: fuzzy.error.message }
  const rows = fuzzy.data ?? []
  if (rows.length === 1) return { id: rows[0].id, reason: 'unique_substring' }
  return { id: null, reason: rows.length > 1 ? 'ambiguous' : 'not_found' }
}

/**
 * String-only wrapper for callers that just want the id.
 *
 * `not_found` / `ambiguous` / `no_bank_name` still return null — that is the
 * deliberate no-wrong-lender behaviour above. A `lookup_failed` throws instead:
 * this signature has no channel for "we could not check", and returning null
 * there reads as "that lender isn't in the index", which saves the deal with
 * funding_source_id null (invisible to the past-deal boost) under a
 * "Past deal imported" toast. Use resolveFundingSourceIdDetailed to tell the
 * operator which of the other three happened.
 */
export async function resolveFundingSourceId(
  supabase: SupabaseClient,
  bankName: string | null,
): Promise<string | null> {
  const resolution = await resolveFundingSourceIdDetailed(supabase, bankName)
  if (resolution.reason === 'lookup_failed') {
    throw new Error(
      `funding_sources lookup for "${bankName}": ${resolution.detail ?? 'query failed'}`,
    )
  }
  return resolution.id
}
