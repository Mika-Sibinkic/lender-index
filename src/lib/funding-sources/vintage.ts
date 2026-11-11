/**
 * Vintage-restriction options for the intake card.
 *
 * Vintage Restriction needs yearly increments. The list shipped with 5-year
 * steps (1980, 1985, …), so a lender whose real cutoff is "2003 or newer"
 * could not be recorded accurately — and under the accuracy mandate an
 * approximated cutoff is a wrong record, not a rounding.
 *
 * Newest year first so the common values (recent cutoffs) sit at the top of the
 * list rather than after fifty scrolls. Every previously-selectable value is
 * still in the list, so existing rows keep matching an option and no data
 * migration is needed.
 */

import { ASSET_AGE } from '@/lib/config/domain'

export const VINTAGE_NO_RESTRICTION = 'No restriction'

/** Oldest cutoff worth offering — from ASSET_AGE in src/lib/config/vocabulary.ts. */
export const VINTAGE_OLDEST_YEAR = ASSET_AGE.oldestYear

export function vintageYears(currentYear: number): number[] {
  const years: number[] = []
  for (let y = currentYear; y >= VINTAGE_OLDEST_YEAR; y--) years.push(y)
  return years
}

/** Canonical stored label for a year cutoff. */
export const vintageLabel = (year: number): string => `${year} or newer`

export function vintageOptions(currentYear: number): string[] {
  return [VINTAGE_NO_RESTRICTION, ...vintageYears(currentYear).map(vintageLabel)]
}

/**
 * What a lender's `vintage_restriction` cell actually says.
 *
 * The column is free text and holds two different shapes, because it predates
 * the intake picker above. Both shapes occur in real roster data:
 *
 *   "20 Years" / "15 Years" / "30 years"   → a maximum asset AGE
 *   "2003 or newer"                        → an earliest model YEAR (picker output)
 *   "None" / "N/A" / blank                 → no restriction / unknown
 *
 * `unknown` is returned for anything that parses as neither. It is deliberately
 * distinct from `none`: unknown must never exclude a lender, because a cell we
 * cannot read is not a stated criterion.
 */
export type VintageRule =
  | { kind: 'none' }
  | { kind: 'unknown'; raw: string }
  | { kind: 'max_age'; years: number }
  | { kind: 'min_year'; year: number }

const NO_RESTRICTION_WORDS = new Set(['none', 'n/a', 'na', 'no', 'no restriction', 'any', '-', '—'])

export function parseVintageRule(cell: string | null | undefined): VintageRule {
  const raw = (cell ?? '').trim()
  if (!raw) return { kind: 'none' }
  const s = raw.toLowerCase().replace(/\s+/g, ' ').trim()
  if (NO_RESTRICTION_WORDS.has(s)) return { kind: 'none' }

  // "2003 or newer", "2003+", "newer than 2003", or a bare 4-digit year.
  const year = s.match(/\b(19|20)\d{2}\b/)
  const age = s.match(/\b(\d{1,2})\s*(?:\+\s*)?(?:yr|yrs|year|years)\b/)

  // Order matters: "20 years" must not be read as a year, and "2003 or newer"
  // has no age token, so checking age first is safe and unambiguous.
  if (age) {
    const n = Number(age[1])
    if (n > 0 && n <= 99) return { kind: 'max_age', years: n }
  }
  if (year) {
    const n = Number(year[0])
    if (n >= VINTAGE_OLDEST_YEAR && n <= 2100) return { kind: 'min_year', year: n }
  }
  return { kind: 'unknown', raw }
}

/**
 * The earliest model year this lender will finance, given the year the deal is
 * being written in. `null` means "no stated limit" — including the unknown case,
 * which must be treated as no limit rather than guessed into one.
 */
export function oldestYearAllowed(rule: VintageRule, currentYear: number): number | null {
  switch (rule.kind) {
    case 'max_age':
      return currentYear - rule.years
    case 'min_year':
      return rule.year
    default:
      return null
  }
}

/** Human phrasing for a rule, for the record card and the fit chip. */
export function vintageRuleLabel(rule: VintageRule, currentYear: number): string {
  switch (rule.kind) {
    case 'none':
      return 'No age restriction'
    case 'max_age':
      return `Up to ${rule.years} years old (${currentYear - rule.years} or newer)`
    case 'min_year':
      return vintageLabel(rule.year)
    case 'unknown':
      return rule.raw
  }
}
