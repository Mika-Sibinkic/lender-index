/**
 * The controlled vocabularies, in one place.
 *
 * These columns are compared by EXACT string in the matcher:
 *   intl_domestic   → structured-filter intlDim tests 'domestic' | 'international' | 'both'
 *   lending_status  → isNotCurrentlyLending tests 'no' or 'currently inactive'
 *   lender_type     → canonLenderType, which can hard-exclude when a kind was asked for
 *   operation_category → operationDim
 *
 * Anything outside the vocabulary is read as blank/unknown. That is the safe
 * direction for matching, but it means a typed value can silently switch a
 * dimension OFF for that lender while the screen still shows the word.
 *
 * The intake card had dropdowns for these from the start; the detail page had
 * free-text inputs whose placeholder read "US / International / Both". An
 * operator typing the suggested "US" produced a value intlDim does not
 * recognise, voiding the international hard-exclude for that lender — and the
 * field then displayed "US" and looked right forever. Two screens, one column,
 * two vocabularies. This module is the single source so they cannot drift again.
 *
 * Tuples are [storedValue, labelShown]. The stored value never changes: existing
 * rows hold "Domestic" and the matcher compares against it. Only the word on
 * screen is "US".
 */

import { ASSET_CATEGORIES, OPERATION_CATEGORIES } from '@/lib/config/domain'

export const INTL_DOMESTIC_CHOICES = [
  ['Domestic', 'US'],
  ['International', 'International'],
  ['Both', 'Both'],
] as const

export const LENDER_TYPE_CHOICES = [
  ['Bank', 'Bank'],
  ['Credit Union', 'Credit Union'],
  ['Non Bank', 'Non Bank'],
  ['Private Equity', 'Private Equity'],
] as const

/** Operation category, from config (src/lib/config/vocabulary.ts). */
export const OPERATION_CHOICES: readonly Choice[] = OPERATION_CATEGORIES.map(
  (o) => [o.value, o.label] as const,
)

/**
 * Free text here was an accuracy hole rather than a cosmetic one. Ranking
 * demoted a lender only when this read exactly "No" — so "Not lending",
 * "Paused" or "No longer lending" all left the lender ranking as though it were
 * open for business. A real roster had a lender with lending_status "Yes" while
 * its own notes said it "stopped renewing loans and stopped funding new loans",
 * and it ranked second on a Texas search.
 *
 * Third choice, third problem: "Currently Inactive" was offered here and tested
 * nowhere, so a lender set to it was neither demoted nor flagged — the opposite
 * failure, out of the same menu. `isNotCurrentlyLending` reads both stated
 * values since 2026-09-14. Blank is still unknown and still kept.
 */
export const LENDING_STATUS_CHOICES = [
  ['Yes', 'Yes — actively lending'],
  ['No', 'No — not currently lending'],
  ['Currently Inactive', 'Currently inactive'],
] as const

export type Choice = readonly [string, string]

/**
 * Asset classes the MATCHER understands, with the labels a broker would use.
 *
 * This field is a hard-exclude dimension: assetDim can return `contradict`, so a
 * value the matcher does not recognise does not degrade gracefully — it silently
 * removes that lender from every search naming an asset type, with no error
 * anywhere. It was a free-text array with only a placeholder to guide it, which
 * is how "construction equipment" instead of "construction_equipment" costs a
 * lender every match.
 *
 * Derived from ASSET_CATEGORIES in src/lib/config/vocabulary.ts, which is also what
 * assetDim in src/lib/search/structured-filter.ts reads, so the two cannot drift.
 */
export const ASSET_CLASS_CHOICES: readonly Choice[] = ASSET_CATEGORIES.map(
  (c) => [c.id, c.label] as const,
)
