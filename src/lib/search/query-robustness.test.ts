/**
 * Query robustness — language, currency, ranges, ambiguity.
 *
 * Every case here was measured failing against production on 2026-09-08 before
 * the fix. They are grouped by what the failure DID, because that is what the
 * accuracy mandate grades: a case that returns a wrong shortlist is a different
 * severity from one that returns a thin one.
 */

import { describe, it, expect } from 'vitest'
import { extractDeal, unsupportedCurrency } from '@/lib/search/extract-deal'

describe('wrong-shortlist class — these produced incorrect lenders, not missing ones', () => {
  it('never reads a non-USD amount as dollars', () => {
    // "R$8M" is roughly USD 1.5M. Read as USD 8M it made the deal look five
    // times its size and hard-excluded every lender whose ceiling was under $8M
    // — precisely the ones who could have written it.
    const brl = extractDeal('um caminhao de R$8M no Brasil')
    expect(brl.deal_size_min_usd).toBeNull()
    expect(brl.deal_size_max_usd).toBeNull()
    expect(brl.size_currency_unsupported).toBe('BRL')

    for (const [q, code] of [['an excavator around €8M', 'EUR'], ['an excavator around £4M', 'GBP']] as const) {
      const e = extractDeal(q)
      expect(e.deal_size_min_usd).toBeNull()
      expect(e.size_currency_unsupported).toBe(code)
    }
  })

  it('still reads plain dollars, and US$ is dollars', () => {
    expect(extractDeal('an excavator around $8M').deal_size_min_usd).toBe(8_000_000)
    expect(unsupportedCurrency('financiamento de US$ 3 milhoes')).toBeNull()
    expect(unsupportedCurrency('a deal in USD 3 million')).toBeNull()
  })

  it('does not let a bare "us" swallow a foreign country', () => {
    // "US 3 milhoes no Brasil" matched ' us ', set geography to United States,
    // suppressed Brazil, and left intl_required false — US-only lenders on a
    // Brazilian deal, the exact failure the geo work exists to prevent.
    const e = extractDeal('financiamento de trator de US 3 milhoes no Brasil')
    expect(e.geographic_scope).toContain('Brazil')
    expect(e.geographic_scope).not.toContain('United States')
    expect(e.intl_required).toBe(true)
  })

  it('still recognises the United States when actually named', () => {
    expect(extractDeal('lenders in the United States').geographic_scope).toContain('United States')
    expect(extractDeal('a USA-wide lender').geographic_scope).toContain('United States')
  })

  it('reads a range as a range, not as an exact size', () => {
    // "$8M-$10M" recorded 8,000,000 as BOTH bounds, excluding every lender whose
    // window was 9-10M.
    const dash = extractDeal('an excavator $8M-$10M')
    expect(dash.deal_size_min_usd).toBe(8_000_000)
    expect(dash.deal_size_max_usd).toBe(10_000_000)

    const words = extractDeal('an excavator between $8M and $10M')
    expect(words.deal_size_min_usd).toBe(8_000_000)
    expect(words.deal_size_max_usd).toBe(10_000_000)
  })

  it('reads a qualifier that follows the amount', () => {
    // "$5M max" became an exact $5M deal, excluding lenders topping out lower.
    const e = extractDeal('an excavator $5M max')
    expect(e.deal_size_min_usd).toBeNull()
    expect(e.deal_size_max_usd).toBe(5_000_000)
    expect(extractDeal('an excavator under $5M').deal_size_max_usd).toBe(5_000_000)
  })

  it('never lets an ambiguous year exclude a lender', () => {
    // Taking the FIRST year read 2019 out of "deals since 2019 for a 2005
    // Caterpillar" and excluded on an age the deal never stated.
    //
    // The first fix returned null, which was safe but threw away a year the
    // sentence really did contain. Now the older reading is kept and marked
    // INFERRED, so it orders the list and is barred from removing anyone —
    // and the basis is shown so the operator can correct it. See confidence.test.ts.
    expect(extractDeal('a 2005 Caterpillar 320').asset_year).toBe(2005)
    expect(extractDeal('a 2005 Caterpillar 320').asset_year_confidence).toBe('stated')
    expect(extractDeal('2005 Caterpillar, we closed 5 deals in 2019').asset_year).toBe(2005)

    const ambiguous = extractDeal('deals since 2019 for a 2005 Caterpillar')
    expect(ambiguous.asset_year).toBe(2005)
    expect(ambiguous.asset_year_confidence).toBe('inferred')
  })
})

describe('thin-shortlist class — operators write these and got no filtering', () => {
  const asset = (q: string) => extractDeal(q).asset_classes

  it('understands asset nouns in Portuguese, Spanish, French and German', () => {
    expect(asset('financiamento de equipamento no Brasil')).toContain('equipment')
    expect(asset('financiacion de una excavadora en Mexico')).toContain('construction_equipment')
    expect(asset("financement d'une pelleteuse")).toContain('construction_equipment')
    expect(asset('financiamento de trator')).toContain('agricultural_equipment')
    expect(asset('trator em Sao Paulo')).toContain('agricultural_equipment')
    expect(asset('Finanzierung eines Bagger')).toContain('construction_equipment')
    expect(asset('um caminhão para empresa')).toContain('commercial_trucks')
    expect(asset('un vehículo corporativo')).toContain('vehicles')
    expect(asset('financiamento de imóvel')).toContain('real_estate')
    expect(asset('capital de giro para empresa')).toContain('working_capital')
  })

  it('understands millions in Portuguese, Spanish and French', () => {
    expect(extractDeal('um caminhao de US$ 8 milhoes').deal_size_min_usd).toBe(8_000_000)
    expect(extractDeal('un camion de US$ 8 millones').deal_size_min_usd).toBe(8_000_000)
    expect(extractDeal('un camion de USD 8 millions').deal_size_min_usd).toBe(8_000_000)
  })

  it('does NOT treat Portuguese/Spanish "mil" as a million', () => {
    // 'mil' is an English-finance shorthand for million in parseAmount, and it
    // means THOUSAND in PT/ES. Reading "800 mil" as $800M exceeds every lender
    // ceiling in the roster and would empty the shortlist, so the reading is
    // settled against real deal-size data rather than by guessing the language.
    const e = extractDeal('um caminhao de 800 mil')
    expect(e.deal_size_min_usd).not.toBe(800_000_000)
    expect(e.deal_size_min_usd).toBe(800_000)
  })

  it('arms the international requirement from a non-English keyword', () => {
    expect(extractDeal('financiamento internacional de equipamento').intl_required).toBe(true)
    expect(extractDeal('financiacion internacional').intl_required).toBe(true)
  })
})

describe('field order stays irrelevant', () => {
  it('extracts identically however the facts are ordered', () => {
    const want = {
      asset: ['construction_equipment'],
      geo: ['Texas'],
      min: 8_000_000,
      max: 8_000_000,
      year: 2005,
    }
    for (const q of [
      '2005 Caterpillar 320 in Texas around $8M',
      'around $8M for a 2005 Caterpillar 320 in Texas',
      'Texas, $8M, 2005 Caterpillar 320',
      '320 Caterpillar 2005 Texas $8M',
    ]) {
      const e = extractDeal(q)
      expect(e.asset_classes).toEqual(want.asset)
      expect(e.geographic_scope).toEqual(want.geo)
      expect(e.deal_size_min_usd).toBe(want.min)
      expect(e.deal_size_max_usd).toBe(want.max)
      expect(e.asset_year).toBe(want.year)
    }
  })
})
