import { describe, it, expect } from 'vitest'
import { extractDeal } from './extract-deal'

describe('extractDeal — rank signals (usage / operation / lender kind)', () => {
  it('extracts usage codes from their configured keywords', () => {
    expect(extractDeal('$4M excavator for an owner-operated contractor').usage_codes).toContain('owner')
    expect(extractDeal('needs owner operated and rental capability').usage_codes).toEqual(
      expect.arrayContaining(['owner', 'rental'])
    )
  })
  it('does NOT read a usage keyword inside a longer word', () => {
    expect(extractDeal('finance around $135,000 for a parental-leave fund').usage_codes ?? []).not.toContain('rental')
  })
  it('detects Commercial vs Personal operation', () => {
    expect(extractDeal('commercial use truck fleet deal').operation_category).toBe('Commercial')
    expect(extractDeal('personal use vehicle').operation_category).toBe('Personal')
    expect(extractDeal('a Caterpillar in Texas').operation_category).toBeNull()
  })
  it('detects an explicit lender-kind ask, including "bank"', () => {
    expect(extractDeal('find a credit union for this').lender_type_required).toBe('credit union')
    expect(extractDeal('prefer a non-bank lender').lender_type_required).toBe('non-bank')
    expect(extractDeal('a private equity source').lender_type_required).toBe('private equity')
    expect(extractDeal('finance an excavator through a bank').lender_type_required).toBe('bank')
  })
  it('reads a kind in subject position — "Bank for North Carolina rental fleet deal, $8M"', () => {
    // The type must be distinguished for exactly this phrasing. Leading with
    // the kind and aiming it at the deal is how a broker types it, and it armed
    // NOTHING before — for all four kinds, not just bank.
    const e = extractDeal('Bank for North Carolina rental fleet deal, $8M')
    expect(e.lender_type_required).toBe('bank')
    expect(e.geographic_scope).toContain('North Carolina')
    expect(e.usage_codes).toContain('rental')
    expect(e.deal_size_max_usd).toBe(8_000_000)

    expect(
      extractDeal('credit union for North Carolina rental fleet deal, $8M').lender_type_required,
    ).toBe('credit union')
    expect(extractDeal('non-bank for North Carolina').lender_type_required).toBe('non-bank')
    expect(extractDeal('private equity for a $8M excavator').lender_type_required).toBe('private equity')
    expect(extractDeal('bank in Tennessee').lender_type_required).toBe('bank')
  })
  it('never arms "bank" from a company name', () => {
    // "bank" is the one kind that is also a name word, and a roster is full of
    // them. Arming here would hard-exclude every typed non-bank on a lookup.
    for (const q of [
      'Castor Bank',
      'Bank of Adhara',
      'Bank of Almach Leasing',
      'Rigel Bank contact',
      'warehouse loan for a bank-owned facility',
    ]) {
      expect(extractDeal(q).lender_type_required).toBeNull()
    }
  })
  it('does NOT arm the hard filter on an incidental mention (borrower context)', () => {
    // "backed by private equity" describes the BORROWER, not the desired lender —
    // must not collapse the shortlist to PE-only.
    expect(
      extractDeal('borrower is backed by private equity, needs $8M for an excavator').lender_type_required,
    ).toBeNull()
    expect(extractDeal('a private-equity-owned logistics company').lender_type_required).toBeNull()
  })
})

describe('extractDeal — child classes and makes', () => {
  it('detects commercial_trucks from truck language or a truck make', () => {
    expect(extractDeal('semi truck fleet for a logistics company').asset_classes).toContain('commercial_trucks')
    expect(extractDeal('a Freightliner deal').asset_classes).toContain('commercial_trucks')
  })
  it('padded keywords do not fire inside longer words', () => {
    // ' tractor ' is padded in config: "tractor-trailer" is a truck and a
    // "contractor" is a borrower, neither is farm equipment.
    expect(extractDeal('tractor-trailer financing').asset_classes).toContain('commercial_trucks')
    expect(extractDeal('tractor-trailer financing').asset_classes).not.toContain('agricultural_equipment')
    expect(extractDeal('loan for a general contractor').asset_classes).not.toContain('agricultural_equipment')
    expect(extractDeal('a used tractor for a farm').asset_classes).toContain('agricultural_equipment')
  })
  it('a short make only matches as a whole word', () => {
    expect(extractDeal('Mackenzie Capital referral').asset_classes).not.toContain('commercial_trucks')
    expect(extractDeal('a Mack truck').asset_families).toContain('mack')
  })
})

describe('extractDeal — the headline query', () => {
  const d = extractDeal('finance a Caterpillar around $8M for a borrower in Brazil')
  it('detects construction_equipment from "Caterpillar"', () => {
    expect(d.asset_classes).toContain('construction_equipment')
  })
  it('detects Brazil', () => {
    expect(d.geographic_scope).toContain('Brazil')
  })
  it('parses $8M as the target deal size (both bounds)', () => {
    expect(d.deal_size_min_usd).toBe(8_000_000)
    expect(d.deal_size_max_usd).toBe(8_000_000)
  })
  it('seeds Caterpillar as an asset family', () => {
    expect(d.asset_families).toContain('caterpillar')
  })
  it('keeps the full query for embedding', () => {
    expect(d.semantic_query).toBe('finance a Caterpillar around $8M for a borrower in Brazil')
  })
})

