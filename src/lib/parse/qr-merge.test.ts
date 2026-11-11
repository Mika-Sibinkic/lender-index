import { describe, it, expect } from 'vitest'
import { applyQrContact } from './qr-merge'
import type { VCardContact } from './vcard'

const CARD: VCardContact = {
  fullName: 'Jean Dupont',
  organization: 'Vega Equipment Solutions',
  title: 'Senior Advisor - Brazil',
  email: 'jean.dupont-ext@example.com',
  phone: '+55 11 55501-0157',
  website: 'https://equipmentsolutions.example.com',
  phones: ['+55 11 55501-0157'],
  emails: ['jean.dupont-ext@example.com'],
}

describe('applyQrContact', () => {
  it('overrides what the model misread off the photograph', () => {
    // A plausible OCR result from an angled, glare-lit card: mangled org,
    // dropped accent-adjacent characters, a phone missing its country code.
    const ocr = {
      company_name: 'VEGA EQUIPMENT SOLUTIQNS',
      primary_contact_name: 'Jean0 Dupont',
      primary_contact_phone: '11 55501-0157',
      primary_contact_email: 'jean.dupont-ext@example.corn',
    }
    const { parsed, fromQr } = applyQrContact(ocr, CARD)
    expect(parsed.company_name).toBe('Vega Equipment Solutions')
    expect(parsed.primary_contact_name).toBe('Jean Dupont')
    expect(parsed.primary_contact_phone).toBe('+55 11 55501-0157')
    expect(parsed.primary_contact_email).toBe('jean.dupont-ext@example.com')
    expect(fromQr).toContain('company_name')
  })

  it('never touches fields a vCard knows nothing about', () => {
    // The card says nothing about appetite. Anything the model inferred from
    // the rest of the image must survive untouched.
    const parsedIn = {
      deal_size_min_usd: 5_000_000,
      asset_classes: ['construction_equipment'],
      geographic_scope: ['Brazil'],
      internal_notes: 'met at the trade show',
    }
    const { parsed, fromQr } = applyQrContact(parsedIn, CARD)
    expect(parsed.deal_size_min_usd).toBe(5_000_000)
    expect(parsed.asset_classes).toEqual(['construction_equipment'])
    expect(parsed.geographic_scope).toEqual(['Brazil'])
    expect(parsed.internal_notes).toBe('met at the trade show')
    expect(fromQr).not.toContain('deal_size_min_usd')
  })

  it('never blanks a field the model did populate', () => {
    // QR adds certainty; it must not subtract information.
    const sparse: VCardContact = { ...CARD, title: null, website: null }
    const { parsed } = applyQrContact(
      { primary_contact_title: 'Head of Equipment Finance', website: 'https://example.com' },
      sparse,
    )
    expect(parsed.primary_contact_title).toBe('Head of Equipment Finance')
    expect(parsed.website).toBe('https://example.com')
  })

  it('uses a URL-only QR to fill a blank website but not to displace one', () => {
    const url = 'https://equipmentsolutions.example.com'
    expect(applyQrContact({}, null, url).parsed.website).toBe(url)
    expect(applyQrContact({ website: 'https://real.example' }, null, url).parsed.website).toBe(
      'https://real.example',
    )
  })

  it('is a no-op when there was no QR', () => {
    const input = { company_name: 'Whatever Capital' }
    const { parsed, fromQr } = applyQrContact(input, null)
    expect(parsed).toEqual(input)
    expect(fromQr).toEqual([])
  })

  it('does not mutate the caller’s object', () => {
    const input = { company_name: 'Original' }
    applyQrContact(input, CARD)
    expect(input.company_name).toBe('Original')
  })
})
