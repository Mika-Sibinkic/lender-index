import { describe, it, expect } from 'vitest'
import { noticeFor } from './ai-status-banner'

describe('noticeFor', () => {
  it('says nothing at all when everything is healthy', () => {
    // A banner that is always present is furniture, and furniture gets ignored
    // on the day it matters.
    expect(noticeFor({ ai: 'up', missingModels: [] })).toBeNull()
  })

  it('names the offline box and says search still works', () => {
    // The AI-server-down state. Search genuinely still returns results via the
    // structural fallback, so the wording must not imply the app is down.
    const n = noticeFor({ ai: 'down' })
    expect(n).not.toBeNull()
    expect(n!.headline).toMatch(/offline/i)
    expect(n!.detail).toMatch(/search still works/i)
    expect(n!.detail).toMatch(/import/i)
  })

  it('distinguishes degraded ranking from an outage', () => {
    const n = noticeFor({ ai: 'degraded' })
    expect(n!.headline).toMatch(/degraded/i)
    // Degraded means "possibly more results, none wrong" — say that, so nobody
    // reads it as "these results are untrustworthy".
    expect(n!.detail).toMatch(/nothing shown is wrong/i)
  })

  it('catches the state that broke import for weeks: embed fine, text model missing', () => {
    // Search looked perfectly healthy while every document parse 404'd. Health
    // said "up", so nothing surfaced it.
    const n = noticeFor({ ai: 'up', missingModels: ['text'] })
    expect(n).not.toBeNull()
    expect(n!.headline).toMatch(/document reading/i)
    expect(n!.detail).toMatch(/search is working normally/i)
  })

  it('does not nag about a missing vision model — image parse falls back to OCR', () => {
    expect(noticeFor({ ai: 'up', missingModels: ['vision'] })).toBeNull()
  })

  it('renders nothing when the probe itself failed — never claim an unconfirmed outage', () => {
    expect(noticeFor(null)).toBeNull()
  })

  it('prefers the outage message over the missing-model one', () => {
    // If the box is off we cannot know what is installed; "offline" is the
    // actionable truth.
    expect(noticeFor({ ai: 'down', missingModels: ['text'] })!.headline).toMatch(/offline/i)
  })
})
