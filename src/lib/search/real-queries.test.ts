import { describe, it, expect } from 'vitest'
import { extractDeal } from './extract-deal'

/**
 * Queries in the shape staff actually type.
 *
 * Operators who describe a deal in one line, so this is the
 * real input distribution: a dollar amount in words or symbols, a manufacturer
 * rather than a category, a two-letter state, and an operating use. Non-English
 * *queries* are explicitly not a scenario (they do send non-English documents,
 * which is an intake concern, not a search one).
 *
 * Each of these is a wrong-shortlist risk if it silently fails to parse: an
 * unrecognised amount or state means that constraint is never applied, and the
 * operator gets lenders outside their deal with nothing on screen saying why.
 */
describe('real operator queries', () => {
  it('handles "6 million dollar caterpillar for logistics in AZ"', () => {
    const d = extractDeal('6 million dollar caterpillar for logistics in AZ')
    expect(d.asset_classes).toEqual(['construction_equipment']) // Caterpillar, not generic
    expect(d.geographic_scope).toEqual(['Arizona']) // bare two-letter state code
    expect(d.deal_size_min_usd).toBe(6_000_000) // "6 million dollar", no $ sign
    expect(d.deal_size_max_usd).toBe(6_000_000)
    expect(d.industry_filters).toContain('logistics')
    expect(d.asset_families).toContain('caterpillar') // seeds the graph hop
    expect(d.intl_required).toBe(false) // a US state must never arm the intl exclude
  })

  it('reads the same deal identically however it is phrased', () => {
    const a = extractDeal('6 million dollar caterpillar for logistics in AZ')
    const b = extractDeal('$6M Caterpillar for logistics in Arizona')
    expect(b.asset_classes).toEqual(a.asset_classes)
    expect(b.geographic_scope).toEqual(a.geographic_scope)
    expect(b.deal_size_min_usd).toBe(a.deal_size_min_usd)
    expect(b.industry_filters).toEqual(a.industry_filters)
  })

  it('is case-insensitive on state codes', () => {
    expect(extractDeal('excavator deal in az').geographic_scope).toEqual(['Arizona'])
    expect(extractDeal('excavator deal in AZ').geographic_scope).toEqual(['Arizona'])
  })

  it('does not read a two-letter code buried inside a word as a state', () => {
    // "azimuth" must not become Arizona. Space-padded matching is what prevents
    // a bogus geo constraint silently narrowing the shortlist.
    expect(extractDeal('azimuth indicator upgrade financing').geographic_scope).toEqual([])
  })

  it('reads plain-word amounts, not just $ notation', () => {
    expect(extractDeal('a 6 million dollar deal').deal_size_min_usd).toBe(6_000_000)
    expect(extractDeal('a 750k deal').deal_size_min_usd).toBe(750_000)
    expect(extractDeal('around $8M').deal_size_min_usd).toBe(8_000_000)
  })

  it('ignores bare numbers that are not amounts', () => {
    // A serial number, a year, or a model designator must not become a deal size.
    const d = extractDeal('2014 Caterpillar 320 for a rental fleet company')
    expect(d.deal_size_min_usd).toBeNull()
    expect(d.deal_size_max_usd).toBeNull()
    expect(d.usage_codes).toContain('rental')
  })
})
