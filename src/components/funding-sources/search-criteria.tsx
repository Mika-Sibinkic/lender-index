'use client'

import { ChevronDown, X } from 'lucide-react'
import { ASSET_AGE, OPERATION_CATEGORIES, USAGE_CODES } from '@/lib/config/domain'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuCheckboxItem,
  DropdownMenuSeparator,
  DropdownMenuGroup,
} from '@/components/ui/dropdown-menu'
import { ASSET_CLASSES } from '@/lib/types/funding-source'
import { buildChips, removedNotice, currencyNotice, ambiguousUnitNotice, inferredBasisNotice, assetLabel, type SearchChip } from '@/lib/search/chips'
import { hasForeignGeo, type SearchConstraints } from '@/lib/search/constraints'
import { US_STATE_NAMES } from '@/lib/search/extract-deal'
import type { EffectiveCriteria } from '@/lib/search/constraints'
import { cn } from '@/lib/utils'

/**
 * The search's criteria, made visible and editable.
 *
 * Two controls used to compete here: a natural-language bar whose interpretation
 * was invisible, and a flat asset-type row that filtered something else entirely.
 * Each was fastest at a different job — a sentence beats six dropdowns for
 * stating a deal, but a click beats retyping the sentence to change one thing —
 * so neither replaced the other and both stayed half-useful.
 *
 * Merged: the sentence is still the fast way in, the chips show what it was
 * understood to mean (which matters most under a no-wrong-lender guarantee — an
 * opaque parse is an unverifiable one), and the menus are how you add a
 * constraint you never said out loud. Chips, menus and query stay in sync
 * because all three read from the server's effective criteria.
 *
 * Nothing is filtered by default. A pre-applied "profile" would silently exclude
 * lenders, which is exactly what the accuracy mandate forbids.
 */

// The combined "A, B" value is a lender-side record, not something a deal asks for.
const OPERATIONS = OPERATION_CATEGORIES.filter((o) => !o.value.includes(','))
/**
 * Lender kind is offered as a facet. Bank is typically the single largest kind
 * in a roster and was the one kind a user could not ask for. Free-text extraction still ignores a bare "bank"
 * in a sentence — too incidental there — but a facet click is unambiguous.
 */
const LENDER_KINDS = ['bank', 'credit union', 'non-bank', 'private equity'] as const
/** Deliberately coarse — brackets a broker actually thinks in. */
const SIZE_BANDS: Array<{ label: string; min: number | null; max: number | null }> = [
  { label: 'Under $1M', min: null, max: 1_000_000 },
  { label: '$1M – $5M', min: 1_000_000, max: 5_000_000 },
  { label: '$5M – $10M', min: 5_000_000, max: 10_000_000 },
  { label: '$10M – $25M', min: 10_000_000, max: 25_000_000 },
  { label: 'Over $25M', min: 25_000_000, max: null },
]

export interface CriteriaProps {
  effective: EffectiveCriteria | null
  /** Current operator overrides, so a menu can show what is already ticked. */
  constraints: SearchConstraints
  /**
   * `source` distinguishes a deliberate "Narrow by" pick from a chip removal.
   * The parent keeps facet picks across a new search sentence and drops chip
   * edits, which belong to the sentence they were made against.
   */
  onChange: (next: SearchConstraints, source: 'chip' | 'facet') => void
  disabled?: boolean
}

/**
 * Asset model years offered by the "Asset age" menu, newest first.
 *
 * Operators ask for an asset age; the menu offers the model YEAR and shows the age
 * beside it. A lender's limit is stored either as an age ("20 Years") or as a
 * cutoff year ("2003 or newer"), and a single year is the one value that answers
 * both without an approximation — which the accuracy mandate treats as a wrong
 * record rather than a rounding.
 *
 * The floor is the SAME year the intake picker allows (vintage.ts), because two
 * different floors means a deal the product can record but cannot search for. It
 * was 1980 here against 1960 there, so a 1975 asset could be entered as a
 * lender's cutoff and never picked from this menu.
 */
const ASSET_OLDEST_OFFERED = ASSET_AGE.oldestYear

function assetYears(currentYear: number): number[] {
  const out: number[] = []
  for (let y = currentYear; y >= ASSET_OLDEST_OFFERED; y--) out.push(y)
  return out
}

/**
 * Age BANDS, for when the operator knows the bracket but not the model year.
 *
 * A band is a range of assets, and the dimension underneath takes one year,
 * so the mapping has to be chosen rather than assumed. Each band maps to its
 * YOUNGEST asset — `minAge`.
 *
 * That is the only safe direction. vintageDim hard-excludes a lender whose
 * stated limit the asset breaks, so mapping "10-15 yr" to the OLDEST end
 * would drop every lender capping at 12 years — lenders who can finance most of
 * the band. Mapping to the youngest end excludes only lenders who cannot
 * finance ANY asset in the band, which is a claim their own record supports.
 * Over-inclusion here is recoverable by reading the row; a wrong exclusion is
 * the lender the broker never learns about.
 *
 * `maxAge: null` is the open-ended top band — there is no oldest asset.
 */
