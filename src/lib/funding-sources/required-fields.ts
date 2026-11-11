/**
 * Full-field discipline for funding sources.
 *
 * A roster kept in Domestic + International spreadsheet templates logs every
 * core template field for every lender. The app holds the same bar:
 * the core fields are REQUIRED to mark a lender "complete". An operator may only
 * bypass this via an explicit, visibly-flagged "Save incomplete" — which records
 * the gaps in `funding_sources.required_field_gaps` so nothing is silently lost.
 *
 * This module is the SINGLE SOURCE OF TRUTH for that field set. It drives:
 *   - the create/edit card popup (highlight the empty required fields),
 *   - the Save gate (primary Save disabled until complete),
 *   - `required_field_gaps` computation on an incomplete save.
 *
 * Decisions: Notes are OPTIONAL; every other real template
 * field is required. Bank Paid Fee is required only for International lenders
 * (it appears solely on the International template). Blank = a gap, never guessed.
 * Matching is unaffected — blank still = unknown = kept in search (accuracy mandate).
 */

export interface RequiredField {
  key: string
  label: string
}

/**
 * Always-required core fields (both templates). Order = display order on the card.
 * `internal_notes`, `borrower_*`, rate/term/LTV and other v2 extras are intentionally
 * NOT here — they are optional. `bank_paid_fee` is conditional (see below).
 */
export const REQUIRED_CORE_FIELDS: readonly RequiredField[] = [
  { key: 'lender_type', label: 'Type' },
  { key: 'company_name', label: 'Account Name' },
  { key: 'primary_contact_name', label: 'Main Contact' },
  { key: 'primary_contact_email', label: 'Email' },
  { key: 'deal_size_min_usd', label: 'Loan Minimum' },
  { key: 'deal_size_max_usd', label: 'Loan Maximum' },
  // Geographic Target is the CATEGORY (US / International);
  // Specific Geography is the states-or-countries list. One vocabulary across
  // the card, the detail view, the report and the missing-fields list.
  { key: 'intl_domestic', label: 'Geographic Target' },
  { key: 'geographic_scope', label: 'States / Countries Served' },
  // `specific_geographic` used to be required here. It was removed from both
  // the intake card and the detail view — measured against a real roster it
  // mostly duplicated the list or held the bare word "All", and changed ZERO
  // matcher verdicts. A required field nobody can fill
  // is a permanent "incomplete" flag on every record, so it is no longer asked
  // for. The column still exists and still exports; see detail-view.tsx.
  { key: 'asset_subtypes', label: 'Asset subtypes' },
  { key: 'usage_codes', label: 'Usage' },
  { key: 'operation_category', label: 'Operation category' },
  { key: 'vintage_restriction', label: 'Vintage Restriction' },
  { key: 'lending_status', label: 'Lending Status' },
] as const

/**
 * Required only when the lender serves International (or Both) deals — Bank Paid
 * Fee appears only on the International template.
 */
export const CONDITIONAL_REQUIRED_FIELDS: readonly (RequiredField & {
  when: (row: FieldValues) => boolean
})[] = [
  { key: 'bank_paid_fee', label: 'Bank Paid Fee', when: (row) => isInternational(row) },
] as const

/** Loose bag of field values — a create draft, an edit form, or a DB row. */
export type FieldValues = Record<string, unknown>

/** True when a value counts as "filled" (present, non-empty). 0 is a valid number. */
export function isFieldFilled(value: unknown): boolean {
  if (value === null || value === undefined) return false
  if (typeof value === 'string') return value.trim().length > 0
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value === 'boolean') return true
  if (Array.isArray(value)) return value.length > 0
  return true
}

/**
 * True when the lender serves international deals — drives the Bank Paid Fee
 * conditional. Reads `intl_domestic`: "International" / "Both" / a leading "I".
 * Domestic-only ("Domestic" / "D") → false.
 */
export function isInternational(row: FieldValues): boolean {
  const raw = row['intl_domestic']
  if (typeof raw !== 'string') return false
  const v = raw.trim().toLowerCase()
  if (v.length === 0) return false
  // Explicit domestic markers first — the template uses codes like "(D) Domestic".
  if (v.includes('domestic') || v === 'd' || v === '(d)') return false
  // International / Both — word anywhere, or the "(I)" code, or a lone "i".
  return v.includes('international') || v.includes('both') || v === 'i' || v === '(i)'
}

/** All required fields for THIS record (core + any active conditionals). */
export function requiredFieldsFor(row: FieldValues): RequiredField[] {
  const conditional = CONDITIONAL_REQUIRED_FIELDS.filter((f) => f.when(row)).map(
    ({ key, label }) => ({ key, label })
  )
  return [...REQUIRED_CORE_FIELDS, ...conditional]
}

/** Keys of the required fields that are still empty on this record. */
export function computeRequiredGaps(row: FieldValues): string[] {
  return requiredFieldsFor(row)
    .filter((f) => !isFieldFilled(row[f.key]))
    .map((f) => f.key)
}

/** True when every required field (core + active conditionals) is filled. */
export function isRecordComplete(row: FieldValues): boolean {
  return computeRequiredGaps(row).length === 0
}
