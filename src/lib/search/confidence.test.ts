/**
 * Stated values may exclude a lender. Inferred values may only rank.
 *
 * The first pass at the ambiguous cases simply refused — a BRL amount or the
 * word "mil" produced no size filtering at all. Safe, but useless: operators
 * type real deals in real currencies. The rule here is the middle path —
 * resolve where the evidence supports one reading, and downgrade the value's
 * AUTHORITY rather than discarding it.
 */

import { describe, it, expect } from 'vitest'
import { extractDeal } from '@/lib/search/extract-deal'
import { scoreFit, hasContradiction, type DealCriteria } from '@/lib/search/structured-filter'
import { resolveMilAmount, isPlausibleDealSize, convertToUsd, FX_RATES } from '@/lib/search/money'

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

describe('"mil" is settled against what the roster can fund, not by guessing a language', () => {
  it('resolves 800 mil to 800 thousand — 800 million is outside every lender ceiling', () => {
    const r = resolveMilAmount(800, { iberian: true })
    expect(r.usd).toBe(800_000)
    expect(r.confidence).toBe('stated')
    expect(isPlausibleDealSize(800_000_000)).toBe(false)
  })

  it('keeps 20 mil ambiguous, because both readings are fundable', () => {
    const r = resolveMilAmount(20, { iberian: false })
    expect(r.usd).toBe(20_000_000)
    expect(r.confidence).toBe('inferred')
    expect(r.basis).toMatch(/ranking only/)
  })

  it('leaves a real English operator query working', () => {
    const e = extractDeal('International lender above 20 mil')
    expect(e.deal_size_min_usd).toBe(20_000_000)
  })

  it('reads a Portuguese 800 mil as 800 thousand rather than dropping it', () => {
    const e = extractDeal('um caminhao de 800 mil')
    expect(e.deal_size_min_usd).toBe(800_000)
  })
})

describe('an inferred size ranks but never excludes', () => {
  it('excludes on a STATED size that the lender cannot do', () => {
    const fit = scoreFit(
      { deal_size_min_usd: 100_000, deal_size_max_usd: 2_000_000 },
      deal({ deal_size_min_usd: 20_000_000, deal_size_max_usd: 20_000_000, size_confidence: 'stated' }),
    )
    expect(fit.size).toBe('contradict')
    expect(hasContradiction(fit)).toBe(true)
  })

  it('keeps the same lender when that size was INFERRED', () => {
    const fit = scoreFit(
      { deal_size_min_usd: 100_000, deal_size_max_usd: 2_000_000 },
      deal({ deal_size_min_usd: 20_000_000, deal_size_max_usd: 20_000_000, size_confidence: 'inferred' }),
    )
    expect(fit.size).toBe('unknown')
    expect(hasContradiction(fit)).toBe(false)
    expect(fit.reasons.join(' ')).toMatch(/inferred, not stated/)
  })
})

describe('an inferred asset year ranks but never excludes', () => {
  const lender = { vintage_restriction: '20 Years' }

  it('excludes a 1985 asset when the year was stated', () => {
    const fit = scoreFit(lender, deal({ asset_year: 1985, asset_year_confidence: 'stated' }))
    expect(fit.vintage).toBe('contradict')
  })

  it('keeps the lender when the year was inferred from an ambiguous sentence', () => {
    const fit = scoreFit(lender, deal({ asset_year: 1985, asset_year_confidence: 'inferred' }))
    expect(fit.vintage).toBe('unknown')
    expect(hasContradiction(fit)).toBe(false)
  })

  it('marks a two-year sentence as inferred and takes the older reading', () => {
    const e = extractDeal('deals since 2019 for a 2005 Caterpillar')
    expect(e.asset_year).toBe(2005)
    expect(e.asset_year_confidence).toBe('inferred')
    expect(e.asset_year_basis).toMatch(/2005 and 2019|2005/)
  })

  it('stays stated when only one year is present', () => {
    const e = extractDeal('a 2005 Caterpillar 320')
    expect(e.asset_year).toBe(2005)
    expect(e.asset_year_confidence).toBe('stated')
  })
})

describe('foreign currency', () => {
  it('ships with no FX table, so nothing is converted on invented rates', () => {
    expect(FX_RATES.asOf).toBe('')
    expect(convertToUsd(8_000_000, 'BRL')).toBeNull()
  })

  it('reports the currency instead of treating it as dollars', () => {
    const e = extractDeal('um caminhao de R$8M no Brasil')
    expect(e.deal_size_min_usd).toBeNull()
    expect(e.size_currency_unsupported).toBe('BRL')
  })

  it('converts and marks inferred once a dated rate is supplied', () => {
    const table = { asOf: '2026-09-08', perUsd: { BRL: 5 } }
    const c = convertToUsd(8_000_000, 'BRL', table)
    expect(c).not.toBeNull()
    expect(c!.usd).toBe(1_600_000)
    expect(c!.asOf).toBe('2026-09-08')
  })
})
