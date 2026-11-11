import { describe, it, expect, vi } from 'vitest'
import {
  tokenizeQuery,
  fundingSourceIdsWithPastDeal,
  applyPastDealBoost,
} from './past-deal-boost'

describe('tokenizeQuery', () => {
  it('extracts a 4-digit year', () => {
    expect(tokenizeQuery('1987 Caterpillar midwest').year).toBe(1987)
    expect(tokenizeQuery('looking for a 2015 Kubota M7').year).toBe(2015)
    expect(tokenizeQuery('no year here').year).toBeNull()
  })

  it('detects the configured makes', () => {
    expect(tokenizeQuery('1987 Caterpillar').makes).toContain('caterpillar')
    expect(tokenizeQuery('John Deere and Komatsu').makes.sort()).toEqual(['john deere', 'komatsu'])
    expect(tokenizeQuery('something generic').makes).toEqual([])
  })
})

describe('applyPastDealBoost', () => {
  it('moves boosted ids to the front, preserves order within groups', () => {
    expect(applyPastDealBoost(['a', 'b', 'c', 'd'], new Set(['b', 'd']))).toEqual([
      'b',
      'd',
      'a',
      'c',
    ])
  })

  it('no-ops when nothing matches', () => {
    expect(applyPastDealBoost(['a', 'b'], new Set())).toEqual(['a', 'b'])
  })
})

describe('fundingSourceIdsWithPastDeal', () => {
  it('returns empty when no tokens', async () => {
    const out = await fundingSourceIdsWithPastDeal({} as never, { year: null, makes: [] }, ['a'])
    expect(out.size).toBe(0)
  })

  it('returns empty when no candidates', async () => {
    const out = await fundingSourceIdsWithPastDeal(
      {} as never,
      { year: 1987, makes: ['caterpillar'] },
      [],
    )
    expect(out.size).toBe(0)
  })

  it('matches by make/model substring', async () => {
    const data = [
      { funding_source_id: 'fs-1', asset_make: 'Caterpillar', asset_model: '320' },
      { funding_source_id: 'fs-2', asset_make: 'Kubota', asset_model: 'M7' },
    ]
    const inFn = vi.fn(() => Promise.resolve({ data }))
    const gte = vi.fn(() => ({ lte: vi.fn(() => Promise.resolve({ data })) }))
    const inFn2 = vi.fn(() => ({ gte }))
    const notFn = vi.fn(() => ({ in: inFn2 }))
    const select = vi.fn(() => ({ not: notFn }))
    const from = vi.fn(() => ({ select }))
    const sb = { from } as never
    // Year-bounded variant:
    const out1 = await fundingSourceIdsWithPastDeal(
      sb,
      { year: 1990, makes: ['caterpillar'] },
      ['fs-1', 'fs-2'],
    )
    expect(out1.has('fs-1')).toBe(true)
    expect(out1.has('fs-2')).toBe(false)

    // No-year variant uses .in directly (no gte/lte path):
    const inFnNoYear = vi.fn(() => Promise.resolve({ data }))
    const notFnNY = vi.fn(() => ({ in: inFnNoYear }))
    const selNY = vi.fn(() => ({ not: notFnNY }))
    const sbNY = { from: vi.fn(() => ({ select: selNY })) } as never
    const out2 = await fundingSourceIdsWithPastDeal(
      sbNY,
      { year: null, makes: ['kubota'] },
      ['fs-1', 'fs-2'],
    )
    expect(out2.has('fs-2')).toBe(true)
    expect(out2.has('fs-1')).toBe(false)
  })
})
