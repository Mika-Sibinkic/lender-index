/**
 * A lender that names the state leads the ones that merely cover it.
 *
 * Requirement: after narrowing by State = Texas, lenders whose record names
 * Texas come before lenders that merely cover the whole US. Finding lenders in
 * a specific market means seeing the ones with stated geography there first.
 *
 * The resolution is a BIAS, not a filter: a nationwide
 * lender really does serve Texas, so dropping it would misrepresent the
 * shortlist — the same failure as a wrong lender, pointed the other way. What
 * changes is the order.
 */

import { describe, it, expect } from 'vitest'
import { scoreFit, rankByFit, hasContradiction, type DealCriteria } from './structured-filter'

const NO: DealCriteria = {
  asset_classes: [],
  geographic_scope: [],
  deal_size_min_usd: null,
  deal_size_max_usd: null,
  intl_required: false,
}

const TEXAS = { ...NO, us_states: ['texas'] }

describe('naming the state is what counts as local', () => {
  it('a lender listing TX is local', () => {
    expect(scoreFit({ geographic_scope: ['US Specific', 'TX'] }, TEXAS).localToRequest).toBe(true)
  })

  it('a nationwide lender is NOT local, but is still a match', () => {
    const v = scoreFit({ geographic_scope: ['All Domestic including AK and HI'] }, TEXAS)
    expect(v.localToRequest).toBe(false)
    expect(v.state).toBe('match')
    expect(hasContradiction(v)).toBe(false)
  })

  it('a bare "US" is coverage, not local knowledge', () => {
    const v = scoreFit({ geographic_scope: ['US'] }, TEXAS)
    expect(v.localToRequest).toBe(false)
    expect(hasContradiction(v)).toBe(false)
  })

  it('reads the state out of the free-text detail cell too', () => {
    // Operators sometimes put the state into the geography detail field rather
    // than the array.
    expect(
      scoreFit({ geographic_scope: [], specific_geographic: 'TX' }, TEXAS).localToRequest,
    ).toBe(true)
  })

  it('a lender that EXCLUDES the state is not local', () => {
    expect(
      scoreFit({ geographic_scope: ['All domestic excluding TX'] }, TEXAS).localToRequest,
    ).toBe(false)
  })

  it('a blank geography is not local, and still is not excluded', () => {
    const v = scoreFit({ geographic_scope: [] }, TEXAS)
    expect(v.localToRequest).toBe(false)
    expect(hasContradiction(v)).toBe(false)
  })
})

describe('the shortlist order operators asked for', () => {
  const rows = [
    { id: 'nationwide', company_name: 'Zeta National Bank', geographic_scope: ['US'] },
    { id: 'local', company_name: 'Alpha Texas Bank', geographic_scope: ['US Specific', 'TX'] },
  ]

  it('puts the Texas bank first even though it sorts last alphabetically', () => {
    const ranked = rankByFit(rows, TEXAS, new Map())
    expect(ranked.map((r) => r.id)).toEqual(['local', 'nationwide'])
  })

  it('still returns the nationwide lender — biasing is not filtering', () => {
    const ranked = rankByFit(rows, TEXAS, new Map())
    expect(ranked).toHaveLength(2)
  })

  it('outranks a higher-scoring nationwide lender', () => {
    // The nationwide row matches on asset as well, so it scores higher. The
    // operator picked a state; the local bank still leads.
    const withAsset = [
      {
        id: 'nationwide',
        company_name: 'Zeta National Bank',
        geographic_scope: ['US'],
        asset_classes: ['construction_equipment'],
      },
      {
        id: 'local',
        company_name: 'Alpha Texas Bank',
        geographic_scope: ['US Specific', 'TX'],
        asset_classes: [],
      },
    ]
    const deal = { ...TEXAS, asset_classes: ['construction_equipment'] }
    expect(scoreFit(withAsset[0], deal).score).toBeGreaterThan(scoreFit(withAsset[1], deal).score)
    expect(rankByFit(withAsset, deal, new Map()).map((r) => r.id)).toEqual([
      'local',
      'nationwide',
    ])
  })

  it('a lender not currently lending still sorts below everyone', () => {
    // notLending outranks the local bias — a local bank that cannot fund today
    // must not lead a shortlist.
    const withDormant = [
      {
        id: 'local-dormant',
        company_name: 'Alpha Texas Bank',
        geographic_scope: ['TX'],
        lending_status: 'No',
      },
      { id: 'nationwide', company_name: 'Zeta National Bank', geographic_scope: ['US'] },
    ]
    expect(rankByFit(withDormant, TEXAS, new Map()).map((r) => r.id)).toEqual([
      'nationwide',
      'local-dormant',
    ])
  })
})

