/**
 * LLM-backed funding-source extractor.
 *
 * Strategy:
 *  1. Send raw text (and/or image) to NIM with a strict JSON schema instruction.
 *  2. Parse the response into our schema.
 *  3. Merge with regex fallback for fields the LLM missed (belt + suspenders).
 *  4. Return parsed + provenance for closed-loop logging.
 */

import type { FundingSourceCreate } from '@/lib/types/funding-source'
import { ASSET_CLASSES } from '@/lib/types/funding-source'
import {
  ASSET_SUBTYPES,
  DOMAIN_DESCRIPTION,
  OPERATION_CATEGORIES,
  USAGE_CODES,
  promptAssetExamples,
  promptMakes,
  promptParentIds,
} from '@/lib/config/domain'
import { nimChat, type NimMessage } from '@/lib/parse/nim'
import { localChatText, isStrictPrivacyMode } from '@/lib/parse/local-extract'
import { quickExtract } from '@/lib/parse/quick-extract'
import type { SupabaseClient } from '@supabase/supabase-js'

export type AiParseResult = {
  parsed: Partial<FundingSourceCreate>
  provider: string
  model: string
  rawResponse: string
  latencyMs: number
  promptTokens: number
  completionTokens: number
  fallbackUsed: boolean
}

/**
 * Exported so the warmup cron can prime Ollama's KV cache with this exact
 * prefix. An identical system prompt makes the next parse much faster than
 * cold, entirely from prefix reuse. A cold parse on a small model can approach
 * a reverse proxy's ~120s request timeout, so priming this keeps document
 * intake under it. Any edit here invalidates that cache once; that is fine,
 * the next warmup re-primes it.
 */