describe('extractDeal — deal size qualifiers', () => {
  it('"under $5M" → max only', () => {
    const d = extractDeal('equipment finance under $5M')
    expect(d.deal_size_max_usd).toBe(5_000_000)
    expect(d.deal_size_min_usd).toBeNull()
  })
  it('"over $10 million" → min only', () => {
    const d = extractDeal('lenders over $10 million')
    expect(d.deal_size_min_usd).toBe(10_000_000)
    expect(d.deal_size_max_usd).toBeNull()
  })
  it('"between $2M and $6M" → range', () => {
    const d = extractDeal('deals between $2M and $6M')
    expect(d.deal_size_min_usd).toBe(2_000_000)
    expect(d.deal_size_max_usd).toBe(6_000_000)
  })
  it('"$500k" → 500000', () => {
    expect(extractDeal('a $500k loan').deal_size_max_usd).toBe(500_000)
  })
  it('ignores a bare year like 1987', () => {
    const d = extractDeal('1987 Caterpillar midwest')
    expect(d.deal_size_min_usd).toBeNull()
    expect(d.deal_size_max_usd).toBeNull()
  })
})

describe('extractDeal — assets, geo, industry, models', () => {
  it('medical_equipment + Texas + logistics from "Philips scanner for a Texas logistics company"', () => {
    const d = extractDeal('Philips scanner for a Texas logistics company')
    expect(d.asset_classes).toContain('medical_equipment')
    expect(d.geographic_scope).toContain('Texas')
    expect(d.industry_filters).toContain('logistics')
    expect(d.asset_families).toContain('philips')
  })
  it('agricultural_equipment + agriculture', () => {
    const d = extractDeal('tractor financing for an agriculture company')
    expect(d.asset_classes).toContain('agricultural_equipment')
    expect(d.industry_filters).toContain('agriculture')
  })
  it('extracts model designators', () => {
    expect(extractDeal('Caterpillar 320 and a John Deere 8R').asset_models).toEqual(
      expect.arrayContaining(['caterpillar 320', 'john deere 8r']),
    )
  })
  it('empty query → all-empty extract, no throw', () => {
    const d = extractDeal('')
    expect(d.asset_classes).toEqual([])
    expect(d.geographic_scope).toEqual([])
    expect(d.intl_required).toBe(false)
  })
  it('detects generic international intent', () => {
    expect(extractDeal('International lender above 20 mil').intl_required).toBe(true)
    expect(extractDeal('a lender that funds deals overseas').intl_required).toBe(true)
    expect(extractDeal('worldwide equipment financing').intl_required).toBe(true)
    expect(extractDeal('construction equipment in Texas for logistics').intl_required).toBe(false)
  })
  it('extracts the vehicles asset class', () => {
    expect(extractDeal('finance a $3M fleet of vehicles').asset_classes).toContain('vehicles')
    expect(extractDeal('car loan for a dealership').asset_classes).toContain('vehicles')
    expect(extractDeal('a $5M excavator').asset_classes).not.toContain('vehicles')
  })
})

describe('extractDeal — comprehensive foreign-country recognition', () => {
  // The accuracy bug: a deal naming a country OFF the old small dictionary
  // (Argentina, Portugal, Japan, Nigeria, Indonesia, Chile, UAE…) yielded an
  // empty geographic_scope, so the geo/intl hard-exclude never engaged and a
  // US-only lender wrongly surfaced for a FOREIGN deal.
  it('recognises off-list countries by name → geographic_scope populated', () => {
    expect(extractDeal('finance equipment for a borrower in Argentina').geographic_scope).toContain('Argentina')
    expect(extractDeal('tractor deal in Portugal').geographic_scope).toContain('Portugal')
    expect(extractDeal('equipment financing in Japan').geographic_scope).toContain('Japan')
    expect(extractDeal('a borrower in Nigeria').geographic_scope).toContain('Nigeria')
    expect(extractDeal('operator based in Indonesia').geographic_scope).toContain('Indonesia')
    expect(extractDeal('a company in Chile').geographic_scope).toContain('Chile')
  })

  it('resolves demonyms and aliases to the canonical country', () => {
    expect(extractDeal('a Brazilian logistics company').geographic_scope).toContain('Brazil')
    expect(extractDeal('UK-based equipment buyer').geographic_scope).toContain('United Kingdom')
    expect(extractDeal('a Japanese construction firm').geographic_scope).toContain('Japan')
    expect(extractDeal('financing for a UAE operator').geographic_scope).toContain('United Arab Emirates')
  })

  it('any recognised foreign country ENGAGES international intent', () => {
    expect(extractDeal('finance equipment for a borrower in Argentina').intl_required).toBe(true)
    expect(extractDeal('tractor deal in Portugal').intl_required).toBe(true)
    expect(extractDeal('equipment financing in Japan').intl_required).toBe(true)
    expect(extractDeal('operator based in Indonesia').intl_required).toBe(true)
    // A foreign region engages too.
    expect(extractDeal('a buyer in the Middle East').intl_required).toBe(true)
  })

  it('does NOT engage international intent for a US-only deal (no regression)', () => {
    expect(extractDeal('Philips scanner for a Texas logistics company').intl_required).toBe(false)
    expect(extractDeal('tractor financing in California').intl_required).toBe(false)
    expect(extractDeal('a nationwide equipment lender for a Midwest operator').intl_required).toBe(false)
    expect(extractDeal('finance a Caterpillar around $8M in the US').intl_required).toBe(false)
  })

  it('US states still resolve in geographic_scope (no regression)', () => {
    const d = extractDeal('Philips scanner for a Texas logistics company')
    expect(d.geographic_scope).toContain('Texas')
    expect(d.geographic_scope).not.toContain('United States') // state, not the country token
  })

  it('does not false-positive a country pattern inside a US place name', () => {
    // "Houston" contains "us" — must not register United States/foreign intent.
    const d = extractDeal('a Houston-based excavator operator')
    expect(d.intl_required).toBe(false)
  })
})

