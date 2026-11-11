import { describe, it, expect } from 'vitest'
import { renderApprovalEmail } from './approval-email'

describe('renderApprovalEmail', () => {
  const base = {
    draft: {
      subject: 'quick check-in',
      questions: ['rates?', 'ltv?'],
      body_text: 'hey jane — wanted to refresh our notes on you guys.\nany update on rates lately?\n\nThanks, Pat Example',
      body_html: '<p>hey jane</p>',
    },
    recipient: { name: 'Jane Doe', email: 'jane@altair.example.com' },
    lender: { name: 'Altair Bank' },
    approveUrl: 'https://app.example.com/api/outreach/act/APPROVE',
    declineUrl: 'https://app.example.com/api/outreach/act/DECLINE',
  }

  it('embeds both action URLs and the draft subject + body', () => {
    const out = renderApprovalEmail(base)
    expect(out.subject).toBe('Outreach draft to Jane Doe @ Altair Bank — approve to send?')
    expect(out.html).toContain('https://app.example.com/api/outreach/act/APPROVE')
    expect(out.html).toContain('https://app.example.com/api/outreach/act/DECLINE')
    expect(out.html).toContain('quick check-in')
    expect(out.html).toContain('hey jane')
    expect(out.text).toContain('APPROVE: https://app.example.com/api/outreach/act/APPROVE')
  })

  it('html-escapes hostile subject content', () => {
    const out = renderApprovalEmail({
      ...base,
      draft: { ...base.draft, subject: '<script>alert(1)</script>' },
    })
    expect(out.html).not.toContain('<script>alert(1)</script>')
    expect(out.html).toContain('&lt;script&gt;')
  })

  it('falls back to recipient email when name is missing', () => {
    const out = renderApprovalEmail({ ...base, recipient: { name: null, email: 'jane@altair.example.com' } })
    expect(out.subject).toContain('jane@altair.example.com')
  })
})