describe('the same bias applies to a country typed in the sentence', () => {
  const BRAZIL = { ...NO, geographic_scope: ['Brazil'] }

  it('a lender naming Brazil leads one that only says International', () => {
    const rows = [
      { id: 'intl', company_name: 'Aardvark Global', geographic_scope: ['International'] },
      { id: 'brazil', company_name: 'Zulu Brasil', geographic_scope: ['Brazil'] },
    ]
    expect(scoreFit(rows[1], BRAZIL).localToRequest).toBe(true)
    expect(scoreFit(rows[0], BRAZIL).localToRequest).toBe(false)
    expect(rankByFit(rows, BRAZIL, new Map())[0].id).toBe('brazil')
  })
})

/**
 * Focus: location-aware results come first, so a lender's preferred location
 * should correspond to the deal's location.
 *
 * A Texas-only lender (["US Specific","TX"]) and a fourteen-state lender
 * including TX both genuinely serve Texas and both are local. A Texas-only
 * bank is more *of* Texas than a fourteen-state lender that includes it.
 */
describe('among equally-fitting local lenders, the focused one leads', () => {
  const texasOnly = {
    id: 'focused',
    company_name: 'Zeta State Bank',
    geographic_scope: ['US Specific', 'TX'],
  }
  const fourteenStates = {
    id: 'broad',
    company_name: 'Alpha Financial',
    geographic_scope: ['US Specific', 'NV', 'UT', 'AZ', 'NM', 'CO', 'WY', 'MT', 'OK', 'TX', 'LA', 'MS', 'AL', 'GA', 'FL'],
  }

  it('counts the named places', () => {
    expect(scoreFit(texasOnly, TEXAS).localFootprint).toBe(1)
    expect(scoreFit(fourteenStates, TEXAS).localFootprint).toBe(14)
  })

  it('puts the Texas-only bank first despite sorting last alphabetically', () => {
    expect(rankByFit([fourteenStates, texasOnly], TEXAS, new Map()).map((r) => r.id)).toEqual([
      'focused',
      'broad',
    ])
  })

  it('is inert for a lender that is not local', () => {
    expect(scoreFit({ geographic_scope: ['US'] }, TEXAS).localFootprint).toBe(Infinity)
  })

  it('never outranks a better fit — score still wins', () => {
    // The fourteen-state lender also matches the asset; the Texas-only one does
    // not. Focus is a tiebreaker, not a trump card: a lender that fits the deal
    // better must still lead.
    const deal = { ...TEXAS, asset_classes: ['construction_equipment'] }
    const focusedWorseFit = { ...texasOnly, asset_classes: [] }
    const broadBetterFit = { ...fourteenStates, asset_classes: ['construction_equipment'] }
    expect(rankByFit([focusedWorseFit, broadBetterFit], deal, new Map()).map((r) => r.id)).toEqual([
      'broad',
      'focused',
    ])
  })

  it('a nationwide lender still appears, just below both', () => {
    const nationwide = { id: 'nationwide', company_name: 'AAA National', geographic_scope: ['US'] }
    const ranked = rankByFit([nationwide, fourteenStates, texasOnly], TEXAS, new Map())
    expect(ranked.map((r) => r.id)).toEqual(['focused', 'broad', 'nationwide'])
    expect(ranked).toHaveLength(3)
  })
})
