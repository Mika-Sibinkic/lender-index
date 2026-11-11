import { describe, it, expect } from 'vitest'
import { ASSET_CLASSES } from '@/lib/types/funding-source'
import { ASSET_VISUALS, assetVisual, orderAssets } from './asset-visuals'

// lucide-react components are forwardRef objects, not plain functions.
const isReactComponent = (c: unknown) =>
  typeof c === 'function' || (typeof c === 'object' && c !== null)

describe('asset-visuals', () => {
  it('every canonical ASSET_CLASSES value has a glyph + non-empty label', () => {
    for (const c of ASSET_CLASSES) {
      const v = ASSET_VISUALS[c]
      expect(v, `missing visual for "${c}"`).toBeDefined()
      expect(isReactComponent(v.Icon), `"${c}" has no glyph`).toBe(true)
      expect(v.label.length).toBeGreaterThan(0)
    }
  })

  it('falls back safely for an unknown class (humanized label, defined glyph)', () => {
    const v = assetVisual('space_elevator')
    expect(v.label).toBe('space elevator')
    expect(isReactComponent(v.Icon)).toBe(true)
  })

  it('orders specific/decision-relevant families before generic ones', () => {
    const ordered = orderAssets(['other', 'equipment', 'medical_equipment', 'agricultural_equipment'])
    expect(ordered.indexOf('medical_equipment')).toBeLessThan(ordered.indexOf('equipment'))
    expect(ordered.indexOf('agricultural_equipment')).toBeLessThan(ordered.indexOf('equipment'))
    expect(ordered.indexOf('equipment')).toBeLessThan(ordered.indexOf('other'))
  })

  it('does not mutate the input array', () => {
    const input = ['other', 'medical_equipment']
    orderAssets(input)
    expect(input).toEqual(['other', 'medical_equipment'])
  })
})
