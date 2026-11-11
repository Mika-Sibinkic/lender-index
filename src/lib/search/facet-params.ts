/**
 * The "Narrow by" menus, expressed as URL parameters.
 *
 * With a search sentence up, facet picks ride the POST body to /api/search and
 * the ranked ids come back in `?ids=`. With NO sentence the list is a plain
 * server-rendered browse, and until now only `asset_classes` was written here —
 * so ticking Deal size, Usage, Operation or Lender kind lit up a count badge
 * on the menu and changed nothing on screen. That is "Narrow by – does [not]
 * seem to be updating results", and it is also why "can we do Narrow down and
 * then search bar?" felt broken: the narrowing appeared to do
 * nothing until a sentence was typed.
 *
 * One module owns the parameter names so the client writer and the server reader
 * cannot drift apart.
 */

import type { SearchConstraints } from '@/lib/search/constraints'

const list = (v: string | undefined): string[] => (v ? v.split(',').filter(Boolean) : [])
const num = (v: string | undefined): number | null => {
  if (!v) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** Read facet selections out of URL search params. */
export function readFacetParams(p: Record<string, string | undefined>): SearchConstraints {
  const c: SearchConstraints = {}
  const assets = list(p.asset_classes)
  if (assets.length) c.asset_classes = assets
  const states = list(p.states)
  if (states.length) c.us_states = states
  const usage = list(p.usage)
  if (usage.length) c.usage_codes = usage
  const min = num(p.deal_min)
  if (min !== null) c.deal_size_min_usd = min
  const max = num(p.deal_max)
  if (max !== null) c.deal_size_max_usd = max
  if (p.operation) c.operation_category = p.operation
  if (p.lender_kind) c.lender_type_required = p.lender_kind
  const year = num(p.asset_year)
  if (year !== null) c.asset_year = year
  return c
}

/** Mirror of readFacetParams — writes selections onto an existing URL. */
export function writeFacetParams(target: URLSearchParams, c: SearchConstraints): void {
  const setList = (key: string, v: string[] | undefined) => {
    if (v && v.length) target.set(key, v.join(','))
    else target.delete(key)
  }
  const setOne = (key: string, v: string | number | null | undefined) => {
    if (v === null || v === undefined || v === '') target.delete(key)
    else target.set(key, String(v))
  }
  setList('asset_classes', c.asset_classes)
  setList('states', c.us_states)
  setList('usage', c.usage_codes)
  setOne('deal_min', c.deal_size_min_usd)
  setOne('deal_max', c.deal_size_max_usd)
  setOne('operation', c.operation_category)
  setOne('lender_kind', c.lender_type_required)
  setOne('asset_year', c.asset_year)
}

/** Every parameter name this module owns, for bulk clearing. */
export const FACET_PARAM_NAMES = [
  'asset_classes',
  'states',
  'usage',
  'deal_min',
  'deal_max',
  'operation',
  'lender_kind',
  'asset_year',
] as const

export function hasAnyFacet(c: SearchConstraints): boolean {
  return (
    (c.asset_classes?.length ?? 0) > 0 ||
    (c.us_states?.length ?? 0) > 0 ||
    (c.usage_codes?.length ?? 0) > 0 ||
    c.deal_size_min_usd != null ||
    c.deal_size_max_usd != null ||
    Boolean(c.operation_category) ||
    Boolean(c.lender_type_required) ||
    c.asset_year != null
  )
}
