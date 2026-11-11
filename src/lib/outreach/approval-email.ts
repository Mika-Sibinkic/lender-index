import type { Draft } from './prompts'

export interface ApprovalEmailInput {
  draft: Draft
  recipient: { name?: string | null; email: string }
  lender: { name: string }
  approveUrl: string
  declineUrl: string
}

export interface RenderedEmail {
  subject: string
  html: string
  text: string
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * the principal-facing approval email. Plain HTML with table-based layout for
 * Outlook fidelity. Two big buttons (Yes / No) link to the signed
 * action URLs. No external CSS — Outlook strips it.
 */
export function renderApprovalEmail(input: ApprovalEmailInput): RenderedEmail {
  const subject = `Outreach draft to ${input.recipient.name ?? input.recipient.email} @ ${input.lender.name} — approve to send?`
  const previewSubject = escapeHtml(input.draft.subject)
  const previewBody = escapeHtml(input.draft.body_text).replace(/\n/g, '<br />')
  const recipientLabel = escapeHtml(
    input.recipient.name
      ? `${input.recipient.name} <${input.recipient.email}>`
      : input.recipient.email,
  )

  const html = `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f7f7f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;">
    <tr><td style="padding:20px 24px;border-bottom:1px solid #f1f5f9;">
      <div style="font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:.04em;">Outreach draft — approve to send</div>
      <div style="font-size:18px;font-weight:600;margin-top:4px;">To ${recipientLabel}</div>
      <div style="font-size:14px;color:#374151;margin-top:2px;">Lender: ${escapeHtml(input.lender.name)}</div>
    </td></tr>
    <tr><td style="padding:20px 24px;">
      <div style="font-size:13px;color:#6b7280;">Subject</div>
      <div style="font-size:15px;font-weight:600;margin:2px 0 16px 0;">${previewSubject}</div>
      <div style="font-size:13px;color:#6b7280;">Body</div>
      <div style="font-size:14px;line-height:1.55;margin-top:6px;color:#111827;">${previewBody}</div>
    </td></tr>
    <tr><td align="center" style="padding:8px 24px 24px 24px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td style="padding:0 8px;"><a href="${input.approveUrl}" style="display:inline-block;padding:12px 20px;background:#16a34a;color:#ffffff;text-decoration:none;font-weight:600;border-radius:6px;">✅ Yes, send this</a></td>
          <td style="padding:0 8px;"><a href="${input.declineUrl}" style="display:inline-block;padding:12px 20px;background:#dc2626;color:#ffffff;text-decoration:none;font-weight:600;border-radius:6px;">❌ No, discard</a></td>
        </tr>
      </table>
    </td></tr>
    <tr><td style="padding:0 24px 20px 24px;font-size:11px;color:#9ca3af;text-align:center;">
      Links expire in 24 hours. Single-use.
    </td></tr>
  </table>
</body></html>`

  const text = [
    `Outreach draft to ${input.recipient.name ?? input.recipient.email} @ ${input.lender.name}`,
    '',
    `Subject: ${input.draft.subject}`,
    '',
    input.draft.body_text,
    '',
    `APPROVE: ${input.approveUrl}`,
    `DISCARD: ${input.declineUrl}`,
    '',
    `Links expire in 24 hours. Single-use.`,
  ].join('\n')

  return { subject, html, text }
}
