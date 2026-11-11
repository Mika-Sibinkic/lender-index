import { describe, it, expect } from 'vitest'
import { buildFundingSourceQuery } from '@/lib/queries/funding-sources'

describe('buildFundingSourceQuery', () => {
  it('produces empty filters with empty input', () => {
    const q = buildFundingSourceQuery({})
    expect(q.assetClasses).toEqual([])
    expect(q.search).toBe('')
    expect(q.dealMin).toBeNull()
  })

  it('parses comma-separated asset classes', () => {
    const q = buildFundingSourceQuery({ asset_classes: 'equipment,agricultural_equipment' })
    expect(q.assetClasses).toEqual(['equipment', 'agricultural_equipment'])
  })

  it('coerces deal-size band to numbers', () => {
    const q = buildFundingSourceQuery({ deal_min: '500000', deal_max: '5000000' })
    expect(q.dealMin).toBe(500000)
    expect(q.dealMax).toBe(5000000)
  })

  it('passes through status', () => {
    const q = buildFundingSourceQuery({ status: 'dormant' })
    expect(q.status).toBe('dormant')
  })
})
