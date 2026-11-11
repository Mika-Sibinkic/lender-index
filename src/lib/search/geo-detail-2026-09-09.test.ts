/**
 * A geography we cannot READ is unknown, not a mismatch.
 *
 * Earlier work made the matcher read `specific_geographic`, which had
 * been stored, displayed, exported and embedded but never filtered on. The
 * comment on `lenderGeoCells` claimed the change "can only ever ADD coverage —
 * it cannot make a lender look narrower than it is." That was wrong.
 *
 * A row with an empty `geographic_scope` used to reach geoDim's blank → unknown
 * → kept branch. Reading the detail cell makes the cell list non-empty, so the
 * blank branch stops firing and a value naming no recognisable place falls all
 * the way through to `contradict`. Active lenders whose only geography note is
 * the word "All" were hard-excluded from every geography-bearing search and
 * every State pick.
 *
 * "No wrong lender ever" runs in both directions: a lender that says it lends
 * everywhere must never be dropped from a shortlist.
 */

import { describe, it, expect } from 'vitest'
import { scoreFit, hasContradiction, type DealCriteria } from './structured-filter'

const NO: DealCriteria = {
  asset_classes: [],
  geographic_scope: [],
  deal_size_min_usd: null,
  deal_size_max_usd: null,
  intl_required: false,
}

describe('specific_geographic that names no place is kept, not excluded', () => {
  // Synthetic rows: empty scope, "All" in the detail cell.
  const BOTH_A = { geographic_scope: [], specific_geographic: 'All', intl_domestic: 'Both' }
  const DOMESTIC = { geographic_scope: [], specific_geographic: 'All', intl_domestic: 'Domestic' }
  const BOTH_B = { geographic_scope: [], specific_geographic: 'All', intl_domestic: 'Both' }

  it('survives a foreign deal geography', () => {
    for (const lender of [BOTH_A, BOTH_B]) {
      const v = scoreFit(lender, { ...NO, geographic_scope: ['Brazil'] })
      expect(v.geo).toBe('unknown')
      expect(hasContradiction(v)).toBe(false)
    }
  })

  it('survives a US deal geography', () => {
    const v = scoreFit(DOMESTIC, { ...NO, geographic_scope: ['Texas'] })
    expect(v.geo).toBe('unknown')
    expect(hasContradiction(v)).toBe(false)
  })

  it('survives a State facet pick', () => {
    const v = scoreFit(DOMESTIC, { ...NO, us_states: ['west virginia'] })
    expect(v.state).toBe('unknown')
    expect(hasContradiction(v)).toBe(false)
  })

  it('is UNKNOWN rather than MATCH — "All" is not read as confirmed coverage', () => {
    // Guessing an ambiguous word into a match would rank the lender as though
    // the record stated global coverage. Blank means unknown, never guessed.
    expect(scoreFit(BOTH_A, { ...NO, geographic_scope: ['Brazil'] }).geo).not.toBe('match')
  })

  it('covers the same shape in the source data — an asset class in the geo column', () => {
    // Societe Sceptrum imported as ["International","Equipment"]. Already
    // handled by the international branch; pinned so the general rule holds.
    const v = scoreFit(
      { geographic_scope: ['International', 'Equipment'] },
      { ...NO, geographic_scope: ['Brazil'] },
    )
    expect(hasContradiction(v)).toBe(false)
  })
})

describe('the M7 benefit is preserved — a real detail cell still filters', () => {
  it('a lender listing its states is still held to them', () => {
    // geographic_scope empty, specific_geographic lists states. This is what
    // reading the detail cell was FOR, and it must keep working.
    const castor = {
      geographic_scope: [],
      specific_geographic: 'FL, GA, NC, SC',
    }
    expect(scoreFit(castor, { ...NO, us_states: ['florida'] }).state).toBe('match')
    expect(scoreFit(castor, { ...NO, us_states: ['oregon'] }).state).toBe('contradict')
  })

  it('a foreign-only lender still contradicts a US deal', () => {
    const v = scoreFit(
      { geographic_scope: [], specific_geographic: 'France' },
      { ...NO, geographic_scope: ['Texas'] },
    )
    expect(v.geo).toBe('contradict')
  })
})
