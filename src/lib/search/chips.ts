/**
 * The parsed deal, rendered as chips.
 *
 * The old bar hid its interpretation: you typed a sentence, something happened,
 * and a list came back. If the parse misread "rental fleet" or missed "Brazil" there
 * was no way to tell — you just got a subtly wrong shortlist, which under the
 * accuracy mandate is the expensive kind of wrong. And adjusting one constraint
 * meant retyping the whole sentence, so nobody did.
 *
 * Chips fix both: every criterion the search is actually using is on screen, and
 * each one can be dropped in a click. This module owns the shape and the
 * wording; the component just paints it.
 */

import type { EffectiveCriteria, ConstraintDim } from '@/lib/search/constraints'
import { formatUsdCompact } from '@/lib/format/currency'
import {
  ASSET_CATEGORIES,
  RETIRED_ASSET_CATEGORIES,
  USAGE_CODES,
} from '@/lib/config/domain'

export interface SearchChip {
  /** Stable key for React and for tests. */
  id: string
  dim: ConstraintDim
  /** The individual value this chip stands for, when the dimension holds a list. */
  value?: string
  label: string
  /** Short word for the dimension, shown as a quiet prefix. */
  group: string
  /**
   * False for a criterion the operator must not be able to un-state — today only
   * a named foreign country, because dropping it would let US-only lenders into
   * a foreign deal. They can still edit the country itself.
   */
  removable: boolean
}

// Labels from config; retired classes are included so legacy rows still render.
const ASSET_LABELS: Record<string, string> = Object.fromEntries(
  [...ASSET_CATEGORIES, ...RETIRED_ASSET_CATEGORIES].map((c) => [c.id, c.label]),
)

const USAGE_LABELS: Record<string, string> = Object.fromEntries(
  USAGE_CODES.map((u) => [u.code, u.label]),
)

export function assetLabel(c: string): string {
  return ASSET_LABELS[c] ?? c.replaceAll('_', ' ').replace(/^./, (m) => m.toUpperCase())
}

/** Compact USD for a chip — the same formatter the results grid uses. */
export const usdShort = formatUsdCompact

export function sizeLabel(min: number | null, max: number | null): string | null {
  if (min === null && max === null) return null
  if (min !== null && max !== null) {
    return min === max ? usdShort(min) : `${usdShort(min)}–${usdShort(max)}`
  }
  if (min !== null) return `${usdShort(min)}+`
  return `up to ${usdShort(max!)}`
}

export function buildChips(
  e: Pick<
    EffectiveCriteria,
    | 'asset_classes'
    | 'geographic_scope'
    | 'deal_size_min_usd'
    | 'deal_size_max_usd'
    | 'usage_codes'
    | 'operation_category'
    | 'lender_type_required'
    | 'us_states'
    | 'asset_year'
    | 'intl_required'
  >,
  opts: { foreignGeos?: (g: string) => boolean } = {},
): SearchChip[] {
  const isForeign = opts.foreignGeos ?? (() => false)
  const chips: SearchChip[] = []

  for (const c of e.asset_classes) {
    chips.push({
      id: `asset:${c}`,
      dim: 'asset_classes',
      value: c,
      label: assetLabel(c),
      group: 'Asset',
      removable: true,
    })
  }

  for (const g of e.geographic_scope) {
    chips.push({
      id: `geo:${g}`,
      dim: 'geographic_scope',
      value: g,
      label: g,
      group: 'Where',
      // A named foreign country is what arms the international hard-exclude.
      // Removing it is the one edit that could surface a US-only lender on a
      // foreign deal, so it is not offered as a one-click drop.
      removable: !isForeign(g),
    })
  }

  const size = sizeLabel(e.deal_size_min_usd, e.deal_size_max_usd)
  if (size) {
    chips.push({
      id: 'size',
      dim: 'deal_size_min_usd',
      label: size,
      group: 'Size',
      removable: true,
    })
  }

  // Only worth a chip when it did NOT come from a country already shown — an
  // "International" chip next to a "Brazil" chip is noise.
  if (e.intl_required && !e.geographic_scope.some(isForeign)) {
    chips.push({
      id: 'intl',
      dim: 'intl',
      label: 'International',
      group: 'Where',
      removable: true,
    })
  }

  for (const p of e.usage_codes ?? []) {
    chips.push({
      id: `usage:${p}`,
      dim: 'usage_codes',
      value: p,
      label: USAGE_LABELS[p] ?? p,
      group: 'Ops',
      removable: true,
    })
  }

  if (e.operation_category) {
    chips.push({
      id: 'operation',
      dim: 'operation_category',
      label: e.operation_category,
      group: 'Ops',
      removable: true,
    })
  }

  if (e.lender_type_required) {
    chips.push({
      id: 'lender_type',
      dim: 'lender_type_required',
      label: e.lender_type_required.replace(/^./, (m) => m.toUpperCase()),
      group: 'Lender',
      removable: true,
    })
  }

  for (const s of e.us_states ?? []) {
    chips.push({
      id: `state:${s}`,
      dim: 'us_states',
      value: s,
      label: s,
      group: 'State',
      removable: true,
    })
  }

  if (e.asset_year != null) {
    chips.push({
      id: 'asset_year',
      dim: 'asset_year',
      label: `${e.asset_year} asset`,
      group: 'Age',
      removable: true,
    })
  }

  return chips
}

/** Plain-English note naming what the operator switched off. */
const REMOVED_LABELS: Record<string, string> = {
  asset_classes: 'asset type',
  geographic_scope: 'location',
  deal_size_min_usd: 'deal size',
  usage_codes: 'usage',
  operation_category: 'operation type',
  lender_type_required: 'lender type',
  us_states: 'state',
  asset_year: 'asset age',
  intl: 'international',
}

/**
 * The query named an amount in a currency we do not convert. Same principle as
 * removedNotice: the constraint is not applied, so the screen has to say so.
 */
export function currencyNotice(code: string | null | undefined): string | null {
  if (!code) return null
  return `Deal size not applied — the amount is in ${code} and lender ranges are in USD. Enter the USD figure to filter by size.`
}

/**
 * "mil" means million in English finance and thousand in Portuguese and
 * Spanish. Guessing either way produces a wrong shortlist, so the size is left
 * unstated and the operator is told exactly what to type instead.
 */
export function ambiguousUnitNotice(unit: string | null | undefined): string | null {
  if (!unit) return null
  return `"${unit}" means million in English and thousand in Portuguese. Write the figure out (e.g. $800,000 or $20M) to make it a hard filter.`
}

/**
 * How a value we INFERRED was arrived at.
 *
 * An inferred deal size or asset year ranks but never excludes (see
 * money.ts). That is the safe behaviour, but it is only honest if the operator
 * can see which reading we took and correct it — otherwise the shortlist is
 * ordered by a number nobody agreed to.
 */
export function inferredBasisNotice(
  ...bases: Array<string | null | undefined>
): string | null {
  const seen = bases.filter((b): b is string => Boolean(b))
  if (seen.length === 0) return null
  return `Read from your wording: ${seen.join('; ')}. Not used to exclude any lender — pick a value from Narrow by to filter on it.`
}

/**
 * A dropped constraint must never be silent — the operator should be able to see
 * why a lender they expected to be filtered out is on the list.
 */
export function removedNotice(removed: readonly ConstraintDim[]): string | null {
  const names = removed.map((d) => REMOVED_LABELS[d]).filter(Boolean)
  if (names.length === 0) return null
  const list =
    names.length === 1
      ? names[0]
      : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
  return `Not filtering by ${list}. You removed that from this search.`
}
