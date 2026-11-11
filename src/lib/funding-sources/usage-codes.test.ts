import { describe, it, expect } from 'vitest'
import { parseUsageCodes, toggleUsageCode } from './usage-codes'

describe('parseUsageCodes', () => {
  it('splits common separators', () => {
    expect(parseUsageCodes('owner, lease')).toEqual(['owner', 'lease'])
    expect(parseUsageCodes('owner; rental')).toEqual(['owner', 'rental'])
    expect(parseUsageCodes('owner/lease/rental')).toEqual(['owner', 'lease', 'rental'])
    expect(parseUsageCodes('')).toEqual([])
  })
})

describe('toggleUsageCode', () => {
  it('adds a code in canonical order', () => {
    expect(toggleUsageCode('', 'lease')).toBe('lease')
    expect(toggleUsageCode('lease', 'owner')).toBe('owner, lease')
    expect(toggleUsageCode('owner, rental', 'lease')).toBe('owner, lease, rental')
  })

  it('removes a code that is already selected', () => {
    expect(toggleUsageCode('owner, lease', 'lease')).toBe('owner')
    expect(toggleUsageCode('owner', 'owner')).toBe('')
  })

  it('preserves unknown tokens the AI extracted (no silent data loss)', () => {
    expect(toggleUsageCode('owner, logistics', 'lease')).toBe('owner, lease, logistics')
  })

  it('round-trips through parseUsageCodes', () => {
    expect(parseUsageCodes(toggleUsageCode('owner', 'lease'))).toEqual(['owner', 'lease'])
  })
})
