/**
 * Proactive lender de-duplication — the "is this already in the list?" check.
 *
 * Fires ONCE, on submit, at high precision: a normalized-exact
 * company-name match (or an exact primary-contact email match) SUGGESTS an
 * existing lender so the operator can update it in place instead of creating a
 * duplicate. It only ever suggests — the human confirms update-vs-create, and
 * merge never blanks a populated field. No fuzzy guessing (that risks a
 * wrong-match, which the accuracy mandate forbids).
 */

import { isFieldFilled } from '@/lib/funding-sources/required-fields'

/** Trailing legal-entity suffixes safe to strip. Deliberately conservative —
 *  industry words (bank / capital / financial / leasing) are NOT stripped, so
 *  "Apple Bank" never collides with "Apple Capital" (no wrong match). */
const LEGAL_SUFFIXES = new Set([
  'inc', 'llc', 'ltd', 'limited', 'corp', 'corporation', 'co', 'company',
  'plc', 'lp', 'llp', 'pllc', 'na', 'sa', 'gmbh', 'ag', 'nv', 'bv',
])

/**
 * Normalize a company name for equality: lowercase, punctuation → space,
 * collapse whitespace, drop trailing legal-suffix tokens ("AlkaidBank, N.A." →
 * "alkaidbank", "Markab Group Ltd" → "markab group").
 */
export function normalizeCompanyName(name: string): string {
  const base = (name ?? '')
    .toLowerCase()
    .replace(/['.]/g, '') // drop periods + apostrophes so "N.A." → "na", not "n a"
    .replace(/[^a-z0-9]+/g, ' ') // every other non-alphanumeric → space
    .replace(/\s+/g, ' ')
    .trim()
  if (!base) return ''
  const tokens = base.split(' ')
  while (tokens.length > 1 && LEGAL_SUFFIXES.has(tokens[tokens.length - 1])) {
    tokens.pop()
  }
  return tokens.join(' ')
}

// Generic words that don't distinguish two firms — ignored when deciding whether
// an email match is plausibly the SAME company (so "Eagle Capital" and "Falcon
// Capital Partners" don't count as related just because both say "capital").
const GENERIC_NAME_TOKENS = new Set([
  'capital', 'group', 'partners', 'partner', 'financial', 'finance', 'bank',
  'leasing', 'holdings', 'holding', 'company',
  'credit', 'union', 'equity', 'lending', 'funding', 'fund',
])

function meaningfulTokens(name: string): Set<string> {
  return new Set(
    normalizeCompanyName(name)
      .split(' ')
      .filter((t) => t.length >= 3 && !GENERIC_NAME_TOKENS.has(t)),
  )
}

/**
 * True when two names plausibly belong to the SAME company — used to gate the
 * email-fallback match. Exact/substring on the normalized name, or a shared
 * distinctive (non-generic) token. A shared broker/desk email between two
 * unrelated firms is therefore NOT enough to steer a dedup update.
 */
function namesCompatible(a: string, b: string): boolean {
  const na = normalizeCompanyName(a)
  const nb = normalizeCompanyName(b)
  if (!na || !nb) return false
  if (na === nb || na.includes(nb) || nb.includes(na)) return true
  const ta = meaningfulTokens(a)
  const tb = meaningfulTokens(b)
  for (const t of ta) if (tb.has(t)) return true
  return false
}

export interface MatchCandidate {
  id: string
  company_name: string
  primary_contact_email?: string | null
}

export interface LenderMatch {
  id: string
  company_name: string
  /** 1.0 = normalized-name exact; 0.9 = email exact (name differed). */
  score: number
  matched_on: 'company_name' | 'email'
}

/**
 * Find a definitive existing-lender match. Name match wins (score 1.0); an exact
 * email match is the fallback (0.9). Returns the first/best match or null —
 * never a fuzzy near-miss.
 */
export function findLenderMatch(
  input: { company_name: string; primary_contact_email?: string | null },
  candidates: MatchCandidate[],
): LenderMatch | null {
  const key = normalizeCompanyName(input.company_name)
  if (key) {
    const byName = candidates.find((c) => normalizeCompanyName(c.company_name) === key)
    if (byName) {
      return { id: byName.id, company_name: byName.company_name, score: 1, matched_on: 'company_name' }
    }
  }
  const email = (input.primary_contact_email ?? '').trim().toLowerCase()
  if (email) {
    const byEmail = candidates.find(
      (c) => (c.primary_contact_email ?? '').trim().toLowerCase() === email,
    )
    // Only accept an email match if the names are plausibly the same company —
    // a shared broker/desk email between two different firms must not steer a
    // dedup update onto the wrong record.
    if (byEmail && namesCompatible(input.company_name, byEmail.company_name)) {
      return { id: byEmail.id, company_name: byEmail.company_name, score: 0.9, matched_on: 'email' }
    }
  }
  return null
}

/**
 * Merge semantics for update-in-place: keep only incoming fields that are
 * non-empty. A blank incoming value NEVER overwrites an existing value
 * ("blank = unknown", accuracy mandate) — so an update can only add/replace
 * with real data, never erase.
 */
export function mergeNonEmpty(
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(incoming)) {
    if (isFieldFilled(v)) out[k] = v
  }
  return out
}

/**
 * Gap-fill patch for the local spreadsheet-enrich pass: keep only incoming
 * values that are non-empty AND whose existing DB field is EMPTY. This fills
 * blanks from the verified spreadsheet without ever clobbering a populated
 * (possibly hand-curated) value — "fill fields, don't overwrite".
 */
export function computeGapFill(
  before: Record<string, unknown>,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(incoming)) {
    if (isFieldFilled(v) && !isFieldFilled(before[k])) out[k] = v
  }
  return out
}

export interface FieldChange {
  key: string
  from: unknown
  to: unknown
}

/**
 * Per-field diff shown before an update-in-place write ("what changes"). Only
 * lists fields where a non-empty incoming value actually differs from the
 * existing one — the operator confirms these before any PATCH.
 */
export function computeFieldChanges(
  before: Record<string, unknown>,
  incoming: Record<string, unknown>,
): FieldChange[] {
  const merged = mergeNonEmpty(incoming)
  const changes: FieldChange[] = []
  for (const [k, to] of Object.entries(merged)) {
    const from = before[k]
    if (JSON.stringify(from ?? null) !== JSON.stringify(to ?? null)) {
      changes.push({ key: k, from: from ?? null, to })
    }
  }
  return changes
}
