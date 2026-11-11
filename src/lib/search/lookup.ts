/**
 * Where a bare query goes when it states no deal criteria.
 *
 * The name lookup answers a bare company name with that company, instead of
 * that company followed by a tail of unrelated lenders. It
 * short-circuits whenever the sentence states nothing and the text matches
 * `company_name` — and that guard is too loose for one word in particular.
 *
 * `bank` matches about half the company names in a typical roster. So typing
 * a lender kind by name — "Bank" — produced a NAME
 * lookup: a page headed "Lenders whose name matches "bank"", capped at the
 * display limit, and missing every bank whose name does not contain the word. Right question, wrong
 * answer, presented authoritatively.
 *
 * Two guards, in order:
 *
 *   1. A bare query that IS a controlled-vocabulary lender kind is a request
 *      for that kind. Exact match against `LENDER_TYPE_CHOICES`, no inference —
 *      so it may drive the hard-excluding lender-type dimension safely.
 *   2. Otherwise a name lookup only answers when the match set is SPECIFIC. A
 *      term matching a large share of the roster is a browse, not a lookup, and
 *      should fall through to the normal ranked pipeline.
 */

import { LENDER_TYPE_CHOICES } from '@/lib/funding-sources/vocabularies'

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

/**
 * Extra spellings of the four stored kinds. These are exact alternate names for
 * the same controlled value, not fuzzy matching: `canonLenderType` already
 * folds them, and every entry here resolves to one stored vocabulary value.
 */
const KIND_ALIASES: Record<string, string> = {
  banks: 'Bank',
  'credit unions': 'Credit Union',
  nonbank: 'Non Bank',
  nonbanks: 'Non Bank',
  'non banks': 'Non Bank',
  'private equity funds': 'Private Equity',
  'pe funds': 'Private Equity',
}

/**
 * The whole query is the name of a lender KIND → the stored vocabulary value.
 *
 * Deliberately requires the ENTIRE query to be the kind. "Castor Bank" and
 * "Bank of the Nashira" are lender names and must still reach the name lookup;
 * only a query that is nothing but the kind is a request for the category.
 */
export function bareLenderKind(q: string): string | null {
  const s = norm(q)
  if (!s) return null
  for (const [stored] of LENDER_TYPE_CHOICES) {
    if (norm(stored) === s) return stored
  }
  return KIND_ALIASES[s] ?? null
}

/**
 * A name lookup claims "these are the lenders called X". It is only entitled to
 * that claim when X identifies a specific few. Above a share of the roster the
 * term is a common word rather than a name, and the ranked pipeline — which
 * reads notes, geography and asset classes as well — is the better answer.
 *
 * Ratio rather than a constant so the rule survives the roster growing; the
 * floor keeps small rosters usable while staff are actively adding records.
 */
export const NAME_LOOKUP_MAX_SHARE = 0.1
export const NAME_LOOKUP_MIN_HITS = 20

export function nameLookupIsSpecific(matchCount: number, rosterCount: number): boolean {
  if (matchCount <= 0) return false
  const ceiling = Math.max(NAME_LOOKUP_MIN_HITS, Math.floor(rosterCount * NAME_LOOKUP_MAX_SHARE))
  return matchCount <= ceiling
}
