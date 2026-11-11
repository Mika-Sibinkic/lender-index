// Branding and access are env-driven so a deployment never edits code to rebrand.

export const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME || 'Lender Index'
export const ORG_NAME = process.env.NEXT_PUBLIC_ORG_NAME || 'Your Company'
/** Who outreach drafts are signed by (server-only). Falls back to ORG_NAME. */
export const PRINCIPAL_NAME = process.env.PRINCIPAL_NAME?.trim() || ORG_NAME
/** Empty = render APP_NAME as a text wordmark. */
export const LOGO_URL = process.env.NEXT_PUBLIC_LOGO_URL || ''

function list(v: string | undefined): string[] {
  return (v ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
}

/** AUTH_ALLOWED_EMAIL_DOMAINS, e.g. "yourcompany.example,partner.example". Read per call. */
export function allowedEmailDomains(): string[] {
  return list(process.env.AUTH_ALLOWED_EMAIL_DOMAINS)
}

/** AUTH_ALLOWED_EMAILS, individual addresses outside the allowed domains. Read per call. */
export function allowedEmails(): string[] {
  return list(process.env.AUTH_ALLOWED_EMAILS)
}
