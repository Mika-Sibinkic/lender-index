/**
 * Currency input formatting — pure helpers shared by the live CurrencyInput and
 * anywhere else that needs thousands-grouped dollar text. Whole dollars only.
 */

/** Strip everything that isn't a digit. */
/**
 * The one compact-dollar formatter. Three near-identical copies had drifted
 * (appetite-band, past-deals-panel, the chip labels) and each rendered the same
 * number differently — "$8M" next to "$8.0M" reads like two different amounts on
 * a screen whose whole job is comparing amounts.
 *
 * None of them handled billions, so a $10,000,000,000 ceiling rendered as
 * "$10000M" in the deal-appetite column. Fixed here once.
 *
 * Rules: one decimal below 10 units ($8.5M), none at or above ($25M), never a
 * trailing ".0". Null / zero / negative render as an em dash, because a blank
 * appetite means "not stated", not "$0".
 */
export function formatUsdCompact(n: number | null | undefined): string {
  if (n === null || n === undefined || n <= 0) return '—'
  const unit = (v: number, suffix: string) => {
    const s = v >= 10 ? String(Math.round(v)) : v.toFixed(1).replace(/\.0$/, '')
    return `$${s}${suffix}`
  }
  if (n >= 1_000_000_000) return unit(n / 1_000_000_000, 'B')
  if (n >= 1_000_000) return unit(n / 1_000_000, 'M')
  if (n >= 1_000) return `$${Math.round(n / 1_000)}K`
  return `$${n}`
}

export function digitsOnly(s: string): string {
  return s.replace(/\D/g, '')
}

/** Group a digit string with thousands commas: "10000000" → "10,000,000". */
export function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/**
 * Display string for a raw currency value (digit string or number). Empty in →
 * empty out (so a blank field stays blank, not "0").
 */
export function formatCurrencyInput(value: string | number | null | undefined): string {
  const raw = digitsOnly(String(value ?? ''))
  return groupThousands(raw)
}
