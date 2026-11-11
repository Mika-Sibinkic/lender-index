/**
 * The search's *effective* criteria = what the sentence said, plus whatever the
 * operator has since changed on screen.
 *
 * Why this is server-side. The NL bar and the filter row used to be two
 * unrelated controls: you typed a deal, the app parsed it invisibly, and a
 * separate row of asset toggles filtered something else. You could not see what
 * the AI understood, and you could not adjust one constraint without retyping
 * the sentence. The merged control renders the parse as removable chips — so the
 * fix is to let the client send back an edited criteria set.
 *
 * But the client must never be the one deciding what a constraint MEANS. It
 * sends values only; every derivation (above all `intl_required`, which is what
 * hard-excludes Domestic-only lenders) is recomputed here from the effective
 * values. Otherwise removing a "Brazil" chip would leave the international
 * requirement armed and keep silently excluding domestic lenders for a search
 * that no longer mentions Brazil.
 *
 * Widening is allowed and is the whole point of a removable chip — but it is
 * never silent: `removed` records every constraint the operator dropped so the
 * UI can say so out loud. Under the accuracy mandate a criterion may be
 * unstated, never quietly ignored.
 */

import type { DealExtract } from '@/lib/search/extract-deal'
import { US_STATE_NAMES } from '@/lib/search/extract-deal'
import { FOREIGN_GEO_NAMES } from '@/lib/search/countries'
import { ASSET_CLASSES } from '@/lib/types/funding-source'

/** Client-supplied list narrowed to values the server itself produced. */
function intersect(override: string[] | undefined, parsed: string[]): string[] {
  if (override === undefined) return parsed
  return override.filter((v) => parsed.includes(v))
}

/** The dimensions an operator can edit from the chip/facet UI. */
export interface SearchConstraints {
  asset_classes?: string[]
  geographic_scope?: string[]
  deal_size_min_usd?: number | null
  deal_size_max_usd?: number | null
  usage_codes?: string[]
  operation_category?: string | null
  lender_type_required?: string | null
  /**
   * US states from the "Narrow by → State" menu. Safe to widen from the client
   * in a way geographic_scope is not: it is a pure AND-narrowing dimension that
   * never feeds hasForeignGeo, so nothing here can disarm the international
   * exclude the way a forged geo value could.
   */
  us_states?: string[]
  /** Asset model year, from the sentence or the "Asset age" menu. */
  asset_year?: number | null
  /**
   * Only ever used to switch a generic "international" ask OFF. It cannot be
   * switched on from the client — naming a foreign country is what turns it on,
   * and that is derived below.
   */
  intl_keyword_active?: boolean
}

export type ConstraintDim = keyof Omit<SearchConstraints, 'intl_keyword_active'> | 'intl'

export interface EffectiveCriteria extends DealExtract {
  /** Dimensions the operator explicitly dropped from what the sentence stated. */
  removed: ConstraintDim[]
}

/** True when any effective geo is a recognised foreign country/region. */
export function hasForeignGeo(geos: readonly string[]): boolean {
  return geos.some((g) => FOREIGN_GEO_NAMES.has(g))
}