export const SYSTEM_PROMPT = `You extract structured funding-source records from prose for a ${DOMAIN_DESCRIPTION} brokerage.

You will receive prose (email body, term sheet text, business-card OCR, or hand-typed notes). Source text may be in any language — translate values to English where helpful but keep proper nouns (company / person names) verbatim. Return ONLY a JSON object matching this schema. No prose. No markdown fences.

Schema (all fields optional except company_name):
{
  "company_name": string,                      // legal entity name
  "primary_contact_name": string | null,       // full name of primary person
  "primary_contact_title": string | null,      // job title incl. division ("SVP, Specialty Originations")
  "primary_contact_email": string | null,
  "primary_contact_phone": string | null,      // best-format with country code if known
  "primary_contact_calendar_link": string | null,
  "asset_classes": string[],                   // subset of: ${ASSET_CLASSES.join(', ')}
  "deal_size_min_usd": number | null,          // in plain dollars; "$5MM" -> 5000000
  "deal_size_max_usd": number | null,
  "borrower_revenue_min_usd": number | null,
  "borrower_years_in_business_min": number | null,
  "borrower_capex_min_usd": number | null,
  "required_documents": string[],              // e.g. ["audited_financials_3yr","tax_returns_2yr","fixed_asset_list","equipment_list"]
  "geographic_scope": string[],                // e.g. ["US","Canada"]
  "industry_filters": string[],                // e.g. ["logistics","construction","healthcare","agriculture"]
  "lender_type": string | null,                // one of: "Bank", "Credit Union", "Non Bank", "Private Equity"
  "intl_domestic": string | null,              // one of: "International", "Domestic", "Both"
  "specific_geographic": string | null,        // free-text region detail beyond geographic_scope (e.g. "Southeast US only")
  "asset_subtypes": string[],                  // display taxonomy, subset of: ${ASSET_SUBTYPES.join(', ')}
  "usage_codes": string | null,                // comma-separated codes, subset of: ${USAGE_CODES.map((u) => `${u.code} (${u.label})`).join(', ')}
  "operation_category": string | null,         // one of: ${OPERATION_CATEGORIES.map((o) => `"${o.value}"`).join(', ')}
  "vintage_restriction": string | null,        // asset age/vintage limit, e.g. "no assets older than 20 years"
  "lending_status": string | null,             // current lending status / appetite, free text
  "bank_paid_fee": string | null,              // bank-paid broker fee — "Y", "N", or a percentage
  "rate_notes": string | null,                 // pricing commentary
  "internal_notes": string | null,             // anything noteworthy that doesn't fit elsewhere
  "introduced_via": string | null,             // referral source, conference name
  "introduced_date": string | null             // ISO date YYYY-MM-DD if mentioned
}

Rules:
- Use null for fields you cannot determine. Never invent.
- For amounts: convert "$5M"/"$5MM"/"5 million" to 5000000. Convert "$500k" to 500000.
- Currency: if the document states a USD amount (e.g. "Amount (USD) = 1,500,000"), use it for deal_size. If ONLY a non-USD amount is given (R$/BRL/€/MXN/etc.) with no stated USD value or exchange rate, record the amount + currency in internal_notes and leave deal_size_*_usd null — NEVER guess an exchange rate (a wrong number is a firing-level error).
- Filename hint: a leading "Filename:" line may name the asset when the body doesn't — e.g. ${promptAssetExamples().map((e) => `"${e.word}" = ${e.label}`).join('; ')}; a make such as ${promptMakes(2)} names the asset too. Use it to set asset_classes ONLY when the asset is otherwise unstated.
- For ranges: split into min/max.
- For asset_classes: include a category ONLY if the document explicitly names that asset type (e.g. ${promptAssetExamples().map((e) => `"${e.word}"`).join(', ')}). NEVER infer, guess, or add a category that is not stated — a wrong asset class is a firing-level error.${promptParentIds() ? ` Use a generic parent (${promptParentIds()}) only when the text names the generic kind with no specific type.` : ''}
- asset_subtypes is the spreadsheet display pick-list (${ASSET_SUBTYPES.join('/')}). Fill it only when the document states it; do not introduce values the document doesn't name. asset_classes drives search; asset_subtypes never does.
- intl_domestic: if the lender is limited to the US / lends "domestically" only → "Domestic"; if it explicitly serves outside the US → "International"; if it explicitly does both → "Both"; otherwise null.
- For coded fields (lender_type, intl_domestic, operation_category) return the full English value listed above, never a letter code. Use null if not stated. Never guess.
- bank_paid_fee: "Y"/"N" for yes/no, or the percentage string if a number is given.
- For required_documents: normalize to snake_case (e.g. "3 years audited financials" -> "audited_financials_3yr").
- If the prose mentions filtering to/excluding asset types, still extract — the system handles that filter elsewhere.
- Company name disambiguation: prefer the legal entity from the signature block. If the email domain is not generic (gmail/yahoo/etc), use the capitalized domain as a hint.
- For the primary contact, prefer the signature block. If multiple people are named, pick the one whose contact details (email/phone) are present.

Return JSON only.`

function safeJsonParse(text: string): Record<string, unknown> | null {
  // Strip code fences if present
  const stripped = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim()
  try {
    return JSON.parse(stripped)
  } catch {
    // Try to find a JSON object inside
    const match = stripped.match(/\{[\s\S]*\}/)
    if (!match) return null
    try {
      return JSON.parse(match[0])
    } catch {
      return null
    }
  }
}

// Map a free value (full label OR the spreadsheet letter code) onto a canonical
// label. Returns undefined when it doesn't match — accuracy-first: never guess a
// controlled value into existence.
function mapControlled(
  v: unknown,
  canonical: readonly string[],
  aliases: Record<string, string>,
): string | undefined {
  if (typeof v !== 'string') return undefined
  const s = v.trim()
  if (!s) return undefined
  const lower = s.toLowerCase()
  const direct = canonical.find((c) => c.toLowerCase() === lower)
  if (direct) return direct
  const alias = aliases[lower]
  return alias
}

