import { describe, it, expect } from 'vitest'
import { vintageOptions, vintageYears, vintageLabel, VINTAGE_NO_RESTRICTION } from './vintage'

describe('vintageOptions', () => {
  it('steps one year at a time', () => {
    const years = vintageYears(2026)
    for (let i = 1; i < years.length; i++) {
      expect(years[i - 1] - years[i]).toBe(1)
    }
  })

  it('offers the years the old 5-year list skipped', () => {
    const opts = vintageOptions(2026)
    for (const y of [2003, 2011, 2019, 2024]) {
      expect(opts).toContain(vintageLabel(y))
    }
  })

  it('keeps every value the old 5-year list could produce, so stored rows still match', () => {
    const opts = vintageOptions(2026)
    for (const y of [1980, 1985, 1990, 1995, 2000, 2005, 2010, 2015, 2020, 2025]) {
      expect(opts).toContain(`${y} or newer`)
    }
  })

  it('leads with "No restriction", then the newest year', () => {
    const opts = vintageOptions(2026)
    expect(opts[0]).toBe(VINTAGE_NO_RESTRICTION)
    expect(opts[1]).toBe('2026 or newer')
  })

  it('tracks the current year rather than a hardcoded ceiling', () => {
    expect(vintageOptions(2030)[1]).toBe('2030 or newer')
    expect(vintageOptions(2030)).not.toContain('2031 or newer')
  })

  it('ends at the oldest offered year and has no duplicates', () => {
    const opts = vintageOptions(2026)
    expect(opts.at(-1)).toBe('1960 or newer')
    expect(new Set(opts).size).toBe(opts.length)
  })
})
