// Types and derived helpers for the asset vocabulary. Edit src/lib/config/vocabulary.ts, not this file.

import {
  ASSET_CATEGORIES,
  RETIRED_ASSET_CATEGORIES,
  ASSET_SUBTYPES,
  USAGE_CODES,
  OPERATION_CATEGORIES,
  BORROWER_INDUSTRIES,
  DOMAIN_DESCRIPTION,
  DEMO_QUERY,
  ASSET_AGE,
} from '@/lib/config/vocabulary'

export {
  ASSET_CATEGORIES,
  RETIRED_ASSET_CATEGORIES,
  ASSET_SUBTYPES,
  USAGE_CODES,
  OPERATION_CATEGORIES,
  BORROWER_INDUSTRIES,
  DOMAIN_DESCRIPTION,
  DEMO_QUERY,
  ASSET_AGE,
}

export interface AssetCategory {
  /** Value stored in funding_sources.asset_classes. */
  id: string
  /** Shown in UI and chips. */
  label: string
  /** Id of a generic parent; a parent on either side matches any child. */
  parent?: string
  /** lucide-react icon name, resolved by asset-visuals.ts (fallback Waypoints). */
  icon?: string
  /**
   * Lowercase phrases that tag a query/document with this class (any language).
   * Pad with spaces (' car ') when the phrase must be a whole word.
   */
  keywords: string[]
  /** Lowercase brand / manufacturer names: model extraction, graph seeding, past-deal boost. */
  makes?: string[]
  /** One word a document would use for this class; LLM prompt example. Default: first keyword. */
  example?: string
}

export interface UsageCode {
  code: string
  label: string
  keywords: string[]
}

export interface OperationCategory {
  value: string
  label: string
  keywords: string[]
}

export interface AssetAgeConfig {
  /** Oldest asset year the parser and menus accept. */
  oldestYear: number
  /** Label of the asset-age facet menu. */
  label: string
  /** Label of the model-year group inside that menu. */
  yearLabel: string
  /** Age buckets offered in the menu; `maxAge: null` = open-ended top band. */
  bands: ReadonlyArray<{ label: string; minAge: number; maxAge: number | null }>
}

// ---- derived helpers ------------------------------------------------------

/** ASSET_CATEGORIES ids, config order. */
export const ASSET_CLASS_IDS: readonly string[] = ASSET_CATEGORIES.map((c) => c.id)

const BY_ID = new Map(
  [...ASSET_CATEGORIES, ...RETIRED_ASSET_CATEGORIES].map((c) => [c.id, c] as const),
)

/** Category by id, including retired ones. */
export function assetCategory(id: string): AssetCategory | undefined {
  return BY_ID.get(id)
}

/** The generic parent of a class, or the class itself when it has none. */
export function familyOf(id: string): string {
  return assetCategory(id)?.parent ?? id
}

const PARENT_IDS = new Set(
  [...ASSET_CATEGORIES, ...RETIRED_ASSET_CATEGORIES].flatMap((c) => (c.parent ? [c.parent] : [])),
)

/** True when some category names this id as its parent. */
export function isGenericParent(id: string): boolean {
  return PARENT_IDS.has(id)
}

/** Union of every category's makes, deduped, config order. */
export const ASSET_MAKES: readonly string[] = [
  ...new Set(ASSET_CATEGORIES.flatMap((c) => c.makes ?? [])),
]

// ---- LLM prompt examples, derived so prompts never name ids the config lacks ----

const titleCase = (s: string) => s.replace(/\b\w/g, (ch) => ch.toUpperCase())

/** The first `n` makes, Title Cased, quoted for a prompt: "Caterpillar", "Komatsu". */
export function promptMakes(n = 3): string {
  return ASSET_MAKES.slice(0, n).map((m) => `"${titleCase(m)}"`).join(', ')
}

/** Up to `n` specific (non-parent, non-'other') categories with a prompt word each. */
export function promptAssetExamples(n = 3): Array<{ word: string; label: string }> {
  return ASSET_CATEGORIES.filter((c) => c.id !== 'other' && !isGenericParent(c.id))
    .map((c) => ({ word: (c.example ?? c.keywords[0] ?? c.label).trim(), label: c.label.toLowerCase() }))
    .filter((e) => e.word)
    .slice(0, n)
}

/** Generic parent ids, quoted for a prompt: "equipment", "vehicles". */
export function promptParentIds(): string {
  return ASSET_CATEGORIES.filter((c) => isGenericParent(c.id)).map((c) => `"${c.id}"`).join(', ')
}
