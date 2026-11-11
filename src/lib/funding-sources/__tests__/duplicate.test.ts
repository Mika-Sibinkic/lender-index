import { describe, it, expect } from 'vitest'
import { isDuplicateCompanyError } from '../duplicate'

describe('isDuplicateCompanyError', () => {
  it('flags SQLSTATE 23505 (unique violation)', () => {
    expect(isDuplicateCompanyError({ code: '23505', message: 'duplicate key value' })).toBe(true)
  })

  it('flags the company_name unique-index by name when code is absent', () => {
    expect(
      isDuplicateCompanyError({
        message:
          'duplicate key value violates unique constraint "funding_sources_company_name_key"',
      }),
    ).toBe(true)
  })

  it('does NOT flag other DB errors', () => {
    expect(isDuplicateCompanyError({ code: '23503', message: 'foreign key violation' })).toBe(false)
    expect(isDuplicateCompanyError({ code: '42P01', message: 'relation does not exist' })).toBe(false)
  })

  it('is null/empty safe', () => {
    expect(isDuplicateCompanyError(null)).toBe(false)
    expect(isDuplicateCompanyError(undefined)).toBe(false)
    expect(isDuplicateCompanyError({})).toBe(false)
  })
})
