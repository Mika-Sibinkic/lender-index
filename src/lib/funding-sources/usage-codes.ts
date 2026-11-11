/**
 * Usage codes a lender will finance (owner-operated, leased out, rental …). A
 * lender commonly accepts several, so the create form treats this as a
 * multi-select and stores the result comma-joined in funding_sources.usage_codes.
 * The codes come from src/lib/config/vocabulary.ts.
 */

import { USAGE_CODES as USAGE_CODE_CONFIG } from '@/lib/config/domain'

export const USAGE_CODES: readonly string[] = USAGE_CODE_CONFIG.map((u) => u.code)

/** Split a stored usage_codes string ("owner, lease" / "owner; rental") into tokens. */
export function parseUsageCodes(v: string): string[] {
  return v
    .split(/[,;/]+|\s+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * Toggle one usage code within a stored usage_codes string. Keeps canonical
 * ordering and preserves any unknown tokens the AI may have extracted (so a
 * parsed value is never silently dropped). Returns the new comma-joined string.
 */
export function toggleUsageCode(current: string, code: string): string {
  const tokens = parseUsageCodes(current)
  const isOn = tokens.includes(code)
  const codes = USAGE_CODES.filter((x) => (x === code ? !isOn : tokens.includes(x)))
  const extra = tokens.filter((t) => !USAGE_CODES.includes(t))
  return [...codes, ...extra].join(', ')
}
