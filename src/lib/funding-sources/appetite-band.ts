/**
 * Appetite-band geometry — pure math for the deal-size range bar.
 *
 * Each lender has a deal-size appetite (min–max USD). The bar plots that band on
 * a fixed, log-scaled domain so bands are comparable across lenders and legible
 * across three orders of magnitude (a $300K equipment deal and a $200M
 * real-estate deal both read clearly). When a search deal is present, a marker shows
 * where THIS deal sits — and whether it lands inside the lender's stated band.
 *
 * Log scale is deliberate: asset-finance deal sizes span ~$250K→$250M; a linear
 * scale would crush everything below ~$25M into the left 10%. This keeps the
 * visualization honest — a core requirement, not decoration.
 *
 * Pure + deterministic so it is unit-tested as the source of truth for the bar.
 */

export const APPETITE_DOMAIN_MIN = 250_000
export const APPETITE_DOMAIN_MAX = 250_000_000

export type DealPosition = 'below' | 'in' | 'above'

export interface BandGeometry {
  /** false when neither bound is usable (null/0) — caller renders an em-dash. */
  hasBand: boolean
  /** lender band start, 0–100 across the log domain. */
  startPct: number
  /** lender band end, 0–100. */
  endPct: number
  /** deal marker position, 0–100, or null when no deal amount. */
  dealPct: number | null
  /** deal vs the lender's *stated* band, or null when no deal amount. */
  dealPosition: DealPosition | null
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n))
}

/** Position of a value on the log10 domain, clamped to 0–100. */
function logPct(value: number, domainMin: number, domainMax: number): number {
  const v = clamp(value, domainMin, domainMax)
  const p =
    (Math.log10(v) - Math.log10(domainMin)) /
    (Math.log10(domainMax) - Math.log10(domainMin))
  return clamp(p * 100, 0, 100)
}

/** Treat null/0/negative as "unset" — matches the app's dealSizeEmpty semantics. */
function usable(n: number | null | undefined): number | null {
  return typeof n === 'number' && n > 0 ? n : null
}

export function bandGeometry(input: {
  lenderMin: number | null
  lenderMax: number | null
  dealAmount?: number | null
  domainMin?: number
  domainMax?: number
}): BandGeometry {
  const domainMin = input.domainMin ?? APPETITE_DOMAIN_MIN
  const domainMax = input.domainMax ?? APPETITE_DOMAIN_MAX
  const min = usable(input.lenderMin)
  const max = usable(input.lenderMax)

  if (min === null && max === null) {
    return { hasBand: false, startPct: 0, endPct: 0, dealPct: null, dealPosition: null }
  }

  // Open-ended bounds fill to the domain edge for drawing, but the true bounds
  // (min/max) decide the deal's below/in/above verdict.
  const drawLo = min ?? domainMin
  const drawHi = max ?? domainMax
  const startPct = logPct(Math.min(drawLo, drawHi), domainMin, domainMax)
  const endPct = logPct(Math.max(drawLo, drawHi), domainMin, domainMax)

  let dealPct: number | null = null
  let dealPosition: DealPosition | null = null
  const deal = usable(input.dealAmount)
  if (deal !== null) {
    dealPct = logPct(deal, domainMin, domainMax)
    const bandLo = min ?? 0
    const bandHi = max ?? Number.POSITIVE_INFINITY
    dealPosition = deal < bandLo ? 'below' : deal > bandHi ? 'above' : 'in'
  }

  return { hasBand: true, startPct, endPct, dealPct, dealPosition }
}

/** Compact USD for the bar's end captions: $250K, $8M, $2.5M, $200M. */

// Single app-wide money formatter — see lib/format/currency.ts for why.
export { formatUsdCompact } from '@/lib/format/currency'
