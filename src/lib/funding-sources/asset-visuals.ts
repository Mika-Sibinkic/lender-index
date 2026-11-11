import {
  Building2,
  Car,
  Cog,
  HardHat,
  Stethoscope,
  Tractor,
  Truck,
  Wallet,
  Waypoints,
  type LucideIcon,
} from 'lucide-react'
import { ASSET_CLASSES } from '@/lib/types/funding-source'
import {
  ASSET_CATEGORIES,
  RETIRED_ASSET_CATEGORIES,
  isGenericParent,
} from '@/lib/config/domain'

/**
 * Canonical asset-class → glyph + label. Lets a broker read a lender's asset
 * focus at a glance instead of parsing a "·"-separated word list. Labels and
 * icon names come from src/lib/config/vocabulary.ts; this file only resolves the
 * icon name to a component.
 *
 * Icons pair with a visible or screen-reader label everywhere they render —
 * never icon-only (accessibility + learnability).
 */
export interface AssetVisual {
  label: string
  Icon: LucideIcon
}

/** Icon names config may use. Add one here when a category names a new icon. */
export const ASSET_ICONS: Record<string, LucideIcon> = {
  Building2,
  Car,
  Cog,
  HardHat,
  Stethoscope,
  Tractor,
  Truck,
  Wallet,
  Waypoints,
}

const ALL_CATEGORIES = [...ASSET_CATEGORIES, ...RETIRED_ASSET_CATEGORIES]

export const ASSET_VISUALS: Record<string, AssetVisual> = Object.fromEntries(
  ALL_CATEGORIES.map((c) => [
    c.id,
    { label: c.label, Icon: (c.icon && ASSET_ICONS[c.icon]) || Waypoints },
  ]),
)

/** Fallback-safe lookup: unknown classes get a humanized label + neutral glyph. */
export function assetVisual(cls: string): AssetVisual {
  return ASSET_VISUALS[cls] ?? { label: cls.replaceAll('_', ' '), Icon: Waypoints }
}

// Show the most specific / decision-relevant classes first when space is tight:
// children of a generic parent, then the generic parents, then the rest — each
// group in config order.
const tier = (id: string) =>
  ALL_CATEGORIES.find((c) => c.id === id)?.parent ? 0 : isGenericParent(id) ? 1 : 2
const PRIORITY = ALL_CATEGORIES.map((c) => c.id).sort((a, b) => tier(a) - tier(b))

export function orderAssets(classes: string[]): string[] {
  const rank = (c: string) => {
    const i = PRIORITY.indexOf(c)
    return i < 0 ? PRIORITY.length : i
  }
  return [...classes].sort((a, b) => rank(a) - rank(b))
}

// Compile-time-ish guarantee that every canonical class has a visual; the test
// asserts this at runtime so a new ASSET_CLASSES entry can't ship glyph-less.
export const _ASSET_CLASSES_FOR_TEST = ASSET_CLASSES
