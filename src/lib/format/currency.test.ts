import { describe, it, expect } from 'vitest'
import { digitsOnly, groupThousands, formatCurrencyInput, formatUsdCompact } from './currency'

describe('formatUsdCompact', () => {
  it('rolls over to billions', () => {
    // The bug seen on screen: a $10B ceiling rendered as "$10000M" in the deal
    // appetite column, because no copy of this formatter had a billions branch.
    expect(formatUsdCompact(10_000_000_000)).toBe('$10B')
    expect(formatUsdCompact(1_200_000_000)).toBe('$1.2B')
  })

  it('shows a decimal below ten units and drops it above', () => {
    expect(formatUsdCompact(8_500_000)).toBe('$8.5M')
    expect(formatUsdCompact(25_000_000)).toBe('$25M')
  })

  it('never leaves a trailing .0 — "$8M" and "$8.0M" must not both exist', () => {
    expect(formatUsdCompact(8_000_000)).toBe('$8M')
    expect(formatUsdCompact(2_000_000)).toBe('$2M')
  })

  it('handles thousands and bare dollars', () => {
    expect(formatUsdCompact(750_000)).toBe('$750K')
    expect(formatUsdCompact(500)).toBe('$500')
  })

  it('renders a missing amount as an em dash, not $0', () => {
    // Blank appetite means "not stated"; "$0" would read as a real limit.
    expect(formatUsdCompact(null)).toBe('—')
    expect(formatUsdCompact(undefined)).toBe('—')
    expect(formatUsdCompact(0)).toBe('—')
  })
})

describe('currency input formatting', () => {
  it('strips non-digits', () => {
    expect(digitsOnly('10,000,000')).toBe('10000000')
    expect(digitsOnly('$8M')).toBe('8')
    expect(digitsOnly('abc')).toBe('')
  })

  it('groups thousands with commas at the right boundaries', () => {
    expect(groupThousands('')).toBe('')
    expect(groupThousands('1')).toBe('1')
    expect(groupThousands('100')).toBe('100')
    expect(groupThousands('1000')).toBe('1,000')
    expect(groupThousands('10000')).toBe('10,000')
    expect(groupThousands('100000')).toBe('100,000')
    expect(groupThousands('1000000')).toBe('1,000,000')
    expect(groupThousands('10000000')).toBe('10,000,000')
  })

  it('formats a raw value for display, blank stays blank (never "0")', () => {
    expect(formatCurrencyInput('10000000')).toBe('10,000,000')
    expect(formatCurrencyInput(8000000)).toBe('8,000,000')
    expect(formatCurrencyInput('')).toBe('')
    expect(formatCurrencyInput(null)).toBe('')
    expect(formatCurrencyInput(undefined)).toBe('')
  })

  it('is idempotent — re-formatting an already-comma’d value is stable', () => {
    expect(formatCurrencyInput('10,000,000')).toBe('10,000,000')
  })
})
