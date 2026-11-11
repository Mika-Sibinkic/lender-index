export interface StalenessRow {
  last_contact_at: string | null
  outreach_status: string
  required_field_gaps: string[]
}

export const DEFAULT_STALE_DAYS = 90

export function isStale(
  fs: StalenessRow,
  now: Date,
  staleDays: number = DEFAULT_STALE_DAYS,
): boolean {
  if (fs.outreach_status === 'do_not_contact' || fs.outreach_status === 'bouncing') {
    return false
  }
  if (fs.required_field_gaps.length > 0) return true
  if (!fs.last_contact_at) return true
  const ageDays =
    (now.getTime() - new Date(fs.last_contact_at).getTime()) / (1000 * 86400)
  return ageDays >= staleDays
}

export function missingFieldsFor(fs: StalenessRow, now: Date, staleDays: number = DEFAULT_STALE_DAYS): string[] {
  const fields = [...fs.required_field_gaps]
  if (
    !fs.last_contact_at ||
    (now.getTime() - new Date(fs.last_contact_at).getTime()) / (1000 * 86400) >= staleDays
  ) {
    if (!fields.includes('check_in')) fields.push('check_in')
  }
  return fields
}
