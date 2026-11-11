/**
 * The two guards that decide whether a bare query is a NAME lookup, a KIND
 * request, or neither.
 *
 * The name lookup exists so that searching a lender's name returns that
 * lender, not a tail of unrelated ones. But typing `bank` rendered "Lenders
 * whose name matches "bank"" and 25 rows. `bank` matches about half the
 * company names in a typical roster, so a request for a lender KIND got the
 * wrong question answered — a name page capped at the display limit, with
 * every bank whose name lacks the word missing entirely.
 */

import { describe, it, expect } from 'vitest'
import { bareLenderKind, nameLookupIsSpecific } from '@/lib/search/lookup'

const ROSTER = 300 // illustrative roster size

describe('a bare query that is a lender KIND', () => {
  it('resolves to the stored vocabulary value', () => {
    expect(bareLenderKind('bank')).toBe('Bank')
    expect(bareLenderKind('Bank')).toBe('Bank')
    expect(bareLenderKind('banks')).toBe('Bank')
    expect(bareLenderKind('  BANK  ')).toBe('Bank')
    expect(bareLenderKind('credit union')).toBe('Credit Union')
    expect(bareLenderKind('credit unions')).toBe('Credit Union')
    expect(bareLenderKind('non bank')).toBe('Non Bank')
    expect(bareLenderKind('non-bank')).toBe('Non Bank')
    expect(bareLenderKind('private equity')).toBe('Private Equity')
  })

  it('leaves a company NAME to the name lookup, even when it contains the kind', () => {
    // Many rows have "bank" in the name. Every one of them must still be
    // findable by name — that is the name-lookup fix, and it must not regress.
    for (const q of [
      'Castor Bank',
      'Bank of the Nashira',
      '1st Deneb Bank',
      'Alnair Bank (Nunki)',
      'Rigel',
      'Pollux',
      'Sadr Credit Union',
    ]) {
      expect(bareLenderKind(q)).toBeNull()
    }
  })

  it('is not fooled by a deal sentence that mentions a kind', () => {
    for (const q of ['a bank for a Caterpillar', 'banks in Texas', 'private equity backed borrower']) {
      expect(bareLenderKind(q)).toBeNull()
    }
  })

  it('returns null for an empty or punctuation-only query', () => {
    expect(bareLenderKind('')).toBeNull()
    expect(bareLenderKind('   ')).toBeNull()
    expect(bareLenderKind('--')).toBeNull()
  })
})

describe('a name lookup only answers when the term is specific', () => {
  it('answers for a real company name', () => {
    expect(nameLookupIsSpecific(1, ROSTER)).toBe(true) // Rigel
    expect(nameLookupIsSpecific(12, ROSTER)).toBe(true) // "first"
    expect(nameLookupIsSpecific(21, ROSTER)).toBe(true) // "capital"
  })

  it('declines a term matching half the roster', () => {
    // Roughly what `bank` matches. A term this broad is a browse, not a
    // lookup, and the ranked pipeline is the better answer.
    expect(nameLookupIsSpecific(150, ROSTER)).toBe(false)
  })

  it('declines when nothing matched', () => {
    expect(nameLookupIsSpecific(0, ROSTER)).toBe(false)
  })

  it('scales with the roster instead of pinning a constant', () => {
    // Staff are actively adding records. 40 hits is a browse against 300 rows
    // and a lookup against 4,000.
    expect(nameLookupIsSpecific(40, ROSTER)).toBe(false)
    expect(nameLookupIsSpecific(40, 4000)).toBe(true)
  })

  it('keeps small rosters usable via the floor', () => {
    expect(nameLookupIsSpecific(15, 30)).toBe(true)
  })
})
