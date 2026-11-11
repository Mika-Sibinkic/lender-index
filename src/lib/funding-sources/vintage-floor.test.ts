/**
 * The search menu and the intake picker must offer the same oldest year.
 *
 * The "Asset age" menu once floored at 1980 while intake allowed
 * a cutoff back to 1960, so a lender whose record said "1975 or newer" could be
 * entered and then never picked from the menu — a deal the product can record
 * but cannot search for. Two constants, one meaning, is how that happens; this
 * pins them to one.
 */

import { describe, it, expect } from 'vitest'
import { VINTAGE_OLDEST_YEAR, vintageYears, parseVintageRule } from './vintage'

describe('one asset-year floor', () => {
  it('intake offers every year down to the floor', () => {
    const years = vintageYears(2026)
    expect(years[0]).toBe(2026)
    expect(years[years.length - 1]).toBe(VINTAGE_OLDEST_YEAR)
  })

  it('a cutoff at the floor still parses as a year rule', () => {
    // If the floor and the parser disagree, a record at the boundary reads as
    // `unknown` and silently stops filtering.
    const rule = parseVintageRule(`${VINTAGE_OLDEST_YEAR} or newer`)
    expect(rule).toEqual({ kind: 'min_year', year: VINTAGE_OLDEST_YEAR })
  })

  it('the year below the floor is NOT silently accepted as a rule', () => {
    const rule = parseVintageRule(`${VINTAGE_OLDEST_YEAR - 1} or newer`)
    expect(rule.kind).not.toBe('min_year')
  })
})
