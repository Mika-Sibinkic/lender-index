/**
 * Post-testing operator notes, locked into the suite.
 *
 * Every case here traces to a line in those notes or to a roster value the
 * line is about. Lender rows mirror real roster shapes rather than invented
 * ones, so a change that would have satisfied the note on paper but not
 * against real data still fails.
 */

import { describe, it, expect } from 'vitest'
import { extractDeal } from '@/lib/search/extract-deal'
import { mergeConstraints } from '@/lib/search/constraints'
import { scoreFit, hasContradiction, rankByFit, type DealCriteria } from '@/lib/search/structured-filter'
import { parseVintageRule, oldestYearAllowed } from '@/lib/funding-sources/vintage'
import { ASSET_CLASSES } from '@/lib/types/funding-source'
import { readFacetParams, writeFacetParams, hasAnyFacet } from '@/lib/search/facet-params'

const deal = (over: Partial<DealCriteria> = {}): DealCriteria => ({
  asset_classes: [],
  geographic_scope: [],
  deal_size_min_usd: null,
  deal_size_max_usd: null,
  intl_required: false,
  usage_codes: [],
  operation_category: null,
  lender_type_required: null,
  us_states: [],
  asset_year: null,
  as_of_year: 2026,
  ...over,
})

describe('Asset menu — the configured classes', () => {
  it('offers working capital and real estate as distinct classes', () => {
    expect(ASSET_CLASSES).toContain('working_capital')
    expect(ASSET_CLASSES).toContain('real_estate')
  })

  it('reads working capital as its own class, not as generic real estate', () => {
    const ex = extractDeal('working capital line in Texas')
    expect(ex.asset_classes).toContain('working_capital')
    expect(ex.asset_classes).not.toContain('real_estate')
  })

  it('does not let an equipment lender answer a working-capital ask, or the reverse', () => {
    // Pollux Bank's asset cell. Its notes say "Working Capital Lines", but the
    // structured field does not — and matching reads the field, never the notes.
    const pollux = { asset_classes: ['equipment', 'medical_equipment', 'construction_equipment', 'agricultural_equipment'] }
    expect(scoreFit(pollux, deal({ asset_classes: ['working_capital'] })).asset).toBe('contradict')
    // A lender with no asset cell is unknown and is kept, as everywhere else.
    expect(scoreFit({ asset_classes: [] }, deal({ asset_classes: ['working_capital'] })).asset).toBe('unknown')
  })
})

describe('Lender menu — "need to add Bank"', () => {
  it('matches rows whose lender_type is Bank', () => {
    const d = deal({ lender_type_required: 'bank' })
    expect(scoreFit({ lender_type: 'Bank' }, d).lenderType).toBe('match')
    expect(scoreFit({ lender_type: 'Credit Union' }, d).lenderType).toBe('contradict')
    expect(scoreFit({ lender_type: 'Non Bank' }, d).lenderType).toBe('contradict')
  })

  it('keeps a lender whose kind is not recorded', () => {
    expect(scoreFit({ lender_type: null }, deal({ lender_type_required: 'bank' })).lenderType).toBe(
      'unknown',
    )
  })
})

describe('Asset age — "Narrow by → Asset age"', () => {
  it('reads both shapes the column actually holds', () => {
    expect(parseVintageRule('20 Years')).toEqual({ kind: 'max_age', years: 20 })
    expect(parseVintageRule('30 years')).toEqual({ kind: 'max_age', years: 30 })
    expect(parseVintageRule('2003 or newer')).toEqual({ kind: 'min_year', year: 2003 })
    expect(parseVintageRule('None')).toEqual({ kind: 'none' })
    expect(parseVintageRule('N/A')).toEqual({ kind: 'none' })
    expect(parseVintageRule(null)).toEqual({ kind: 'none' })
    expect(parseVintageRule('call us').kind).toBe('unknown')
  })

  it('turns an age limit into the oldest year it allows', () => {
    expect(oldestYearAllowed(parseVintageRule('20 Years'), 2026)).toBe(2006)
    expect(oldestYearAllowed(parseVintageRule('2003 or newer'), 2026)).toBe(2003)
    expect(oldestYearAllowed(parseVintageRule('None'), 2026)).toBeNull()
  })

  it('excludes a lender whose stated limit the asset breaks', () => {
    const d = deal({ asset_year: 1985, asset_classes: ['construction_equipment'] })
    const fit = scoreFit({ vintage_restriction: '20 Years' }, d)
    expect(fit.vintage).toBe('contradict')
    expect(hasContradiction(fit)).toBe(true)
  })

  it('keeps a lender when the asset is inside the limit, or the limit is unreadable', () => {
    const d = deal({ asset_year: 2015 })
    expect(scoreFit({ vintage_restriction: '20 Years' }, d).vintage).toBe('match')
    expect(scoreFit({ vintage_restriction: 'None' }, d).vintage).toBe('match')
    expect(scoreFit({ vintage_restriction: null }, d).vintage).toBe('match')
    expect(scoreFit({ vintage_restriction: 'ask' }, d).vintage).toBe('unknown')
  })

  it('reads the year out of an operator’s working example', () => {
    // "This search worked – 2005 Caterpillar 320 – Mexico" — and until now the
    // 2005 was discarded, so a lender capped at 20 years could still lead it.
    expect(extractDeal('2005 Caterpillar 320 Mexico').asset_year).toBe(2005)
  })

  it('ignores a year with no asset in the sentence', () => {
    // A false year EXCLUDES lenders, so it must not fire on an incidental date.
    expect(extractDeal('deals we closed in 2019').asset_year).toBeNull()
  })

  it('never reads a dollar amount as a year', () => {
    const ex = extractDeal('a Caterpillar around $2,005,000')
    expect(ex.asset_year).toBeNull()
    expect(ex.deal_size_min_usd ?? ex.deal_size_max_usd).toBe(2_005_000)
  })
})

