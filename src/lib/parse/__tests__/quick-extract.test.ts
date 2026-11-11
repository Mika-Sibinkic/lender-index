import { describe, it, expect } from 'vitest'
import { quickExtract } from '@/lib/parse/quick-extract'

describe('quickExtract', () => {
  it('returns empty result for empty string', () => {
    const r = quickExtract('')
    expect(r.parsed).toEqual({})
    expect(r.confidence).toBe(0)
  })

  it('pulls email + phone from a basic signature', () => {
    const text = `
      Hi team — wanted to introduce Pat who runs equipment lending at our shop.

      ---
      Pat Sample
      Director, Sample Programs
      Spica Corporate Finance
      psample@spica-cf.example
      +1 949 555 0193
    `
    const r = quickExtract(text)
    expect(r.parsed.primary_contact_email).toBe('psample@spica-cf.example')
    expect(r.parsed.primary_contact_phone).toBeTruthy()
    expect(r.parsed.primary_contact_name).toBe('Pat Sample')
    expect(r.parsed.primary_contact_title).toContain('Sample Programs')
    expect(r.parsed.company_name).toBe('Spica Corporate Finance')
    expect(r.parsed.asset_classes).toContain('equipment')
    expect(r.confidence).toBeGreaterThan(0.6)
  })

  it('extracts deal-size range from prose', () => {
    const text = `
      We do deal sizes $5M-$75M, focused on excavator and MRI financing.
      Jordan Fixture
      jfixture@quarry-eq.example
    `
    const r = quickExtract(text)
    expect(r.parsed.deal_size_min_usd).toBe(5_000_000)
    expect(r.parsed.deal_size_max_usd).toBe(75_000_000)
    expect(r.parsed.asset_classes).toEqual(
      expect.arrayContaining(['construction_equipment', 'medical_equipment'])
    )
  })

  it('extracts revenue + years-in-business requirements', () => {
    const text = `
      Spica typically requires $15MM+ in revenue, 4-6 years in business, $250k CapEx.
      Email: deals@spica.example
    `
    const r = quickExtract(text)
    expect(r.parsed.borrower_revenue_min_usd).toBe(15_000_000)
    expect(r.parsed.borrower_years_in_business_min).toBe(4)
    expect(r.parsed.borrower_capex_min_usd).toBe(250_000)
  })

  it('falls back to email domain for company when signature is silent', () => {
    const text = `
      Reach out to me directly:
      Casey Placeholder
      cplaceholder@brightfold.example
    `
    const r = quickExtract(text)
    expect(r.parsed.company_name).toBe('Brightfold')
  })

  it('preserves the raw paste in internal_notes', () => {
    const text = `Some random funding source intro text here.`
    const r = quickExtract(text)
    expect(r.parsed.internal_notes).toContain('[QUICK-ADD]')
    expect(r.parsed.internal_notes).toContain('Some random funding')
  })

  it('never treats the prepended "Filename:" AI-hint line as contact/company', () => {
    // Regression: a PDF flyer (dense text, no signature) parsed
    // primary_contact_name = "Filename: Mirach Asset Finance Flyer.pdf" because the
    // signature tail-scan read the hint line as a person name.
    const text =
      'Filename: Mirach Asset Finance Flyer.pdf\n\n' +
      'Transaction profile Size: $5,000,000 to $100,000,000 Term: 3 to 12 years ' +
      'Capital leases Fair market value leases AlkaidBank Corporate Asset Finance'
    const r = quickExtract(text)
    expect(r.parsed.primary_contact_name ?? '').not.toContain('Filename')
    expect(r.parsed.primary_contact_title ?? '').not.toContain('Filename')
    expect(r.parsed.company_name ?? '').not.toContain('Filename')
  })
})