export function mergeConstraints(
  parsed: DealExtract,
  overrides: SearchConstraints | undefined,
  opts: { queryHasIntlKeyword: boolean },
): EffectiveCriteria {
  const o = overrides ?? {}
  const pick = <T>(override: T | undefined, fallback: T): T =>
    override === undefined ? fallback : override

  // Both of these dimensions can HARD-EXCLUDE a lender, so neither trusts a raw
  // client value.
  //
  // Geography: the UI's only legitimate geo edit is removing a chip the parse
  // produced, so the effective scope is constrained to a subset of the parse. A
  // value that merely *looks* like a parsed one — "Brazil " with a stray space,
  // say — would fail the FOREIGN_GEO_NAMES lookup below, silently disarm the
  // international requirement, and put US-only lenders in front of a Brazil deal.
  // (Adding a geo facet later means revisiting this: canonicalise the incoming
  // value against the geo vocabulary rather than widening the subset rule.)
  const geographic_scope = intersect(o.geographic_scope, parsed.geographic_scope)
  // Asset class: restricted to the known vocabulary, so an unrecognised class
  // cannot contradict every lender and empty the shortlist.
  const asset_classes =
    o.asset_classes === undefined
      ? parsed.asset_classes
      : o.asset_classes.filter((c) => (ASSET_CLASSES as readonly string[]).includes(c))
  const deal_size_min_usd = pick(o.deal_size_min_usd, parsed.deal_size_min_usd)
  const deal_size_max_usd = pick(o.deal_size_max_usd, parsed.deal_size_max_usd)
  const usage_codes = pick(o.usage_codes, parsed.usage_codes ?? [])
  const operation_category = pick(o.operation_category, parsed.operation_category ?? null)
  const lender_type_required = pick(o.lender_type_required, parsed.lender_type_required ?? null)
  // Narrowed to the canonical 50 so a forged or misspelled value cannot reach
  // stateDim and contradict every lender at once.
  const us_states =
    o.us_states === undefined
      ? (parsed.us_states ?? [])
      : o.us_states.filter((s) => US_STATE_NAMES.includes(s))
  // A year outside a plausible asset range is not a narrowing, it is a typo
  // that would exclude the whole roster. Drop it rather than act on it.
  const rawYear = pick(o.asset_year, parsed.asset_year ?? null)
  const asset_year =
    rawYear !== null && Number.isInteger(rawYear) && rawYear >= 1950 && rawYear <= 2100
      ? rawYear
      : null

  // Derived, never taken from the client: a named foreign country always arms
  // the international requirement. The generic keyword arms it too, unless the
  // operator has switched that chip off.
  const keywordActive = pick(o.intl_keyword_active, opts.queryHasIntlKeyword)
  const intl_required = hasForeignGeo(geographic_scope) || (opts.queryHasIntlKeyword && keywordActive)

  const removed: ConstraintDim[] = []
  const dropped = (had: boolean, nowEmpty: boolean) => had && nowEmpty
  if (dropped(parsed.asset_classes.length > 0, asset_classes.length === 0)) removed.push('asset_classes')
  if (dropped(parsed.geographic_scope.length > 0, geographic_scope.length === 0)) removed.push('geographic_scope')
  if (
    dropped(
      parsed.deal_size_min_usd !== null || parsed.deal_size_max_usd !== null,
      deal_size_min_usd === null && deal_size_max_usd === null,
    )
  ) {
    removed.push('deal_size_min_usd')
  }
  if (dropped((parsed.usage_codes ?? []).length > 0, usage_codes.length === 0)) removed.push('usage_codes')
  if (dropped(!!parsed.operation_category, !operation_category)) removed.push('operation_category')
  if (dropped(!!parsed.lender_type_required, !lender_type_required)) removed.push('lender_type_required')
  if (dropped((parsed.us_states ?? []).length > 0, us_states.length === 0)) removed.push('us_states')
  if (dropped(parsed.asset_year != null, asset_year === null)) removed.push('asset_year')
  if (parsed.intl_required && !intl_required) removed.push('intl')
  // Note: a partially-narrowed dimension (three geos down to two) is an edit,
  // not a dropped constraint — the filter still applies, so it is not called out.

  return {
    ...parsed,
    asset_classes,
    geographic_scope,
    deal_size_min_usd,
    deal_size_max_usd,
    usage_codes,
    operation_category,
    lender_type_required,
    us_states,
    asset_year,
    // A value the operator picked from a menu is STATED by definition — they
    // chose it, so it regains the authority to exclude that an inferred parse
    // does not have.
    deal_size_confidence:
      o.deal_size_min_usd !== undefined || o.deal_size_max_usd !== undefined
        ? 'stated'
        : (parsed.deal_size_confidence ?? 'stated'),
    deal_size_basis:
      o.deal_size_min_usd !== undefined || o.deal_size_max_usd !== undefined
        ? null
        : (parsed.deal_size_basis ?? null),
    asset_year_confidence:
      o.asset_year !== undefined ? 'stated' : (parsed.asset_year_confidence ?? 'stated'),
    asset_year_basis:
      o.asset_year !== undefined ? null : (parsed.asset_year_basis ?? null),
    intl_required,
    removed,
  }
}
