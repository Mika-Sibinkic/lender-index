/**
 * Single source of truth for the auth allowlist (TS side).
 *
 * Only these identities may authenticate into the app AND reach any data/AI
 * endpoint: any address on a domain in AUTH_ALLOWED_EMAIL_DOMAINS, plus the
 * individual addresses in AUTH_ALLOWED_EMAILS (src/lib/config/org.ts). Both
 * empty = nobody is authorized (fail closed).
 *
 * This MUST stay in sync with the RLS function `_is_authorized_user()`, which
 * reads the `access_allowlist` table (migration 0025). RLS is the
 * defense-in-depth backstop; this TS layer is the primary gate because most API
 * routes use the service-role admin client (which bypasses RLS by design).
 *
 * If you change the env allowlist, change the table rows too — both are the allowlist.
 */

import { allowedEmailDomains, allowedEmails } from '@/lib/config/org'

export function isAuthorizedEmail(email: string | null | undefined): boolean {
  if (!email) return false
  const e = email.trim().toLowerCase()
  if (!e || !e.includes('@')) return false
  if (allowedEmails().includes(e)) return true
  // Exact domain match on the part after the last @ — no suffix match, so a
  // lookalike such as yourcompany.example.attacker.io is rejected.
  const domain = e.slice(e.lastIndexOf('@') + 1)
  return allowedEmailDomains().includes(domain)
}
