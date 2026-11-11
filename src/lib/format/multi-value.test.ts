import { describe, it, expect } from 'vitest'
import { splitMultiValue, joinMultiValue, multiValueMatches } from './multi-value'

describe('splitMultiValue', () => {
  it('keeps spaces inside a value — the bug users reported', () => {
    expect(splitMultiValue('United States, New York')).toEqual(['United States', 'New York'])
  })

  it('survives a half-typed entry without eating the trailing space', () => {
    // "United " must stay "United " in the raw buffer; the commit only trims at
    // the boundary. This is the exact keystroke that used to be swallowed.
    expect(splitMultiValue('United ')).toEqual(['United'])
    expect(joinMultiValue(splitMultiValue('United States'))).toBe('United States')
  })

  it('accepts comma with or without a space', () => {
    expect(splitMultiValue('US,Brazil')).toEqual(['US', 'Brazil'])
    expect(splitMultiValue('US, Brazil')).toEqual(['US', 'Brazil'])
  })

  it('normalises liberally: semicolon, slash, newline, tab', () => {
    expect(splitMultiValue('US / Brazil')).toEqual(['US', 'Brazil'])
    expect(splitMultiValue('US; Brazil')).toEqual(['US', 'Brazil'])
    expect(splitMultiValue('US\nBrazil')).toEqual(['US', 'Brazil'])
    expect(splitMultiValue('US\tBrazil')).toEqual(['US', 'Brazil'])
  })

  it('handles a column pasted out of Excel', () => {
    expect(splitMultiValue('United States\r\nBrazil\r\nMexico\r\n')).toEqual([
      'United States',
      'Brazil',
      'Mexico',
    ])
  })

  it('drops empties from doubled or trailing delimiters', () => {
    expect(splitMultiValue('US,,Brazil,')).toEqual(['US', 'Brazil'])
    expect(splitMultiValue('   ')).toEqual([])
    expect(splitMultiValue('')).toEqual([])
  })
})

describe('multiValueMatches', () => {
  it('is true when the buffer already says the same thing', () => {
    expect(multiValueMatches('United States, Brazil', ['United States', 'Brazil'])).toBe(true)
    expect(multiValueMatches('United States,Brazil', ['United States', 'Brazil'])).toBe(true)
  })

  it('is false when the array changed underneath (an AI parse landed)', () => {
    expect(multiValueMatches('United States', ['United States', 'Brazil'])).toBe(false)
    expect(multiValueMatches('', ['Brazil'])).toBe(false)
  })

  it('treats mid-typing text as still matching so a re-render cannot clobber it', () => {
    // User has typed "United States, Braz" — the committed array is still the
    // one-entry version, so the two genuinely differ and the buffer wins.
    expect(multiValueMatches('United States, Braz', ['United States'])).toBe(false)
  })
})
