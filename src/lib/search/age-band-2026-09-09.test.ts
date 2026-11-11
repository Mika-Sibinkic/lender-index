/**
 * Asset-age BANDS map to their youngest asset, and that direction matters.
 *
 * The age menu offers a 10-15yr option and a 15+ yr old option. The menu
 * underneath takes a single model year, so a band has to pick an
 * end of the range, and the two ends behave very differently under a
 * hard-excluding dimension.
 *
 * Mapping a band to its OLDEST asset would exclude every lender whose cap
 * falls inside the band — lenders who can finance most of it. Mapping to the
 * YOUNGEST excludes only lenders who cannot finance any asset in the band at
 * all, which is a claim their own record supports. These pin that.
 *
 * `as_of_year` is passed explicitly so the verdicts are a pure function of their
 * inputs and do not change meaning every January.
 */

import { describe, it, expect } from 'vitest'
import { scoreFit, hasContradiction, type DealCriteria } from './structured-filter'

const NOW = 2026
const base: DealCriteria = {
  asset_classes: [],
  geographic_scope: [],
  deal_size_min_usd: null,
  deal_size_max_usd: null,
  intl_required: false,
  as_of_year: NOW,
}

/** What the menu writes: youngest asset in the band. */
const BAND_10_15 = { ...base, asset_year: NOW - 10 } // 2016
const BAND_15_PLUS = { ...base, asset_year: NOW - 15 } // 2011

describe('10-15 yr band', () => {
  it('keeps a lender whose cap lands inside the band', () => {
    // A 12-year cap cannot take the 15-year-old end, but can take the 10-year-old
    // end. Excluding it would hide a lender who can write most of these deals.
    const v = scoreFit({ vintage_restriction: '12 Years' }, BAND_10_15)
    expect(hasContradiction(v)).toBe(false)
  })

  it('excludes a lender that cannot take any asset in the band', () => {
    const v = scoreFit({ vintage_restriction: '5 Years' }, BAND_10_15)
    expect(v.vintage).toBe('contradict')
    expect(hasContradiction(v)).toBe(true)
  })

  it('keeps a lender with a cap comfortably beyond the band', () => {
    expect(hasContradiction(scoreFit({ vintage_restriction: '20 Years' }, BAND_10_15))).toBe(false)
  })
})

describe('15+ yr band', () => {
  it('excludes a 12-year cap — it cannot take a 15-year-old asset', () => {
    expect(scoreFit({ vintage_restriction: '12 Years' }, BAND_15_PLUS).vintage).toBe('contradict')
  })

  it('keeps a 20-year cap', () => {
    expect(hasContradiction(scoreFit({ vintage_restriction: '20 Years' }, BAND_15_PLUS))).toBe(false)
  })

  it('reads a cutoff-year restriction the same way', () => {
    // "2003 or newer" takes a 2011 asset; "2015 or newer" does not.
    expect(hasContradiction(scoreFit({ vintage_restriction: '2003 or newer' }, BAND_15_PLUS))).toBe(
      false,
    )
    expect(scoreFit({ vintage_restriction: '2015 or newer' }, BAND_15_PLUS).vintage).toBe(
      'contradict',
    )
  })
})

describe('blank and unreadable limits are never excluded by a band', () => {
  it('keeps a lender with no stated limit', () => {
    for (const cell of [null, '', 'None', 'N/A']) {
      expect(hasContradiction(scoreFit({ vintage_restriction: cell }, BAND_15_PLUS))).toBe(false)
    }
  })

  it('keeps a lender whose limit we cannot parse', () => {
    const v = scoreFit({ vintage_restriction: 'case by case' }, BAND_15_PLUS)
    expect(v.vintage).not.toBe('contradict')
    expect(hasContradiction(v)).toBe(false)
  })
})
