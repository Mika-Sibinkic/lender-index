import { describe, it, expect } from 'vitest'
import { buildChips, removedNotice, sizeLabel, usdShort, assetLabel } from './chips'
import { extractDeal } from './extract-deal'
import { mergeConstraints, hasForeignGeo } from './constraints'

const effective = (q: string) =>
  mergeConstraints(extractDeal(q), undefined, { queryHasIntlKeyword: false })

const chipsFor = (q: string) =>
  buildChips(effective(q), { foreignGeos: (g) => hasForeignGeo([g]) })

describe('buildChips', () => {
  it('shows every criterion the search is actually using', () => {
    const labels = chipsFor(
      'finance a Caterpillar around $8M for a rental fleet company in Texas',
    ).map((c) => c.label)
    // Asset and usage chips read the labels from config.
    expect(labels).toContain('Construction equipment')
    expect(labels).toContain('Texas')
    expect(labels).toContain('$8M')
    expect(labels).toContain('Rental fleet')
  })

  it('gives each list value its own removable chip', () => {
    const chips = chipsFor('an excavator or tractor deal')
    const assets = chips.filter((c) => c.dim === 'asset_classes')
    expect(assets.length).toBeGreaterThan(1)
    expect(assets.every((c) => c.removable && c.value)).toBe(true)
  })

  it('renders a size RANGE as one chip, not two', () => {
    const chips = chipsFor('a deal between $2M and $9M')
    const size = chips.filter((c) => c.dim === 'deal_size_min_usd')
    expect(size).toHaveLength(1)
    expect(size[0].label).toBe('$2M–$9M')
  })

  describe('the international constraint', () => {
    it('does not offer a one-click removal of a named foreign country', () => {
      // Dropping "Brazil" is the one edit that could put a US-only lender in
      // front of a foreign deal, so it is not a one-click action.
      const brazil = chipsFor('tractor financing in Brazil for $3M').find(
        (c) => c.label === 'Brazil',
      )
      expect(brazil).toBeDefined()
      expect(brazil!.removable).toBe(false)
    })

    it('does not add a redundant "International" chip beside a country', () => {
      const labels = chipsFor('tractor financing in Brazil').map((c) => c.label)
      expect(labels).toContain('Brazil')
      expect(labels).not.toContain('International')
    })

    it('shows a removable "International" chip when only a keyword said so', () => {
      const e = mergeConstraints(extractDeal('an international equipment deal around $12M'), undefined, {
        queryHasIntlKeyword: true,
      })
      const intl = buildChips(e, { foreignGeos: (g) => hasForeignGeo([g]) }).find(
        (c) => c.dim === 'intl',
      )
      expect(intl).toBeDefined()
      expect(intl!.removable).toBe(true)
    })
  })

  it('produces no chips for a query that states nothing filterable', () => {
    expect(chipsFor('looking for a good lender')).toEqual([])
  })

  it('gives every chip a unique id', () => {
    const chips = chipsFor('excavator or tractor in Texas and California for $5M, owner operated and rental')
    expect(new Set(chips.map((c) => c.id)).size).toBe(chips.length)
  })
})

describe('removedNotice', () => {
  it('names a single dropped constraint in plain English', () => {
    expect(removedNotice(['geographic_scope'])).toBe(
      'Not filtering by location. You removed that from this search.',
    )
  })

  it('lists several', () => {
    const n = removedNotice(['asset_classes', 'deal_size_min_usd', 'intl'])
    expect(n).toContain('asset type, deal size and international')
  })

  it('is silent when nothing was dropped', () => {
    expect(removedNotice([])).toBeNull()
  })
})

describe('labels', () => {
  it('formats money the way a broker writes it', () => {
    expect(usdShort(8_000_000)).toBe('$8M')
    expect(usdShort(8_500_000)).toBe('$8.5M')
    expect(usdShort(750_000)).toBe('$750K')
    expect(usdShort(1_200_000_000)).toBe('$1.2B')
  })

  it('reads one-sided ranges as a broker would', () => {
    expect(sizeLabel(5_000_000, null)).toBe('$5M+')
    expect(sizeLabel(null, 5_000_000)).toBe('up to $5M')
    expect(sizeLabel(8_000_000, 8_000_000)).toBe('$8M')
    expect(sizeLabel(null, null)).toBeNull()
  })

  it('labels asset-class keys from config, humanising unknown ones', () => {
    expect(assetLabel('construction_equipment')).toBe('Construction equipment')
    expect(assetLabel('equipment')).toBe('Equipment (any type)')
    expect(assetLabel('commercial_trucks')).toBe('Commercial trucks')
    expect(assetLabel('working_capital')).toBe('Working capital')
    expect(assetLabel('space_elevator')).toBe('Space elevator')
  })
})
