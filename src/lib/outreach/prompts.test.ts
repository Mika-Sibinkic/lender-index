import { describe, it, expect } from 'vitest'
import { draftSchema, renderDraftPrompt, PROMPT_VERSION, SYSTEM_PROMPT } from './prompts'
import { PRINCIPAL_NAME } from '@/lib/config/org'

describe('draftSchema', () => {
  it('accepts a well-formed draft', () => {
    const ok = draftSchema.safeParse({
      subject: 'quick check-in',
      questions: ['what are your current rates?', 'still doing 80 LTV?'],
      body_text: 'hey jane — wanted to check in and refresh notes.',
      body_html: '<p>hey jane — wanted to check in and refresh notes.</p>',
    })
    expect(ok.success).toBe(true)
  })

  it('rejects > 3 questions', () => {
    const bad = draftSchema.safeParse({
      subject: 'check-in',
      questions: ['a?', 'b?', 'c?', 'd?'],
      body_text: 'long enough body for the test 12345',
      body_html: '<p>long enough body for the test 12345</p>',
    })
    expect(bad.success).toBe(false)
  })

  it('rejects empty questions', () => {
    const bad = draftSchema.safeParse({
      subject: 'check-in',
      questions: [],
      body_text: 'long enough body for the test 12345',
      body_html: '<p>long enough body for the test 12345</p>',
    })
    expect(bad.success).toBe(false)
  })
})

describe('renderDraftPrompt', () => {
  it('includes lender, contact, and missing fields', () => {
    const out = renderDraftPrompt({
      lender: {
        name: 'Altair Bank',
        contact_name: 'Jane Doe',
        contact_email: 'jane@altair.example.com',
        last_contact_at: '2025-12-01',
      },
      missing_fields: ['rate_notes', 'prepayment_penalty'],
    })
    expect(out).toContain('Altair Bank')
    expect(out).toContain('jane@altair.example.com')
    expect(out).toContain('rate_notes')
    expect(out).toContain('prepayment_penalty')
  })
})

describe('SYSTEM_PROMPT', () => {
  it('signs with the configured principal name', () => {
    expect(SYSTEM_PROMPT).toContain(`Close with "Thanks, ${PRINCIPAL_NAME}"`)
    expect(SYSTEM_PROMPT).not.toContain('the principal')
  })
})

describe('PROMPT_VERSION', () => {
  it('is versioned', () => {
    expect(PROMPT_VERSION).toMatch(/^v\d/)
  })
})
