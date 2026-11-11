/**
 * Detects a Postgres unique-violation on funding_sources.company_name.
 *
 * company_name carries a UNIQUE index (migration 0013), so inserting a lender
 * that already exists fails with SQLSTATE 23505. The create route uses this to
 * return a clean 409 ("already exists — open it to edit") + the existing row id
 * instead of leaking a raw Postgres error as a 500.
 */
export function isDuplicateCompanyError(
  error: { code?: string | null; message?: string | null } | null | undefined,
): boolean {
  if (!error) return false
  if (error.code === '23505') return true
  const m = (error.message ?? '').toLowerCase()
  // Fallback for drivers that don't surface the SQLSTATE cleanly.
  return (
    m.includes('funding_sources_company_name_key') ||
    (m.includes('duplicate key') && m.includes('company_name'))
  )
}