describe('extractDeal — whole-token geo matching (no inverse false-positive)', () => {
  // A foreign country pattern must NOT substring-match a US place name and flag a
  // DOMESTIC deal international — that would hard-exclude valid domestic-only
  // lenders (the inverse of the foreign-geography exclusion, equally a "wrong shortlist" violation).
  it('India ⊄ Indiana / Indianapolis, China ⊄ Chinatown', () => {
    for (const q of [
      'tractor financing in Indiana',
      'a deal in Gary, Indiana',
      'a borrower in Indianapolis',
    ]) {
      const d = extractDeal(q)
      expect(d.intl_required).toBe(false)
      expect(d.geographic_scope).not.toContain('India')
    }
    expect(
      extractDeal('a buyer in Chinatown, San Jean').geographic_scope,
    ).not.toContain('China')
  })

  it('a country-named US town is DOMESTIC when the state is given', () => {
    const fl = extractDeal('Panama City, Florida logistics company')
    expect(fl.intl_required).toBe(false)
    expect(fl.geographic_scope).toContain('Florida')
    expect(fl.geographic_scope).not.toContain('Panama')

    const il = extractDeal('a deal in Peru, Illinois')
    expect(il.intl_required).toBe(false)
    expect(il.geographic_scope).toContain('Illinois')
    expect(il.geographic_scope).not.toContain('Peru')
  })

  it('still engages intl for a genuine foreign deal (no over-correction)', () => {
    expect(extractDeal('an equipment borrower in Argentina').intl_required).toBe(true)
    expect(extractDeal('tractor in Japan').intl_required).toBe(true)
    expect(extractDeal('a UK-based buyer').geographic_scope).toContain('United Kingdom')
  })
})

// Regression: "equipment in West Virginia, $12,000,000"
// produced the chips `WHERE Virginia` AND `WHERE West Virginia`, because the
// state dictionary matches on plain substring and "virginia" sits inside "west
// virginia". A Virginia-only lender then surfaces on a West Virginia deal, which
// is a stated-geography contradiction — a wrong lender under the mandate.
// Same shape: "kansas" inside "arkansas".
describe('a state name inside another state name (geo shadowing)', () => {
  it('West Virginia does not also fire Virginia', () => {
    expect(extractDeal('equipment in West Virginia, $12,000,000').geographic_scope).toEqual([
      'West Virginia',
    ])
  })

  it('Arkansas does not also fire Kansas', () => {
    expect(extractDeal('tractor in Arkansas').geographic_scope).toEqual(['Arkansas'])
  })

  it('still keeps both when the query genuinely names both', () => {
    const geo = extractDeal('equipment in Virginia and West Virginia').geographic_scope
    expect(geo).toContain('Virginia')
    expect(geo).toContain('West Virginia')
  })

  it('keeps a standalone state that merely looks contained but is not', () => {
    expect(extractDeal('excavator in Kansas City Missouri').geographic_scope.sort()).toEqual([
      'Kansas',
      'Missouri',
    ])
  })

  it('does not disturb unrelated multi-word states', () => {
    expect(extractDeal('scanner in North Dakota').geographic_scope).toEqual(['North Dakota'])
    expect(extractDeal('tractor in South Carolina').geographic_scope).toEqual(['South Carolina'])
  })

  // The dangerous variant already works and must keep working: a US state whose
  // name contains a COUNTRY name must not flip the deal international.
  it('Indiana is not India and New Mexico is not Mexico', () => {
    for (const q of ['equipment in Indiana, $5,000,000', 'tractor in New Mexico']) {
      expect(extractDeal(q).intl_required).toBe(false)
    }
    expect(extractDeal('equipment in Indiana, $5,000,000').geographic_scope).toEqual(['Indiana'])
  })
})