export function coerceToSchema(raw: Record<string, unknown>): Partial<FundingSourceCreate> {
  const out: Partial<FundingSourceCreate> = {}

  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim() ? v.trim() : undefined
  const num = (v: unknown): number | undefined => {
    if (typeof v === 'number' && !Number.isNaN(v)) return v
    if (typeof v === 'string') {
      const n = Number(v.replace(/[$,_]/g, ''))
      return Number.isNaN(n) ? undefined : n
    }
    return undefined
  }
  const arrOfStr = (v: unknown): string[] | undefined =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined
  const validAssetClasses = new Set<string>(ASSET_CLASSES)

  out.company_name = str(raw.company_name)
  out.primary_contact_name = str(raw.primary_contact_name)
  out.primary_contact_title = str(raw.primary_contact_title)
  out.primary_contact_email = str(raw.primary_contact_email)
  out.primary_contact_phone = str(raw.primary_contact_phone)
  out.primary_contact_calendar_link = str(raw.primary_contact_calendar_link)
  out.rate_notes = str(raw.rate_notes)
  out.internal_notes = str(raw.internal_notes)
  out.introduced_via = str(raw.introduced_via)
  const dateStr = str(raw.introduced_date)
  if (dateStr && /^\d{4}-\d{2}-\d{2}$/.test(dateStr)) out.introduced_date = dateStr

  out.deal_size_min_usd = num(raw.deal_size_min_usd)
  out.deal_size_max_usd = num(raw.deal_size_max_usd)
  out.borrower_revenue_min_usd = num(raw.borrower_revenue_min_usd)
  out.borrower_years_in_business_min = num(raw.borrower_years_in_business_min)
  out.borrower_capex_min_usd = num(raw.borrower_capex_min_usd)

  const normalizeAsset = (s: string) =>
    s.toLowerCase().trim().replace(/[-\s]+/g, '_')
  const ac = arrOfStr(raw.asset_classes)
  if (ac) {
    const normalized = ac.map(normalizeAsset).filter((c) => validAssetClasses.has(c))
    // Dedupe while preserving order
    out.asset_classes = [...new Set(normalized)]
  }
  const rd = arrOfStr(raw.required_documents)
  if (rd) out.required_documents = rd
  const gs = arrOfStr(raw.geographic_scope)
  if (gs) out.geographic_scope = gs
  const ifs = arrOfStr(raw.industry_filters)
  if (ifs) out.industry_filters = ifs

  // Spreadsheet template fields (migration 0017). Controlled fields accept the
  // full English label or the spreadsheet letter code; free-text fields pass
  // through. Anything unmatched stays undefined (kept blank for human review).
  out.lender_type = mapControlled(raw.lender_type, ['Bank', 'Credit Union', 'Non Bank', 'Private Equity'], {
    b: 'Bank',
    bank: 'Bank',
    c: 'Credit Union',
    cu: 'Credit Union',
    'credit union': 'Credit Union',
    nb: 'Non Bank',
    'non-bank': 'Non Bank',
    nonbank: 'Non Bank',
    pe: 'Private Equity',
    'private equity': 'Private Equity',
  })
  out.intl_domestic = mapControlled(raw.intl_domestic, ['International', 'Domestic', 'Both'], {
    i: 'International',
    intl: 'International',
    d: 'Domestic',
    dom: 'Domestic',
    'i/d': 'Both',
    'd/i': 'Both',
  })
  out.operation_category = mapControlled(
    raw.operation_category,
    OPERATION_CATEGORIES.map((o) => o.value),
    Object.fromEntries(OPERATION_CATEGORIES.map((o) => [o.label.toLowerCase(), o.value])),
  )
  out.specific_geographic = str(raw.specific_geographic)
  out.usage_codes = str(raw.usage_codes)
  out.vintage_restriction = str(raw.vintage_restriction)
  out.lending_status = str(raw.lending_status)
  out.bank_paid_fee = str(raw.bank_paid_fee)

  const at = arrOfStr(raw.asset_subtypes)
  if (at) {
    const normalized = at
      .map((x) => ASSET_SUBTYPES.find((t) => t.toLowerCase() === x.toLowerCase().trim()))
      .filter((t): t is string => Boolean(t))
    out.asset_subtypes = [...new Set<string>(normalized)]
  }

  return out
}

