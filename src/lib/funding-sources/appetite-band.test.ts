import { describe, it, expect } from 'vitest'
import {
  bandGeometry,
  formatUsdCompact,
  APPETITE_DOMAIN_MIN,
  APPETITE_DOMAIN_MAX,
} from './appetite-band'

describe('bandGeometry', () => {
  it('reports no band when both bounds are unusable (null or 0)', () => {
    expect(bandGeometry({ lenderMin: null, lenderMax: null }).hasBand).toBe(false)
    expect(bandGeometry({ lenderMin: 0, lenderMax: 0 }).hasBand).toBe(false)
  })

  it('plots a closed band with start < end and both within 0–100', () => {
    const g = bandGeometry({ lenderMin: 1_000_000, lenderMax: 10_000_000 })
    expect(g.hasBand).toBe(true)
    expect(g.startPct).toBeGreaterThanOrEqual(0)
    expect(g.endPct).toBeLessThanOrEqual(100)
    expect(g.startPct).toBeLessThan(g.endPct)
  })

  it('uses a log scale — the midpoint of $250K–$250M sits near 50%, not far left', () => {
    // geometric mean of the domain is ~ $7.9M; on a linear scale it would be ~3%.
    const g = bandGeometry({ lenderMin: 7_900_000, lenderMax: 7_900_000 })
    expect(g.startPct).toBeGreaterThan(45)
    expect(g.startPct).toBeLessThan(55)
  })

  it('marks a deal inside the band as "in"', () => {
    const g = bandGeometry({ lenderMin: 1_000_000, lenderMax: 10_000_000, dealAmount: 5_000_000 })
    expect(g.dealPosition).toBe('in')
    expect(g.dealPct).not.toBeNull()
    expect(g.dealPct!).toBeGreaterThan(g.startPct)
    expect(g.dealPct!).toBeLessThan(g.endPct)
  })

  it('marks a deal below / above the stated band', () => {
    expect(
      bandGeometry({ lenderMin: 1_000_000, lenderMax: 10_000_000, dealAmount: 500_000 }).dealPosition
    ).toBe('below')
    expect(
      bandGeometry({ lenderMin: 1_000_000, lenderMax: 10_000_000, dealAmount: 50_000_000 }).dealPosition
    ).toBe('above')
  })

  it('treats a min-only band as open-ended upward (draws to the domain edge; deal above min is "in")', () => {
    const g = bandGeometry({ lenderMin: 5_000_000, lenderMax: null, dealAmount: 100_000_000 })
    expect(g.hasBand).toBe(true)
    expect(g.endPct).toBe(100)
    expect(g.dealPosition).toBe('in') // no stated ceiling → not "above"
  })

  it('treats a max-only band as open-ended downward (deal below max is "in")', () => {
    const g = bandGeometry({ lenderMin: null, lenderMax: 5_000_000, dealAmount: 400_000 })
    expect(g.startPct).toBe(0)
    expect(g.dealPosition).toBe('in') // no stated floor → not "below"
  })

  it('renders a point band when min === max', () => {
    const g = bandGeometry({ lenderMin: 8_000_000, lenderMax: 8_000_000 })
    expect(g.startPct).toBeCloseTo(g.endPct, 5)
  })

  it('clamps values outside the domain to the edges', () => {
    const below = bandGeometry({ lenderMin: 1, lenderMax: 1, dealAmount: 1 })
    expect(below.startPct).toBe(0)
    expect(below.dealPct).toBe(0)
    const above = bandGeometry({
      lenderMin: APPETITE_DOMAIN_MAX * 10,
      lenderMax: APPETITE_DOMAIN_MAX * 10,
      dealAmount: APPETITE_DOMAIN_MAX * 10,
    })
    expect(above.endPct).toBe(100)
    expect(above.dealPct).toBe(100)
  })

  it('ignores a zero/negative deal amount (no marker)', () => {
    const g = bandGeometry({ lenderMin: 1_000_000, lenderMax: 10_000_000, dealAmount: 0 })
    expect(g.dealPct).toBeNull()
    expect(g.dealPosition).toBeNull()
  })

  it('domain constants bracket the asset-finance deal range', () => {
    expect(APPETITE_DOMAIN_MIN).toBeLessThan(1_000_000)
    expect(APPETITE_DOMAIN_MAX).toBeGreaterThan(100_000_000)
  })
})

describe('formatUsdCompact', () => {
  it('formats magnitudes and rejects empties', () => {
    expect(formatUsdCompact(250_000)).toBe('$250K')
    expect(formatUsdCompact(8_000_000)).toBe('$8M')
    expect(formatUsdCompact(200_000_000)).toBe('$200M')
    expect(formatUsdCompact(null)).toBe('—')
    expect(formatUsdCompact(0)).toBe('—')
  })
})
