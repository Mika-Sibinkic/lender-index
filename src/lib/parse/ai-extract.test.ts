import { describe, it, expect } from 'vitest'
import { coerceToSchema } from './ai-extract'

describe('coerceToSchema — spreadsheet template fields (0017)', () => {
  it('maps full English labels for controlled fields', () => {
    const out = coerceToSchema({
      company_name: 'Acme Capital',
      lender_type: 'Non Bank',
      intl_domestic: 'International',
      operation_category: 'Personal',
    })
    expect(out.lender_type).toBe('Non Bank')
    expect(out.intl_domestic).toBe('International')
    expect(out.operation_category).toBe('Personal')
  })

  it('maps the spreadsheet letter codes and config labels onto canonical values', () => {
    const out = coerceToSchema({
      company_name: 'Acme',
      lender_type: 'NB',
      intl_domestic: 'D',
      operation_category: 'Commercial use',
    })
    expect(out.lender_type).toBe('Non Bank')
    expect(out.intl_domestic).toBe('Domestic')
    expect(out.operation_category).toBe('Commercial')
  })

  it('never guesses an unmatched controlled value (stays undefined)', () => {
    const out = coerceToSchema({
      company_name: 'Acme',
      lender_type: 'something weird',
      intl_domestic: 'maybe',
    })
    expect(out.lender_type).toBeUndefined()
    expect(out.intl_domestic).toBeUndefined()
  })

  it('normalizes asset_subtypes against the display taxonomy and drops junk', () => {
    const out = coerceToSchema({
      company_name: 'Acme',
      asset_subtypes: ['used', 'NEW', 'spaceship', 'refurbished'],
    })
    expect(out.asset_subtypes).toEqual(['Used', 'New', 'Refurbished'])
  })

  it('passes free-text fields through trimmed', () => {
    const out = coerceToSchema({
      company_name: 'Acme',
      specific_geographic: '  Southeast US only  ',
      usage_codes: 'owner, lease',
      vintage_restriction: 'no assets older than 20 years',
      lending_status: 'actively lending',
      bank_paid_fee: 'Y',
    })
    expect(out.specific_geographic).toBe('Southeast US only')
    expect(out.usage_codes).toBe('owner, lease')
    expect(out.vintage_restriction).toBe('no assets older than 20 years')
    expect(out.lending_status).toBe('actively lending')
    expect(out.bank_paid_fee).toBe('Y')
  })

  it('still extracts the core fields (no regression)', () => {
    const out = coerceToSchema({
      company_name: 'Acme Capital',
      deal_size_min_usd: 5000000,
      asset_classes: ['construction_equipment', 'not_a_class'],
      geographic_scope: ['US', 'Canada'],
    })
    expect(out.company_name).toBe('Acme Capital')
    expect(out.deal_size_min_usd).toBe(5000000)
    expect(out.asset_classes).toEqual(['construction_equipment'])
    expect(out.geographic_scope).toEqual(['US', 'Canada'])
  })
})
