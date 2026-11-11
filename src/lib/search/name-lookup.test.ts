/**
 * Searching a lender's name returned that lender first, followed by a long
 * tail of unrelated lenders. A bare company name states no asset, geography or
 * size, so nothing hard-excludes and the output is raw RRF fusion.
 *
 * Looking a lender up by name is a different question from matching a deal, and
 * it has an exact answer. These pin the boundary: a name goes to the lookup, a
 * deal does not.
 */

import { describe, it, expect } from 'vitest'
import { extractDeal } from '@/lib/search/extract-deal'

/** Mirrors the guard in run.ts: a name lookup runs only when NOTHING was stated. */
function statesDealCriteria(q: string): boolean {
  const e = extractDeal(q)
  return (
    e.asset_classes.length > 0 ||
    e.geographic_scope.length > 0 ||
    e.deal_size_min_usd !== null ||
    e.deal_size_max_usd !== null ||
    e.intl_required ||
    (e.usage_codes ?? []).length > 0 ||
    Boolean(e.operation_category) ||
    Boolean(e.lender_type_required) ||
    (e.asset_year ?? null) !== null
  )
}

describe('a bare lender name is a lookup, not a deal', () => {
  it('states no deal criteria, so the lookup path is eligible', () => {
    for (const q of ['Rigel', 'Castor Bank', 'Vega Leasing', 'Pollux']) {
      expect(statesDealCriteria(q)).toBe(false)
    }
  })
})

describe('a real deal never becomes a name lookup', () => {
  it('is disqualified as soon as anything is stated', () => {
    for (const q of [
      'construction equipment financing in Texas around $8M',
      'tractor in Brazil',
      'an excavator under $5M',
      'credit unions for an MRI scanner',
      '2005 Caterpillar 320',
      'financiamento de equipamento no Brasil',
    ]) {
      expect(statesDealCriteria(q)).toBe(true)
    }
  })
})
