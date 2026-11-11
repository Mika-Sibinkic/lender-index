import { describe, it, expect } from 'vitest'
import { mergeConstraints, hasForeignGeo } from './constraints'
import { extractDeal } from './extract-deal'

const parse = (q: string) => extractDeal(q)

describe('mergeConstraints', () => {
  it('is a no-op when the operator has changed nothing', () => {
    const p = parse('finance a Caterpillar around $8M for a borrower in Brazil')
    const e = mergeConstraints(p, undefined, { queryHasIntlKeyword: false })
    expect(e.asset_classes).toEqual(p.asset_classes)
    expect(e.geographic_scope).toEqual(p.geographic_scope)
    expect(e.deal_size_min_usd).toBe(p.deal_size_min_usd)
    expect(e.intl_required).toBe(p.intl_required)
    expect(e.removed).toEqual([])
  })

  it('narrows a dimension when the operator edits it', () => {
    const p = parse('excavator or tractor deal in Texas')
    const e = mergeConstraints(p, { asset_classes: ['agricultural_equipment'] }, { queryHasIntlKeyword: false })
    expect(e.asset_classes).toEqual(['agricultural_equipment'])
  })

  it('accepts a facet value the sentence never mentioned', () => {
    const p = parse('a $6M equipment deal')
    const e = mergeConstraints(p, { usage_codes: ['lease'] }, { queryHasIntlKeyword: false })
    expect(e.usage_codes).toEqual(['lease'])
  })

  describe('the international requirement is derived, never client-supplied', () => {
    it('disarms when the foreign country that armed it is removed', () => {
      // The bug this exists to prevent: drop the Brazil chip and the intl
      // hard-exclude stays on, silently dropping every Domestic-only lender
      // from a search that no longer mentions anywhere foreign.
      const p = parse('tractor financing in Brazil for $3M')
      expect(p.intl_required).toBe(true)
      const e = mergeConstraints(p, { geographic_scope: [] }, { queryHasIntlKeyword: false })
      expect(e.intl_required).toBe(false)
      expect(e.removed).toContain('geographic_scope')
      expect(e.removed).toContain('intl')
    })

    it('stays armed while any foreign country remains', () => {
      const p = parse('an equipment deal covering Brazil and Argentina')
      const e = mergeConstraints(p, { geographic_scope: ['Argentina'] }, { queryHasIntlKeyword: false })
      expect(e.intl_required).toBe(true)
      expect(e.removed).not.toContain('intl')
    })

    it('re-arms from a foreign country even if the client tried to switch it off', () => {
      // A client cannot un-state a foreign deal. Honouring that would put
      // US-only lenders in front of a Brazil deal — the exact wrong-lender case.
      const p = parse('tractor financing in Brazil for $3M')
      const e = mergeConstraints(
        p,
        { intl_keyword_active: false },
        { queryHasIntlKeyword: false },
      )
      expect(e.intl_required).toBe(true)
    })

    it('can be switched off when it came only from a generic keyword', () => {
      const p = parse('an international equipment deal around $12M')
      expect(p.intl_required).toBe(true)
      const e = mergeConstraints(p, { intl_keyword_active: false }, { queryHasIntlKeyword: true })
      expect(e.intl_required).toBe(false)
      expect(e.removed).toContain('intl')
    })
  })

  describe('removed', () => {
    it('records a dropped size constraint so the UI can say so out loud', () => {
      const p = parse('a $8M equipment deal')
      const e = mergeConstraints(
        p,
        { deal_size_min_usd: null, deal_size_max_usd: null },
        { queryHasIntlKeyword: false },
      )
      expect(e.removed).toContain('deal_size_min_usd')
    })

    it('does not flag a dimension the sentence never stated', () => {
      const p = parse('an equipment deal')
      const e = mergeConstraints(p, { geographic_scope: [] }, { queryHasIntlKeyword: false })
      expect(e.removed).not.toContain('geographic_scope')
    })

    it('does not flag a merely narrowed dimension', () => {
      const p = parse('excavator or tractor deal')
      const e = mergeConstraints(p, { asset_classes: ['agricultural_equipment'] }, { queryHasIntlKeyword: false })
      expect(e.removed).toEqual([])
    })
  })

  describe('does not trust client values on the dimensions that hard-exclude', () => {
    it('ignores a geography the server never parsed', () => {
      // The failure this prevents: "Brazil " with a stray space would miss the
      // foreign-country lookup, silently disarm the international requirement,
      // and put US-only lenders in front of a Brazil deal.
      const p = parse('tractor financing in Brazil for $3M')
      const e = mergeConstraints(p, { geographic_scope: ['Brazil '] }, { queryHasIntlKeyword: false })
      expect(e.geographic_scope).toEqual([])
      // And since the scope is now empty, intl correctly disarms rather than
      // being left armed against a geography nobody stated.
      expect(e.intl_required).toBe(false)
      expect(e.removed).toContain('geographic_scope')
    })

    it('keeps a geography the server did parse', () => {
      const p = parse('an equipment deal in Texas and California')
      const e = mergeConstraints(p, { geographic_scope: ['Texas'] }, { queryHasIntlKeyword: false })
      expect(e.geographic_scope).toEqual(['Texas'])
    })

    it('drops an asset class outside the known vocabulary', () => {
      // An unrecognised class would contradict every lender and empty the list.
      const p = parse('a $5M deal')
      const e = mergeConstraints(
        p,
        { asset_classes: ['construction_equipment', 'space_elevator'] },
        { queryHasIntlKeyword: false },
      )
      expect(e.asset_classes).toEqual(['construction_equipment'])
    })

    it('still lets the facet ADD a valid asset class the sentence never mentioned', () => {
      const p = parse('a $5M deal')
      const e = mergeConstraints(p, { asset_classes: ['vehicles'] }, { queryHasIntlKeyword: false })
      expect(e.asset_classes).toEqual(['vehicles'])
    })
  })

  it('distinguishes an explicit empty array from an absent override', () => {
    const p = parse('an equipment deal in Texas')
    expect(mergeConstraints(p, {}, { queryHasIntlKeyword: false }).geographic_scope).toEqual(
      p.geographic_scope,
    )
    expect(
      mergeConstraints(p, { geographic_scope: [] }, { queryHasIntlKeyword: false })
        .geographic_scope,
    ).toEqual([])
  })

  it('lets an explicit null clear one side of a size range', () => {
    const p = parse('a deal between $2M and $9M')
    const e = mergeConstraints(p, { deal_size_max_usd: null }, { queryHasIntlKeyword: false })
    expect(e.deal_size_min_usd).toBe(2_000_000)
    expect(e.deal_size_max_usd).toBeNull()
    expect(e.removed).not.toContain('deal_size_min_usd') // min still stands
  })
})

describe('hasForeignGeo', () => {
  it('recognises foreign countries and ignores US geography', () => {
    expect(hasForeignGeo(['Brazil'])).toBe(true)
    expect(hasForeignGeo(['Texas', 'California'])).toBe(false)
    expect(hasForeignGeo([])).toBe(false)
  })
})
