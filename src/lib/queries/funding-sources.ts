import { getSupabaseServer } from '@/lib/supabase/server'
import type { FundingSourceRow } from '@/lib/types/funding-source'
import { sourceIdsWithTags, type Tag } from '@/lib/tags/repo'
import type { SearchConstraints } from '@/lib/search/constraints'
import { hasAnyFacet, readFacetParams } from '@/lib/search/facet-params'
import { rankByFit, type DealCriteria } from '@/lib/search/structured-filter'

export type FundingSourceFilters = {
  search: string
  assetClasses: string[]
  geos: string[]
  status: string | null
  dealMin: number | null
  dealMax: number | null
  tagIds: string[]
  /** Pre-ranked id list from /api/search (semantic). When set, the list
   *  is restricted to these ids and preserved in this order. */
  semanticIds: string[]
  /**
   * "Narrow by" selections with no search sentence. Applied through the same
   * structured matcher `/api/search` uses, not a parallel SQL filter — one set
   * of rules, so a lender kept by search is kept by a browse narrow-down and
   * blank-is-unknown-so-keep holds in both.
   */
  facets: SearchConstraints
}

export type FundingSourceRowWithTags = FundingSourceRow & {
  tags: { id: string; name: string; color: Tag['color'] }[]
  /**
   * Set on the BROWSE path (facets, no search sentence): this lender's record
   * names the place that was asked for, which is why it sorted above the
   * nationwide ones.
   *
   * The search path carries the same fact to the client in its own response and
   * renders it from there. Browse renders on the server and writes no client
   * stash, so without this the rows were correctly reordered and completely
   * unlabelled — and a reordering nobody can see reads as randomness, which is
   * the complaint the ordering exists to answer. The common workflow (Narrow by →
   * State, no sentence) is exactly this path.
   */
  localToRequest?: boolean
  /**
   * Same problem, same fix, for the signals read out of `internal_notes`: the
   * browse path renders on the server, so a verdict the matcher computed and
   * threw away is a reordering nobody can see. Each carries the sentence it was
   * read from — see FitVerdict.notesPrefer / notesAvoid / notesPaused.
   */
  notesPrefer?: string | null
  notesAvoid?: string | null
  notesPaused?: string | null
}

export function buildFundingSourceQuery(
  params: Record<string, string | undefined>
): FundingSourceFilters {
  const toArray = (s?: string) => (s ? s.split(',').filter(Boolean) : [])
  const toNum = (s?: string) => (s ? Number(s) : null)
  return {
    search: params.q ?? '',
    assetClasses: toArray(params.asset_classes),
    geos: toArray(params.geos),
    status: params.status ?? null,
    dealMin: toNum(params.deal_min),
    dealMax: toNum(params.deal_max),
    tagIds: toArray(params.tags),
    semanticIds: toArray(params.ids),
    facets: readFacetParams(params),
  }
}

