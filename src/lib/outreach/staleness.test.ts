import { describe, it, expect } from 'vitest'
import { isStale, missingFieldsFor } from './staleness'

const NOW = new Date('2026-05-14T12:00:00Z')

describe('isStale', () => {
  it('marks stale when last_contact_at older than 90d', () => {
    expect(
      isStale(
        { last_contact_at: '2026-01-01', outreach_status: 'current', required_field_gaps: [] },
        NOW,
      ),
    ).toBe(true)
  })

  it('marks stale when required_field_gaps non-empty, regardless of last_contact_at', () => {
    expect(
      isStale(
        { last_contact_at: '2026-05-10', outreach_status: 'current', required_field_gaps: ['rate_notes'] },
        NOW,
      ),
    ).toBe(true)
  })

  it('skips do_not_contact', () => {
    expect(
      isStale(
        { last_contact_at: null, outreach_status: 'do_not_contact', required_field_gaps: ['x'] },
        NOW,
      ),
    ).toBe(false)
  })

  it('skips bouncing', () => {
    expect(
      isStale(
        { last_contact_at: null, outreach_status: 'bouncing', required_field_gaps: ['x'] },
        NOW,
      ),
    ).toBe(false)
  })

  it('marks stale when last_contact_at is null', () => {
    expect(
      isStale(
        { last_contact_at: null, outreach_status: 'current', required_field_gaps: [] },
        NOW,
      ),
    ).toBe(true)
  })

  it('not stale when recent and no gaps', () => {
    expect(
      isStale(
        { last_contact_at: '2026-05-10', outreach_status: 'current', required_field_gaps: [] },
        NOW,
      ),
    ).toBe(false)
  })
})

describe('missingFieldsFor', () => {
  it('returns the required_field_gaps verbatim when contact is recent', () => {
    expect(
      missingFieldsFor(
        { last_contact_at: '2026-05-10', outreach_status: 'current', required_field_gaps: ['rate_notes'] },
        NOW,
      ),
    ).toEqual(['rate_notes'])
  })

  it('adds a synthetic check_in field when contact is stale and not already there', () => {
    expect(
      missingFieldsFor(
        { last_contact_at: '2026-01-01', outreach_status: 'current', required_field_gaps: ['rate_notes'] },
        NOW,
      ),
    ).toEqual(['rate_notes', 'check_in'])
  })
})