const AGE_BANDS = ASSET_AGE.bands

/** Current effective value of a list dimension (override if set, else the parse). */
function listOf(
  effective: EffectiveCriteria | null,
  constraints: SearchConstraints,
  key: 'asset_classes' | 'geographic_scope' | 'usage_codes' | 'us_states',
): string[] {
  return constraints[key] ?? effective?.[key] ?? []
}

function toggle(list: string[], v: string): string[] {
  return list.includes(v) ? list.filter((x) => x !== v) : [...list, v]
}

function FacetMenu({
  label,
  children,
  active,
  disabled,
}: {
  label: string
  children: React.ReactNode
  active: number
  disabled?: boolean
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        className={cn(
          'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[12px] transition-colors',
          'disabled:opacity-50',
          active > 0
            ? 'border-foreground/25 bg-foreground/[0.06] text-foreground'
            : 'border-border/70 text-muted-foreground hover:text-foreground',
        )}
      >
        {label}
        {active > 0 && <span className="tabular-nums text-[10px] opacity-70">{active}</span>}
        <ChevronDown size={12} aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-80 w-56 overflow-y-auto">
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function SearchCriteria({ effective, constraints, onChange, disabled }: CriteriaProps) {
  const assets = listOf(effective, constraints, 'asset_classes')
  const geos = listOf(effective, constraints, 'geographic_scope')
  const usages = listOf(effective, constraints, 'usage_codes')
  const min = constraints.deal_size_min_usd ?? effective?.deal_size_min_usd ?? null
  const max = constraints.deal_size_max_usd ?? effective?.deal_size_max_usd ?? null
  const operation = constraints.operation_category ?? effective?.operation_category ?? null
  const lenderKind = constraints.lender_type_required ?? effective?.lender_type_required ?? null
  const states = listOf(effective, constraints, 'us_states')
  const assetYear = constraints.asset_year ?? effective?.asset_year ?? null
  const thisYear = new Date().getFullYear()

  const chips: SearchChip[] = effective
    ? buildChips(effective, { foreignGeos: (g) => hasForeignGeo([g]) })
    : []
  const notice = effective ? removedNotice(effective.removed) : null
  const fxNotice = effective ? currencyNotice(effective.size_currency_unsupported) : null
  const inferredNotice = effective
    ? inferredBasisNotice(effective.deal_size_basis, effective.asset_year_basis)
    : null

  function removeChip(chip: SearchChip) {
    switch (chip.dim) {
      case 'asset_classes':
        return onChange({ ...constraints, asset_classes: assets.filter((v) => v !== chip.value) }, 'chip')
      case 'geographic_scope':
        return onChange({ ...constraints, geographic_scope: geos.filter((v) => v !== chip.value) }, 'chip')
      case 'usage_codes':
        return onChange({ ...constraints, usage_codes: usages.filter((v) => v !== chip.value) }, 'chip')
      case 'deal_size_min_usd':
        return onChange({ ...constraints, deal_size_min_usd: null, deal_size_max_usd: null }, 'chip')
      case 'operation_category':
        return onChange({ ...constraints, operation_category: null }, 'chip')
      case 'lender_type_required':
        return onChange({ ...constraints, lender_type_required: null }, 'chip')
      case 'us_states':
        return onChange({ ...constraints, us_states: states.filter((v) => v !== chip.value) }, 'chip')
      case 'asset_year':
        return onChange({ ...constraints, asset_year: null }, 'chip')
      case 'intl':
        // Only ever reachable for a keyword-derived requirement; a named foreign
        // country renders as non-removable and never produces an intl chip.
        return onChange({ ...constraints, intl_keyword_active: false }, 'chip')
    }
  }

  return (
    <div className="mt-3 space-y-2">
      {chips.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5" aria-label="Search criteria">
          <span className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground/80">
            Understood as
          </span>
          {chips.map((chip) => (
            <span
              key={chip.id}
              className="inline-flex items-center gap-1 rounded-full bg-foreground/[0.06] py-1 pl-2.5 pr-1.5 text-[12px] ring-1 ring-inset ring-border/60"
            >
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground/70">
                {chip.group}
              </span>
              {chip.label}
              {chip.removable ? (
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => removeChip(chip)}
                  aria-label={`Remove ${chip.label}`}
                  className="rounded-full p-0.5 text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground disabled:opacity-40"
                >
                  <X size={11} strokeWidth={2.5} aria-hidden />
                </button>
              ) : (
                <span
                  title="Edit the search text to change the country. Dropping it here could show lenders that do not lend there."
                  className="px-1 text-[10px] text-muted-foreground/70"
                  aria-hidden
                >
                  •
                </span>
              )}
            </span>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground/80">
          Narrow by
        </span>

        <FacetMenu label="Asset" active={assets.length} disabled={disabled}>
          <DropdownMenuGroup>
            {ASSET_CLASSES.map((c) => (
            <DropdownMenuCheckboxItem
              key={c}
              checked={assets.includes(c)}
              onCheckedChange={() =>
                onChange({ ...constraints, asset_classes: toggle(assets, c) }, 'facet')
              }
            >
                {assetLabel(c)}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuGroup>
        </FacetMenu>

        <FacetMenu label="Deal size" active={min !== null || max !== null ? 1 : 0} disabled={disabled}>
          <DropdownMenuGroup>
            {SIZE_BANDS.map((b) => (
            <DropdownMenuCheckboxItem
              key={b.label}
              checked={min === b.min && max === b.max}
              onCheckedChange={() =>
                onChange(
                  min === b.min && max === b.max
                    ? { ...constraints, deal_size_min_usd: null, deal_size_max_usd: null }
                    : { ...constraints, deal_size_min_usd: b.min, deal_size_max_usd: b.max },
                  'facet',
                )
              }
            >
                {b.label}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuGroup>
        </FacetMenu>

        <FacetMenu label="Operation" active={(operation ? 1 : 0) + usages.length} disabled={disabled}>
          <DropdownMenuGroup>
            <DropdownMenuLabel>Usage</DropdownMenuLabel>
            {USAGE_CODES.map((u) => (
            <DropdownMenuCheckboxItem
              key={u.code}
              checked={usages.includes(u.code)}
              onCheckedChange={() => onChange({ ...constraints, usage_codes: toggle(usages, u.code) }, 'facet')}
            >
                {u.label}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuLabel>Operation category</DropdownMenuLabel>
            {OPERATIONS.map((o) => (
            <DropdownMenuCheckboxItem
              key={o.value}
              checked={operation === o.value}
              onCheckedChange={() =>
                onChange({ ...constraints, operation_category: operation === o.value ? null : o.value }, 'facet')
              }
            >
                {o.label}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuGroup>
        </FacetMenu>

        <FacetMenu label="Lender" active={lenderKind ? 1 : 0} disabled={disabled}>
          <DropdownMenuGroup>
            {LENDER_KINDS.map((k) => (
            <DropdownMenuCheckboxItem
              key={k}
              checked={lenderKind === k}
              onCheckedChange={() =>
                onChange({ ...constraints, lender_type_required: lenderKind === k ? null : k }, 'facet')
              }
            >
                {k.replace(/^./, (m) => m.toUpperCase())}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuGroup>
          <div className="px-2 py-1.5 text-[11px] leading-snug text-muted-foreground">
            Lenders whose kind is not recorded are always kept.
          </div>
        </FacetMenu>

        <FacetMenu label={ASSET_AGE.label} active={assetYear !== null ? 1 : 0} disabled={disabled}>
          <DropdownMenuGroup>
            <DropdownMenuLabel>Age band</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {AGE_BANDS.map((b) => {
              const year = thisYear - b.minAge
              return (
                <DropdownMenuCheckboxItem
                  key={b.label}
                  checked={assetYear === year}
                  onCheckedChange={() =>
                    onChange(
                      { ...constraints, asset_year: assetYear === year ? null : year },
                      'facet',
                    )
                  }
                >
                  {b.label}
                  <span className="ml-1.5 text-[11px] text-muted-foreground">
                    {b.maxAge === null ? `${year} or older` : `${thisYear - b.maxAge}-${year}`}
                  </span>
                </DropdownMenuCheckboxItem>
              )
            })}
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuLabel>{ASSET_AGE.yearLabel}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {assetYears(thisYear).map((y) => (
              <DropdownMenuCheckboxItem
                key={y}
                checked={assetYear === y}
                onCheckedChange={() =>
                  onChange({ ...constraints, asset_year: assetYear === y ? null : y }, 'facet')
                }
              >
                {y}
                <span className="ml-1.5 text-[11px] text-muted-foreground">
                  {thisYear - y === 0 ? 'new' : `${thisYear - y} yr`}
                </span>
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuGroup>
          <div className="px-2 py-1.5 text-[11px] leading-snug text-muted-foreground">
            Hides lenders whose record states an age limit this asset breaks. Lenders
            with no stated limit are always kept. A band is held to its youngest asset, so a
            lender that can finance part of the band stays in.
          </div>
        </FacetMenu>

        <FacetMenu label="State" active={states.length} disabled={disabled}>
          <DropdownMenuGroup>
            {US_STATE_NAMES.map((s) => (
              <DropdownMenuCheckboxItem
                key={s}
                checked={states.includes(s)}
                onCheckedChange={() =>
                  onChange({ ...constraints, us_states: toggle(states, s) }, 'facet')
                }
              >
                {s}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuGroup>
          <div className="px-2 py-1.5 text-[11px] leading-snug text-muted-foreground">
            Nationwide lenders always qualify. A lender that lists its states is held to them.
          </div>
        </FacetMenu>
      </div>

      {notice && (
        <p role="status" className="text-[11px] text-amber-700 dark:text-amber-400">
          {notice}
        </p>
      )}

      {fxNotice && (
        <p role="status" className="text-[11px] text-amber-700 dark:text-amber-400">
          {fxNotice}
        </p>
      )}

      {inferredNotice && (
        <p role="status" className="text-[11px] text-muted-foreground">
          {inferredNotice}
        </p>
      )}
    </div>
  )
}