export async function listFundingSources(
  filters: FundingSourceFilters
): Promise<FundingSourceRowWithTags[]> {
  const sb = await getSupabaseServer()

  // Semantic-search short-circuit: when /api/search returned a ranked
  // list, render those rows in that order and skip every other filter.
  if (filters.semanticIds.length) {
    const { data, error } = await sb
      .from('funding_sources')
      .select('*')
      .in('id', filters.semanticIds)
    if (error) throw error
    const order = new Map(filters.semanticIds.map((id, i) => [id, i]))
    const rows = ((data ?? []) as FundingSourceRow[]).slice().sort(
      (a, b) => (order.get(a.id) ?? 99) - (order.get(b.id) ?? 99),
    )
    return await hydrateTags(sb, rows)
  }

  // Alphabetical, and every row.
  //
  // Was `updated_at desc` with `.limit(200)`. Two problems: users could not tell
  // how the list was sorted ("it doesn't look alphabetical").
  // Recency is invisible to a reader, so the order looked arbitrary.
  //
  // Worse, the cap could sit under the roster size: the browse list rendered
  // only 200 rows, so the least-recently-updated sources past that were
  // unreachable by browsing and the footer count said 200. For a reference
  // index whose whole job is "who are all our funding sources", silently hiding
  // a quarter of them is the wrong default. The cap stays only as a runaway
  // guard, well above the roster.
  let q = sb
    .from('funding_sources')
    .select('*')
    .order('company_name', { ascending: true })
    .limit(2000)

  if (filters.search) {
    const term = filters.search.replace(/[%_]/g, '\\$&')
    q = q.or(
      `company_name.ilike.%${term}%,internal_notes.ilike.%${term}%,rate_notes.ilike.%${term}%`
    )
  }
  // Geography used to be a plain `.overlaps('geographic_scope', …)` here, and
  // that had the exact defect the comment beside it said had been fixed for
  // asset class: Postgres `&&` against an empty array is false, so every lender
  // with a blank `geographic_scope` was dropped by the database before the
  // matcher ever saw it. Blank means unknown and unknown is kept — a lender
  // with scope `{}` was invisible to every geography link in the app.
  //
  // It also could not see `specific_geographic`, which lenderGeoCells reads, so
  // a lender whose only stated coverage sat in the detail cell was dropped too.
  //
  // Narrowing now happens in the structured matcher below, on the same terms as
  // every other dimension: stated contradiction excludes, blank is kept.
  const geoNarrow = filters.geos
  if (filters.status) q = q.eq('status', filters.status)

  // Tag filter: pre-resolve the source IDs that have at least one of the
  // requested tags, then intersect via .in(). Avoids a join + DISTINCT.
  if (filters.tagIds.length) {
    const ids = await sourceIdsWithTags(sb, filters.tagIds)
    if (ids.length === 0) return []
    q = q.in('id', ids)
  }

  const { data, error } = await q
  if (error) throw error
  let rows = (data ?? []) as FundingSourceRow[]

  // "Narrow by" with no search sentence. The roster is a few hundred rows and
  // already in memory, so running the real matcher over it costs nothing and
  // buys one consistent definition of "fits": hard-excludes only on a stated
  // contradiction, keeps every blank, demotes lenders marked not-currently-
  // lending instead of hiding them. rankByFit's alphabetical final tiebreaker
  // keeps the order identical to the unfiltered list.
  if (hasAnyFacet(filters.facets) || geoNarrow.length > 0) {
    const f = filters.facets
    const deal: DealCriteria = {
      asset_classes: f.asset_classes ?? [],
      geographic_scope: geoNarrow,
      deal_size_min_usd: f.deal_size_min_usd ?? null,
      deal_size_max_usd: f.deal_size_max_usd ?? null,
      intl_required: false,
      usage_codes: f.usage_codes ?? [],
      operation_category: f.operation_category ?? null,
      lender_type_required: f.lender_type_required ?? null,
      us_states: f.us_states ?? [],
      asset_year: f.asset_year ?? null,
      as_of_year: new Date().getUTCFullYear(),
    }
    const active = rows.filter((r) => (r as { active?: boolean | null }).active !== false)
    // Keep the verdict, not just the order — see localToRequest above.
    rows = rankByFit(active, deal, new Map()).map((r) => ({
      ...r,
      localToRequest: r.fit.localToRequest,
      notesPrefer: r.fit.notesPrefer,
      notesAvoid: r.fit.notesAvoid,
      notesPaused: r.fit.notesPaused,
    }))
  }

  return await hydrateTags(sb, rows)
}

type SupabaseSrv = Awaited<ReturnType<typeof getSupabaseServer>>

async function hydrateTags(
  sb: SupabaseSrv,
  rows: FundingSourceRow[],
): Promise<FundingSourceRowWithTags[]> {
  if (rows.length === 0) return []
  type RawTagJoin = {
    funding_source_id: string
    tag: { id: string; name: string; color: Tag['color'] } | { id: string; name: string; color: Tag['color'] }[] | null
  }
  const { data: tagRows } = await sb
    .from('funding_source_tag')
    .select('funding_source_id, tag:tag_id ( id, name, color )')
    .in('funding_source_id', rows.map((r) => r.id))

  type FlatTag = { id: string; name: string; color: Tag['color'] }
  const byId = new Map<string, FlatTag[]>()
  for (const row of (tagRows ?? []) as unknown as RawTagJoin[]) {
    const t = row.tag
    if (!t) continue
    const flat = Array.isArray(t) ? t[0] : t
    if (!flat) continue
    const arr = byId.get(row.funding_source_id) ?? []
    arr.push(flat)
    byId.set(row.funding_source_id, arr)
  }
  return rows.map((r) => ({ ...r, tags: byId.get(r.id) ?? [] }))
}
