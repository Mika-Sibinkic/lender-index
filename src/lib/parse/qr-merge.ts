/**
 * Merge exact QR/vCard contact data over a model's reading of the same card.
 *
 * Precedence is the whole point. Everywhere else in this codebase the AI
 * proposes and a human confirms; here a *deterministic* source is available for
 * the same fields, and under the accuracy mandate deterministic outranks
 * probabilistic. A QR payload is the card's own data — it cannot be misread by
 * glare, a camera angle, or an accent the OCR language pack lacks.
 *
 * Scope is deliberately narrow: contact identity only. A vCard says nothing
 * about deal size, asset classes, geography or usage codes, so it must not touch
 * those. It also never *blanks* a field the model did populate — QR data adds
 * certainty, it does not subtract information.
 */

import type { VCardContact } from '@/lib/parse/vcard'

/** The only fields a vCard is authoritative for. */
const QR_FIELDS = [
  'company_name',
  'primary_contact_name',
  'primary_contact_title',
  'primary_contact_email',
  'primary_contact_phone',
  'website',
] as const

export interface QrMergeResult {
  parsed: Record<string, unknown>
  /** Field names taken from the QR — surfaced so the UI can mark them exact. */
  fromQr: string[]
}

const blank = (v: unknown): boolean =>
  v === null || v === undefined || (typeof v === 'string' && v.trim() === '')

export function applyQrContact(
  parsed: Record<string, unknown>,
  contact: VCardContact | null,
  website?: string | null,
): QrMergeResult {
  const out: Record<string, unknown> = { ...parsed }
  const fromQr: string[] = []

  const set = (key: (typeof QR_FIELDS)[number], value: string | null) => {
    if (blank(value)) return
    // Overwrite even a populated value: the QR is the card's own data, the
    // model's is an interpretation of a photograph of it.
    out[key] = value
    if (!fromQr.includes(key)) fromQr.push(key)
  }

  if (contact) {
    set('company_name', contact.organization)
    set('primary_contact_name', contact.fullName)
    set('primary_contact_title', contact.title)
    set('primary_contact_email', contact.email)
    set('primary_contact_phone', contact.phone)
    set('website', contact.website)
  }

  // A QR carrying only a URL is an enrichment hint, not a contact. It fills a
  // blank website but never displaces one the model actually read.
  if (!blank(website) && blank(out.website)) {
    out.website = website
    if (!fromQr.includes('website')) fromQr.push('website')
  }

  return { parsed: out, fromQr }
}
