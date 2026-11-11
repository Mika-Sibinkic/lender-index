import { describe, it, expect } from 'vitest'
import { tagsForListRow, isGeoDuplicateTag } from './display'

const tag = (name: string) => ({ name })

describe('tagsForListRow', () => {
  it('drops the two tags that duplicate — and contradict — the intl_domestic field', () => {
    // In a real roster, lenders can be tagged `domestic` while the field
    // says International/Both, so a Brazil search returned correctly-matched
    // lenders that visibly read "domestic".
    const out = tagsForListRow([tag('non-bank'), tag('domestic'), tag('preferred')])
    expect(out.map((t) => t.name)).toEqual(['non-bank', 'preferred'])
  })

  it('drops `international` too — it is the same duplicated field', () => {
    expect(tagsForListRow([tag('international'), tag('lessor')]).map((t) => t.name)).toEqual([
      'lessor',
    ])
  })

  it('handles a lender tagged BOTH ways (4 of them exist)', () => {
    expect(
      tagsForListRow([tag('international'), tag('domestic'), tag('bank')]).map((t) => t.name),
    ).toEqual(['bank'])
  })

  it('keeps every tag that carries information no field carries', () => {
    const kept = ['preferred', 'bank', 'non-bank', 'credit-union', 'private-equity', 'lessor',
      'logistics', 'other-lender', 'stale', 'bad-contact']
    expect(tagsForListRow(kept.map(tag)).map((t) => t.name)).toEqual(kept)
  })

  it('is case- and whitespace-insensitive', () => {
    expect(isGeoDuplicateTag(' Domestic ')).toBe(true)
    expect(isGeoDuplicateTag('INTERNATIONAL')).toBe(true)
    expect(isGeoDuplicateTag('domestic-only')).toBe(false) // a different tag, left alone
  })

  it('tolerates a row with no tags', () => {
    expect(tagsForListRow(undefined)).toEqual([])
  })
})