describe('State — "Narrow by → State"', () => {
  it('holds a lender that lists states to those states', () => {
    // Capella CU's cell, the row an operator saw on a Texas search.
    const globalCu = { geographic_scope: ['US Specific', 'AK', 'AZ', 'CA', 'ID', 'WA'] }
    expect(scoreFit(globalCu, deal({ us_states: ['Texas'] })).state).toBe('contradict')
    expect(scoreFit(globalCu, deal({ us_states: ['Arizona'] })).state).toBe('match')
  })

  it('keeps a nationwide lender for any state', () => {
    expect(scoreFit({ geographic_scope: ['US'] }, deal({ us_states: ['Texas'] })).state).toBe('match')
    expect(
      scoreFit({ geographic_scope: ['All Domestic including AK and HI'] }, deal({ us_states: ['Ohio'] }))
        .state,
    ).toBe('match')
  })

  it('keeps a lender whose geography is blank', () => {
    expect(scoreFit({ geographic_scope: [] }, deal({ us_states: ['Texas'] })).state).toBe('unknown')
  })

  it('narrows and never widens — a state cannot rescue a foreign-only lender', () => {
    const multibank = { geographic_scope: ['Latin America'] }
    expect(scoreFit(multibank, deal({ us_states: ['Florida'] })).state).toBe('contradict')
  })

  it('cannot disarm the international exclude the way a forged geo value could', () => {
    const merged = mergeConstraints(extractDeal('a tractor in Brazil'), { us_states: ['Texas'] }, {
      queryHasIntlKeyword: false,
    })
    expect(merged.intl_required).toBe(true)
    expect(merged.geographic_scope).toContain('Brazil')
  })

  it('drops a state that is not one of the canonical fifty', () => {
    const merged = mergeConstraints(extractDeal('an excavator'), { us_states: ['Ontario', 'Texas'] }, {
      queryHasIntlKeyword: false,
    })
    expect(merged.us_states).toEqual(['Texas'])
  })
})

describe('"Narrow by – does [not] seem to be updating results"', () => {
  it('round-trips every menu through the URL', () => {
    const c = {
      asset_classes: ['construction_equipment'],
      us_states: ['Texas'],
      usage_codes: ['lease'],
      deal_size_min_usd: 1_000_000,
      deal_size_max_usd: 5_000_000,
      operation_category: 'Commercial',
      lender_type_required: 'bank',
      asset_year: 2005,
    }
    const p = new URLSearchParams()
    writeFacetParams(p, c)
    const bag: Record<string, string> = {}
    p.forEach((v, k) => (bag[k] = v))
    expect(readFacetParams(bag)).toEqual(c)
    expect(hasAnyFacet(c)).toBe(true)
    expect(hasAnyFacet({})).toBe(false)
  })

  it('clears a dimension out of the URL when it is unticked', () => {
    const p = new URLSearchParams('asset_classes=construction_equipment&lender_kind=bank')
    writeFacetParams(p, {})
    expect(p.toString()).toBe('')
  })
})

describe('order is stable', () => {
  it('breaks a score tie alphabetically instead of by physical row order', () => {
    const rows = [
      { id: 'c', company_name: 'Zephyr Bank' },
      { id: 'a', company_name: 'Apex Capital' },
      { id: 'b', company_name: 'Meridian Trust' },
    ]
    const once = rankByFit(rows, deal(), new Map()).map((r) => r.company_name)
    const again = rankByFit([...rows].reverse(), deal(), new Map()).map((r) => r.company_name)
    expect(once).toEqual(['Apex Capital', 'Meridian Trust', 'Zephyr Bank'])
    expect(again).toEqual(once)
  })
})
