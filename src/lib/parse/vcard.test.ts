import { describe, it, expect } from 'vitest'
import { parseVCard, isVCard, hasUsableContact } from './vcard'

/**
 * The kind of card that motivated this: one photographed at a trade show. It
 * carries a QR code we were ignoring while OCR'ing the photo.
 */
const CARD = `BEGIN:VCARD
VERSION:3.0
N:Dupont;Jean;;;
FN:Jean Dupont
ORG:Vega Equipment Solutions;Brazil Desk
TITLE:Senior Advisor - Brazil
TEL;TYPE=CELL:+55 11 55501-0157
EMAIL;TYPE=INTERNET:jean.dupont-ext@example.com
URL:https://equipmentsolutions.example.com
END:VCARD`

describe('parseVCard', () => {
  it('reads the trade-show card exactly, with no guessing', () => {
    const c = parseVCard(CARD)
    expect(c.fullName).toBe('Jean Dupont')
    expect(c.organization).toBe('Vega Equipment Solutions') // department dropped
    expect(c.title).toBe('Senior Advisor - Brazil')
    expect(c.email).toBe('jean.dupont-ext@example.com')
    expect(c.phone).toBe('+55 11 55501-0157')
    expect(c.website).toBe('https://equipmentsolutions.example.com')
  })

  it('prefers the mobile when a card lists several numbers', () => {
    const c = parseVCard(`BEGIN:VCARD
VERSION:3.0
FN:Pat Sample
TEL;TYPE=FAX:+1 555 010 0175
TEL;TYPE=WORK:+1 555 010 0121
TEL;TYPE=CELL:+1 555 010 0124
END:VCARD`)
    expect(c.phone).toBe('+1 555 010 0124')
    // Fax ranks last — a broker should never be handed it as the primary.
    expect(c.phones.at(-1)).toBe('+1 555 010 0175')
  })

  it('decodes quoted-printable accents from Outlook 2.1 exports', () => {
    // "Grégoire Ferreira" — mangling this is precisely the failure mode that
    // English-only OCR produces, so the deterministic path must not repeat it.
    const c = parseVCard(`BEGIN:VCARD
VERSION:2.1
FN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:Gr=C3=A9goire Ferreira
ORG;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:Banque =C3=89quipement
END:VCARD`)
    expect(c.fullName).toBe('Grégoire Ferreira')
    expect(c.organization).toBe('Banque Équipement')
  })

  it('falls back to the structured N field when FN is absent', () => {
    const c = parseVCard('BEGIN:VCARD\nVERSION:3.0\nN:Sample;Phillip;;;\nEND:VCARD')
    expect(c.fullName).toBe('Phillip Sample')
  })

  it('handles folded lines and Apple ITEM prefixes', () => {
    // RFC 6350 folding: a CRLF plus ONE whitespace char is the fold marker and
    // is removed; any further whitespace is real content. So the single-space
    // fold below rejoins with no gap...
    expect(
      parseVCard(
        'BEGIN:VCARD\r\nVERSION:3.0\r\nORG:Very Long Equipment Finance\r\n Company Ltd\r\nitem1.EMAIL:a@b.example\r\nEND:VCARD',
      ).organization,
    ).toBe('Very Long Equipment FinanceCompany Ltd')

    // ...while a two-space fold keeps the second space, which is the intended
    // way to encode a word break across a fold.
    expect(
      parseVCard('BEGIN:VCARD\r\nORG:Very Long Equipment Finance\r\n  Company Ltd\r\nEND:VCARD')
        .organization,
    ).toBe('Very Long Equipment Finance Company Ltd')

    expect(
      parseVCard('BEGIN:VCARD\r\nitem1.EMAIL:a@b.example\r\nEND:VCARD').email,
    ).toBe('a@b.example')
  })

  it('collects every email rather than dropping the extras', () => {
    const c = parseVCard(
      'BEGIN:VCARD\nFN:X\nEMAIL:a@b.example\nEMAIL;TYPE=WORK:c@d.com\nEND:VCARD',
    )
    expect(c.emails).toEqual(['a@b.example', 'c@d.com'])
  })

  it('rejects things that are not vCards instead of half-parsing them', () => {
    expect(isVCard('https://example.com')).toBe(false)
    expect(isVCard('WIFI:S:conference;T:WPA;P:hunter2;;')).toBe(false)
    expect(hasUsableContact(parseVCard('just some text'))).toBe(false)
  })

  it('treats a QR holding only a URL as not-a-contact', () => {
    // Plenty of cards encode just their website. That is an enrichment hint,
    // not contact data, and must not be presented as a parsed contact.
    expect(hasUsableContact(parseVCard('https://equipmentsolutions.example.com'))).toBe(false)
  })
})
