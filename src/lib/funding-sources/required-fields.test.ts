import { describe, it, expect } from 'vitest'
import {
  REQUIRED_CORE_FIELDS,
  CONDITIONAL_REQUIRED_FIELDS,
  isFieldFilled,
  isInternational,
  requiredFieldsFor,
  computeRequiredGaps,
  isRecordComplete,
} from './required-fields'

/** A fully-populated Domestic lender (every core field filled). */
const completeDomestic: Record<string, unknown> = {
  lender_type: 'Bank',
  company_name: 'AlkaidBank',
  primary_contact_name: 'Jane Roe',
  primary_contact_email: 'jane@alkaidbank.example.com',
  deal_size_min_usd: 5_000_000,
  deal_size_max_usd: 100_000_000,
  intl_domestic: 'Domestic',
  geographic_scope: ['United States'],
  specific_geographic: 'Southeast',
  asset_subtypes: ['Used'],
  usage_codes: 'owner, lease',
  operation_category: 'Personal',
  vintage_restriction: 'None',
  lending_status: 'Active',
}

describe('isFieldFilled', () => {
  it('empty/blank values are not filled', () => {
    expect(isFieldFilled(null)).toBe(false)
    expect(isFieldFilled(undefined)).toBe(false)
    expect(isFieldFilled('')).toBe(false)
    expect(isFieldFilled('   ')).toBe(false)
    expect(isFieldFilled([])).toBe(false)
    expect(isFieldFilled(NaN)).toBe(false)
  })
  it('present values are filled — including 0', () => {
    expect(isFieldFilled('x')).toBe(true)
    expect(isFieldFilled(0)).toBe(true)
    expect(isFieldFilled(4_000_000)).toBe(true)
    expect(isFieldFilled(['Used'])).toBe(true)
    expect(isFieldFilled(false)).toBe(true)
  })
})

describe('isInternational', () => {
  it('International / Both / I → true', () => {
    expect(isInternational({ intl_domestic: 'International' })).toBe(true)
    expect(isInternational({ intl_domestic: 'Both' })).toBe(true)
    expect(isInternational({ intl_domestic: 'I' })).toBe(true)
    expect(isInternational({ intl_domestic: '(I) International' })).toBe(true)
  })
  it('Domestic / D / blank → false', () => {
    expect(isInternational({ intl_domestic: 'Domestic' })).toBe(false)
    expect(isInternational({ intl_domestic: 'D' })).toBe(false)
    expect(isInternational({ intl_domestic: '' })).toBe(false)
    expect(isInternational({})).toBe(false)
  })
})

describe('required field set', () => {
  it('Notes is NOT required (optional by decision)', () => {
    const keys = REQUIRED_CORE_FIELDS.map((f) => f.key)
    expect(keys).not.toContain('internal_notes')
  })
  it('Bank Paid Fee is conditional, not core', () => {
    const coreKeys = REQUIRED_CORE_FIELDS.map((f) => f.key)
    expect(coreKeys).not.toContain('bank_paid_fee')
    expect(CONDITIONAL_REQUIRED_FIELDS.map((f) => f.key)).toContain('bank_paid_fee')
  })
  it('all 13 core template fields are present', () => {
    expect(REQUIRED_CORE_FIELDS).toHaveLength(13)
  })
  it('Geography Detail is NOT required — it was removed from both forms', () => {
    // `specific_geographic` came off the intake card and the detail view:
    // measured over a real roster it mostly duplicated the places list or held
    // the bare word "All", and changed ZERO matcher verdicts. Requiring a field
    // no form asks for would flag every record
    // incomplete forever.
    expect(REQUIRED_CORE_FIELDS.map((f) => f.key)).not.toContain('specific_geographic')
  })
})

describe('requiredFieldsFor — conditional Bank Paid Fee', () => {
  it('Domestic record does not require Bank Paid Fee', () => {
    const keys = requiredFieldsFor(completeDomestic).map((f) => f.key)
    expect(keys).not.toContain('bank_paid_fee')
  })
  it('International record requires Bank Paid Fee', () => {
    const keys = requiredFieldsFor({ ...completeDomestic, intl_domestic: 'International' }).map(
      (f) => f.key
    )
    expect(keys).toContain('bank_paid_fee')
  })
})

describe('computeRequiredGaps / isRecordComplete', () => {
  it('empty record → all core fields are gaps, no Bank Paid Fee (not international)', () => {
    const gaps = computeRequiredGaps({})
    expect(gaps).toHaveLength(REQUIRED_CORE_FIELDS.length)
    expect(gaps).not.toContain('bank_paid_fee')
    expect(isRecordComplete({})).toBe(false)
  })
  it('complete Domestic record → no gaps', () => {
    expect(computeRequiredGaps(completeDomestic)).toEqual([])
    expect(isRecordComplete(completeDomestic)).toBe(true)
  })
  it('International record missing Bank Paid Fee → that is the only gap', () => {
    const intl = { ...completeDomestic, intl_domestic: 'International' }
    expect(computeRequiredGaps(intl)).toEqual(['bank_paid_fee'])
    expect(isRecordComplete(intl)).toBe(false)
  })
  it('International record with Bank Paid Fee → complete', () => {
    const intl = { ...completeDomestic, intl_domestic: 'International', bank_paid_fee: 'N' }
    expect(isRecordComplete(intl)).toBe(true)
  })
  it('empty array + whitespace string count as gaps', () => {
    const gaps = computeRequiredGaps({ ...completeDomestic, geographic_scope: [], specific_geographic: '   ' })
    expect(gaps).toContain('geographic_scope')
    // specific_geographic is no longer required — see the set test above.
    expect(gaps).not.toContain('specific_geographic')
  })
})
