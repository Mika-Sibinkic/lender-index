/**
 * Reading an amount out of a deal sentence, and knowing how much to trust it.
 *
 * The first pass at this simply refused whenever the amount was ambiguous — a
 * BRL figure, or the word "mil". Refusing is safe but it is not useful: the team
 * types real deals in real currencies and got no size filtering at all. What is
 * needed is a mix — resolve deterministically where the evidence supports one
 * reading, and downgrade the result's AUTHORITY rather than throwing it away.
 *
 * The rule this module exists to enforce:
 *
 *   STATED   the sentence is unambiguous ("$8M")           → may hard-exclude
 *   INFERRED we resolved an ambiguity ourselves            → RANKS ONLY, never excludes
 *
 * That asymmetry is the whole point. A hard exclude on a number we inferred can
 * remove the one lender who could write the deal, and the operator never learns
 * the lender existed. Ranking on the same number costs nothing if we are wrong.
 */

export type Confidence = 'stated' | 'inferred'

/**
 * Operator-maintained FX rates, units of foreign currency per 1 USD.
 *
 * DELIBERATELY EMPTY. Rates are not something this repo can know: a hardcoded
 * number is stale the day after it is written, and a stale rate silently
 * mis-sizes every foreign deal — the accuracy mandate calls an approximated
 * value a wrong record, not a rounding. Populate it, with the date you took the
 * rates, and conversion switches on. Until then a foreign amount is reported
 * honestly as unconverted and the operator is asked for the USD figure.
 *
 * Even once populated, a converted amount is INFERRED and can only rank.
 */
export interface FxTable {
  asOf: string
  perUsd: Record<string, number>
}

export const FX_RATES: FxTable = {
  asOf: '',
  perUsd: {},
}

export function convertToUsd(
  amount: number,
  currency: string,
  table: FxTable = FX_RATES,
): { usd: number; rate: number; asOf: string } | null {
  const rate = table.perUsd[currency]
  if (!rate || !Number.isFinite(rate) || rate <= 0 || !table.asOf) return null
  return { usd: Math.round(amount / rate), rate, asOf: table.asOf }
}

/**
 * The real deal-size range across the lender roster, used to settle an
 * ambiguous magnitude.
 *
 * In a real roster deal_size_min spans roughly $1,000 to $20,000,000 and
 * deal_size_max roughly $170,000 to $100,000,000.
 * Anything an order of magnitude outside that cannot be matched by ANY lender,
 * so a reading that lands outside it is not a plausible deal — it is a
 * misparse, and choosing it would empty the shortlist.
 */
export const ROSTER_MIN_USD = 1_000
export const ROSTER_MAX_USD = 100_000_000

export function isPlausibleDealSize(usd: number): boolean {
  return usd >= ROSTER_MIN_USD && usd <= ROSTER_MAX_USD
}

/**
 * "mil" means MILLION in English finance — "International lender above 20
 * mil" — and THOUSAND in Portuguese and
 * Spanish. Rather than pick by language (a guess about the writer) or refuse
 * outright (no filtering at all), pick by what the roster can actually fund.
 *
 *   "20 mil"  → 20,000,000 plausible · 20,000 plausible      → ambiguous, prefer
 *               the English reading but mark it inferred
 *   "800 mil" → 800,000,000 impossible · 800,000 plausible   → resolved: 800,000
 *
 * Returns the chosen amount plus how confident we are entitled to be about it.
 */
export function resolveMilAmount(
  n: number,
  opts: { iberian: boolean },
): { usd: number; confidence: Confidence; basis: string } {
  const asMillion = n * 1_000_000
  const asThousand = n * 1_000
  const millionOk = isPlausibleDealSize(asMillion)
  const thousandOk = isPlausibleDealSize(asThousand)

  if (millionOk && !thousandOk) {
    return { usd: asMillion, confidence: 'stated', basis: `"${n} mil" read as ${fmt(asMillion)}` }
  }
  if (thousandOk && !millionOk) {
    return { usd: asThousand, confidence: 'stated', basis: `"${n} mil" read as ${fmt(asThousand)}` }
  }
  // Both readings are fundable. Language is the only remaining signal, and it is
  // weak enough that the result must not be allowed to exclude anyone.
  const usd = opts.iberian ? asThousand : asMillion
  return {
    usd,
    confidence: 'inferred',
    basis: `"${n} mil" could mean ${fmt(asThousand)} or ${fmt(asMillion)}; read as ${fmt(usd)} for ranking only`,
  }
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`
  return `$${n}`
}

export const formatUsdApprox = fmt
