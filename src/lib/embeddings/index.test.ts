import { describe, it, expect } from 'vitest'
import { sourceText, rrf } from './index'

describe('sourceText', () => {
  it('concatenates company + notes + rate notes', () => {
    const s = sourceText({
      company_name: 'Altair Bank',
      internal_notes: 'great relationship',
      rate_notes: 'SOFR + 250',
    })
    expect(s).toContain('Altair Bank')
    expect(s).toContain('great relationship')
    expect(s).toContain('SOFR + 250')
  })

  it('omits empty/null fields entirely', () => {
    const s = sourceText({
      company_name: 'Altair',
      internal_notes: '',
      rate_notes: null,
    })
    expect(s).toBe('Altair')
  })

  it('annotates prepayment_penalty inline', () => {
    const s = sourceText({
      company_name: 'X',
      internal_notes: null,
      rate_notes: null,
      prepayment_penalty: '3% Y1, 2% Y2',
    })
    expect(s).toContain('prepayment: 3% Y1, 2% Y2')
  })
})

describe('rrf', () => {
  it('merges two ranked lists; doubly-ranked IDs win', () => {
    const merged = rrf([
      ['a', 'b', 'c'],
      ['b', 'a', 'd'],
    ])
    expect(merged[0]).toBe('a') // a is rank 0 + 1
    expect(merged[1]).toBe('b') // b is rank 1 + 0
    expect(merged).toContain('c')
    expect(merged).toContain('d')
  })

  it('handles empty input', () => {
    expect(rrf([])).toEqual([])
    expect(rrf([[]])).toEqual([])
  })

  it('respects k parameter (smaller k = bigger spread)', () => {
    const ranks = rrf([['a', 'b'], ['b', 'a']], 1)
    expect(ranks).toEqual(['a', 'b']) // a wins on the 1/(1+1)+1/(1+2)= .833 vs b .833 - tie broken by first-seen
  })
})
