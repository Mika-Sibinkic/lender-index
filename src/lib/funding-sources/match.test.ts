import { describe, it, expect } from 'vitest'
import {
  normalizeCompanyName,
  findLenderMatch,
  mergeNonEmpty,
  computeFieldChanges,
  computeGapFill,
  type MatchCandidate,
} from './match'

describe('normalizeCompanyName', () => {
  it('strips punctuation, case, and trailing legal suffixes', () => {
    expect(normalizeCompanyName('AlkaidBank, N.A.')).toBe('alkaidbank')
    expect(normalizeCompanyName('Markab Group Ltd')).toBe('markab group')
    expect(normalizeCompanyName('  Apple   Bank  ')).toBe('apple bank')
    expect(normalizeCompanyName('ALKAIDBANK')).toBe('alkaidbank')
  })
  it('does NOT strip industry words — no wrong-match collisions', () => {
    // "Apple Bank" and "Apple Capital" must stay distinct.
    expect(normalizeCompanyName('Apple Bank')).not.toBe(normalizeCompanyName('Apple Capital'))
  })
})

describe('findLenderMatch — high-precision, suggestion only', () => {
  const candidates: MatchCandidate[] = [
    { id: 'a', company_name: 'AlkaidBank, N.A.', primary_contact_email: 'deals@alkaidbank.example.com' },
    { id: 'b', company_name: 'Markab Group', primary_contact_email: 'john@markab.example.com' },
  ]

  it('matches a legal-suffix/case variant by normalized name', () => {
    const m = findLenderMatch({ company_name: 'alkaidbank' }, candidates)
    expect(m?.id).toBe('a')
    expect(m?.matched_on).toBe('company_name')
    expect(m?.score).toBe(1)
  })
  it('matches on exact email when the name differs', () => {
    const m = findLenderMatch(
      { company_name: 'Markab Bank Leasing', primary_contact_email: 'JOHN@markab.example.com' },
      candidates,
    )
    expect(m?.id).toBe('b')
    expect(m?.matched_on).toBe('email')
  })
  it('does NOT accept an email match when the names are unrelated (shared broker email)', () => {
    const shared: MatchCandidate[] = [
      { id: 'eagle', company_name: 'Eagle Capital', primary_contact_email: 'deals@brokerx.example' },
    ]
    // Same email, totally different firm → must NOT steer a dedup update.
    expect(
      findLenderMatch(
        { company_name: 'Falcon Credit Partners', primary_contact_email: 'deals@brokerx.example' },
        shared,
      ),
    ).toBeNull()
  })

  it('returns null for a genuinely new lender', () => {
    expect(findLenderMatch({ company_name: 'Brand New Capital' }, candidates)).toBeNull()
  })
  it('does not fuzzy-match a merely-similar name', () => {
    expect(findLenderMatch({ company_name: 'Ever' }, candidates)).toBeNull()
  })
})

describe('mergeNonEmpty — blank never overwrites', () => {
  it('drops empty incoming values', () => {
    const out = mergeNonEmpty({
      company_name: 'AlkaidBank',
      primary_contact_name: '',
      asset_subtypes: [],
      deal_size_min_usd: 0,
      lending_status: 'Active',
    })
    expect(out).toEqual({ company_name: 'AlkaidBank', deal_size_min_usd: 0, lending_status: 'Active' })
  })
})

describe('computeGapFill — fill blanks only, never clobber', () => {
  it('fills only fields empty in the existing record', () => {
    const before = {
      company_name: 'AlkaidBank',
      lending_status: 'Active',          // populated → protected
      usage_codes: '',                   // blank → fillable
      geographic_scope: [],              // blank array → fillable
    }
    const fromSheet = {
      company_name: 'ALKAIDBANK N.A.',      // populated in DB → NOT overwritten
      lending_status: 'Paused',          // populated in DB → NOT overwritten
      usage_codes: 'owner, lease',       // fills the blank
      geographic_scope: ['United States'], // fills the blank
      bank_paid_fee: '',                 // blank incoming → ignored
    }
    expect(computeGapFill(before, fromSheet)).toEqual({
      usage_codes: 'owner, lease',
      geographic_scope: ['United States'],
    })
  })
})

describe('computeFieldChanges — only real, differing updates', () => {
  it('lists non-empty incoming values that differ from existing', () => {
    const before = { company_name: 'AlkaidBank', primary_contact_name: 'John Doe', lending_status: 'Active' }
    const incoming = {
      company_name: 'AlkaidBank',           // unchanged → not listed
      primary_contact_name: 'Sarah Smith', // changed → listed
      lending_status: '',                  // blank → ignored (won't blank existing)
      bank_paid_fee: '2%',                 // new → listed
    }
    const changes = computeFieldChanges(before, incoming)
    const keys = changes.map((c) => c.key).sort()
    expect(keys).toEqual(['bank_paid_fee', 'primary_contact_name'])
    const name = changes.find((c) => c.key === 'primary_contact_name')!
    expect(name.from).toBe('John Doe')
    expect(name.to).toBe('Sarah Smith')
  })
})