function mergePreferFirst<T extends Record<string, unknown>>(
  primary: Partial<T>,
  secondary: Partial<T>
): Partial<T> {
  const out: Partial<T> = { ...secondary }
  for (const [k, v] of Object.entries(primary)) {
    if (Array.isArray(v) && v.length > 0) (out as Record<string, unknown>)[k] = v
    else if (v !== null && v !== undefined && v !== '') (out as Record<string, unknown>)[k] = v
  }
  return out
}

export async function aiExtract(
  text: string,
  ctx?: { supabase: SupabaseClient; module?: string },
): Promise<AiParseResult> {
  const trimmed = text.trim()
  if (!trimmed) {
    return {
      parsed: {},
      provider: 'none',
      model: 'none',
      rawResponse: '',
      latencyMs: 0,
      promptTokens: 0,
      completionTokens: 0,
      fallbackUsed: false,
    }
  }

  const strict = isStrictPrivacyMode()
  // Strict (default) → 100% local Ollama. No cloud egress.
  // Relaxed → fall through to legacy NIM-direct path.
  const useLocal = strict && !!ctx?.supabase

  if (strict && !ctx?.supabase) {
    console.warn(
      'aiExtract called in strict privacy mode without supabase ctx — degrading to regex-only',
    )
    const reg = quickExtract(trimmed)
    return {
      parsed: reg.parsed,
      provider: 'regex-only',
      model: 'quick-extract',
      rawResponse: 'no supabase ctx, strict mode',
      latencyMs: 0,
      promptTokens: 0,
      completionTokens: 0,
      fallbackUsed: true,
    }
  }

  try {
    const r = useLocal
      ? await localChatText({
          system: SYSTEM_PROMPT,
          user: trimmed,
          supabase: ctx!.supabase,
          module: ctx?.module ?? 'parse.text.local',
        })
      : await nimChat({
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: trimmed },
          ] as NimMessage[],
          jsonMode: true,
          temperature: 0.1,
        })
    const json = safeJsonParse(r.text)
    if (!json) {
      // Treat parse failure as fallback
      const reg = quickExtract(trimmed)
      return {
        parsed: reg.parsed,
        provider: r.provider,
        model: r.model,
        rawResponse: r.text,
        latencyMs: r.latencyMs,
        promptTokens: r.promptTokens,
        completionTokens: r.completionTokens,
        fallbackUsed: true,
      }
    }
    const llmParsed = coerceToSchema(json)
    const regex = quickExtract(trimmed).parsed
    // Prefer LLM output; fill gaps with regex
    const merged = mergePreferFirst(llmParsed, regex)
    // Always preserve raw paste in internal_notes (with QUICK-ADD prefix)
    if (!merged.internal_notes || merged.internal_notes.trim().length < 10) {
      merged.internal_notes = `[QUICK-ADD] Pasted ${new Date()
        .toISOString()
        .slice(0, 10)}\n\n${trimmed.slice(0, 1500)}`
    }
    return {
      parsed: merged,
      provider: r.provider,
      model: r.model,
      rawResponse: r.text,
      latencyMs: r.latencyMs,
      promptTokens: r.promptTokens,
      completionTokens: r.completionTokens,
      fallbackUsed: false,
    }
  } catch (e) {
    // Full LLM failure → regex fallback. Caller decides whether to surface.
    const reg = quickExtract(trimmed)
    return {
      parsed: reg.parsed,
      provider: 'regex-fallback',
      model: 'quick-extract',
      rawResponse: e instanceof Error ? e.message : String(e),
      latencyMs: 0,
      promptTokens: 0,
      completionTokens: 0,
      fallbackUsed: true,
    }
  }
}
