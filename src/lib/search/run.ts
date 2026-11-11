/**
 * Shared search core — the hybrid NL → lender pipeline used by both
 * /api/search (Clerk-gated, returns full rows) and /api/search/debug
 * (bearer-gated, returns ranking mechanics only, no sensitive fields).
 *
 * Pipeline: deterministic deal extraction → embed (only AI hop) → pgvector
 * kNN (funding sources + doc chunks) → FTS → GraphRAG (deterministic seeds)
 * → RRF fuse → past-deal boost → no-drop deal-fit re-rank → optional rerank.
 * Every AI/DB sub-step degrades gracefully.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { llm } from '@/lib/llm/client'
import { rrf } from '@/lib/embeddings'
import {
  applyPastDealBoost,
  fundingSourceIdsWithPastDeal,
  tokenizeQuery,
} from '@/lib/search/past-deal-boost'
import { extractDeal, hasIntlKeyword, type DealExtract } from '@/lib/search/extract-deal'
import { bareLenderKind, nameLookupIsSpecific } from '@/lib/search/lookup'
import {
  mergeConstraints,
  type SearchConstraints,
  type EffectiveCriteria,
} from '@/lib/search/constraints'
import {
  rankByFit,
  type DealCriteria,
  type LenderRow,
  type FitVerdict,
} from '@/lib/search/structured-filter'
import { graphRankFunders } from '@/lib/graph/traverse'
import { naturalKeys } from '@/lib/graph/types'
import { rerankCandidates } from '@/lib/search/rerank'

export interface SearchParams {
  q: string
  assetClasses?: string[]
  /**
   * Operator edits to the parsed criteria, from the chip/facet UI. Values only —
   * every derivation happens server-side in mergeConstraints().
   */
  constraints?: SearchConstraints
  limit?: number
  rewrite?: boolean
  graph?: boolean
  rerank?: boolean
}

type HydratedRow = LenderRow & {
  id: string
  company_name: string
  internal_notes: string | null
  rate_notes: string | null
}

export interface SearchResult {
  results: Array<HydratedRow & { fit: FitVerdict }>
  /** What the sentence alone parsed to — the AI's raw reading. */
  extraction: DealExtract
  /**
   * What the search actually ran on: the parse plus the operator's chip/facet
   * edits, with `removed` naming any constraint they dropped. This is what the
   * UI renders as chips, so the screen always shows the real criteria rather
   * than a stale echo of the sentence.
   */
  effective: EffectiveCriteria
  effectiveAssetClasses: string[]
  graphSeedKeys: string[]
  sourceCounts: { vector: number; docVector: number; fts: number; graph: number }
  flags: {
    embedFailed: string | null
    graphFailed: string | null
    rerankFailed: string | null
    /** The query was a lender NAME, so the result is a name lookup, not a deal match. */
    nameLookup: string | null
  }
  timings: { embedMs: number; totalMs: number }
}

export async function runSearch(
  supabase: SupabaseClient,
  params: SearchParams,
): Promise<SearchResult> {
  const t0 = Date.now()
  const limit = params.limit ?? 25
  const rewrite = params.rewrite ?? true
  const useGraph = params.graph ?? process.env.GRAPHRAG_ENABLED !== 'false'
  const useRerank = params.rerank ?? process.env.SEARCH_RERANK_ENABLED === 'true'

  // 0) Deterministic NL → params (no LLM).
  const ex: DealExtract = rewrite
    ? extractDeal(params.q)
    : {
        semantic_query: params.q,
        asset_classes: [],
        deal_size_min_usd: null,
        deal_size_max_usd: null,
        geographic_scope: [],
        industry_filters: [],
        asset_families: [],
        asset_models: [],
        intl_required: false,
      }
  // 0b) Fold in the operator's on-screen edits. The legacy `assetClasses` param
  // (the old standalone asset-focus row, and /api/search/debug) maps onto the
  // same mechanism so there is exactly one path to an effective criteria set.
  const constraints: SearchConstraints | undefined =
    params.constraints ??
    (params.assetClasses?.length ? { asset_classes: params.assetClasses } : undefined)
  const effective = mergeConstraints(ex, constraints, {
    queryHasIntlKeyword: rewrite && hasIntlKeyword(params.q),
  })

  // A bare query that IS a lender KIND is a request for that category, not a
  // company name. "bank" matches about half the company names in a real
  // roster, so without this the kind a user asks for ("Bank")
  // resolved to a NAME lookup: capped at the display limit and missing every
  // bank whose name does not contain the word. Exact match
  // against the stored vocabulary, so it may drive the hard-excluding
  // lender-type dimension. An explicit facet pick always wins.
  const bareKind = rewrite ? bareLenderKind(params.q) : null
  if (bareKind && !effective.lender_type_required) {
    effective.lender_type_required = bareKind
  }

  const derivedSeedKeys = [
    ...effective.geographic_scope.map(naturalKeys.geo),
    ...ex.asset_families.map(naturalKeys.asset_family),
    ...ex.asset_models.map(naturalKeys.asset_model),
    ...ex.industry_filters.map(naturalKeys.industry),
  ]
  const effectiveAssetClasses = effective.asset_classes

  // 0c) Name lookup.
  //
  // Searching a lender's name returned that lender first, followed by a long
  // tail of unrelated lenders. A bare company name states no asset, no
  // geography and no size, so hasStructured is false, nothing hard-excludes, and
  // the output is the raw RRF fusion of vector + FTS — which is loose by design.
  //
  // Looking up a lender by name is a different question from matching a deal,
  // and it has an exact answer. When the sentence carries NO deal criteria and
  // the text matches a company name in the roster, answer the question actually
  // asked: those lenders, closest name first, and nothing else. Deterministic,
  // one indexed lookup, and it cannot produce a wrong lender because it is not
  // claiming a match — it is finding a record.
  const statedAnything =
    effective.asset_classes.length > 0 ||
    effective.geographic_scope.length > 0 ||
    effective.deal_size_min_usd !== null ||
    effective.deal_size_max_usd !== null ||
    effective.intl_required ||
    (effective.usage_codes ?? []).length > 0 ||
    Boolean(effective.operation_category) ||
    Boolean(effective.lender_type_required) ||
    (effective.us_states ?? []).length > 0 ||
    (effective.asset_year ?? null) !== null
  const nameTerm = params.q.trim()
  if (!statedAnything && nameTerm.length >= 2 && nameTerm.length <= 60) {
    const escaped = nameTerm.replace(/[%_]/g, '\\$&')
    const {
      data: nameRows,
      error: nameErr,
      count: nameCount,
    } = await supabase
      .from('funding_sources')
      .select('*', { count: 'exact' })
      .ilike('company_name', `%${escaped}%`)
      .or('active.is.null,active.eq.true')
      // Ordered before the limit: an unordered limit can drop the exact match
      // before ranking ever sees it, which is the failure this path exists to
      // fix. Alphabetical is a total order, so the same term always returns the
      // same rows regardless of physical row order.
      .order('company_name', { ascending: true })
      .limit(limit)
    // A failed lookup is not "no lender by that name" — fall through to the
    // ranked pipeline rather than answering a question we could not run.
    if (nameErr) console.warn('[search] name lookup failed', nameErr.message)
    const hits = (nameErr ? [] : (nameRows ?? [])) as HydratedRow[]
    // The roster is the denominator for "is this term specific enough to be a
    // name". count is the FULL match size, not the limited page.
    const { count: rosterCount } = await supabase
      .from('funding_sources')
      .select('id', { count: 'exact', head: true })
      .or('active.is.null,active.eq.true')
    if (hits.length > 0 && nameLookupIsSpecific(nameCount ?? hits.length, rosterCount ?? 0)) {
      const lower = nameTerm.toLowerCase()
      // Exact name first, then names that start with the term, then the rest —
      // so "Rigel" leads with Rigel rather than with whatever sorts alphabetically.
      const rank = (n: string) => {
        const c = n.toLowerCase()
        if (c === lower) return 0
        if (c.startsWith(lower)) return 1
        return 2
      }
      const ordered = hits
        .slice()
        .sort(
          (a, b) =>
            rank(a.company_name) - rank(b.company_name) ||
            a.company_name.localeCompare(b.company_name),
        )
      const order = new Map(ordered.map((r, i) => [r.id, i]))
      const deal: DealCriteria = {
        asset_classes: [],
        geographic_scope: [],
        deal_size_min_usd: null,
        deal_size_max_usd: null,
        intl_required: false,
      }
      return {
        results: rankByFit(ordered, deal, order),
        extraction: ex,
        effective,
        effectiveAssetClasses,
        graphSeedKeys: [],
        sourceCounts: { vector: 0, docVector: 0, fts: 0, graph: hits.length },
        flags: { embedFailed: null, graphFailed: null, rerankFailed: null, nameLookup: nameTerm },
        timings: { embedMs: 0, totalMs: Date.now() - t0 },
      }
    }
  }

  // 1) Vector kNN (best-effort).
  let vectorIds: string[] = []
  const docVectorIds: string[] = []
  let embedFailed: string | null = null
  let embedMs = 0
  try {
    const tE = Date.now()
    const { embeddings } = await llm.embed({ supabase, module: 'search', values: [ex.semantic_query] })
    embedMs = Date.now() - tE
    const queryEmbedding = embeddings[0]
    const { data: fsHits, error: fsErr } = await supabase.rpc('match_funding_sources', {
      query_embedding: queryEmbedding,
      match_count: limit,
    })
    if (fsErr) throw fsErr
    vectorIds = (fsHits ?? []).map((r: { id: string }) => r.id)
    try {
      const { data: docHits } = await supabase.rpc('match_doc_chunks', {
        query_embedding: queryEmbedding,
        match_count: limit * 2,
      })
      const seen = new Set<string>()
      for (const r of (docHits ?? []) as Array<{ funding_source_id: string }>) {
        if (!seen.has(r.funding_source_id)) {
          seen.add(r.funding_source_id)
          docVectorIds.push(r.funding_source_id)
        }
      }
    } catch {
      /* doc chunks optional */
    }
  } catch (e) {
    embedFailed = e instanceof Error ? e.message : 'embed failed'
    console.warn('search.embed failed, falling back to FTS-only:', embedFailed)
  }

  // 2) FTS.
  let ftsIds: string[] = []
  {
    let q2 = supabase
      .from('funding_sources')
      .select('id')
      .textSearch('search_tsv', ex.semantic_query, { type: 'websearch' })
      .limit(limit)
    if (effectiveAssetClasses.length) q2 = q2.overlaps('asset_classes', effectiveAssetClasses)
    const { data } = await q2
    ftsIds = (data ?? []).map((r: { id: string }) => r.id)
  }

  // 2b) Graph (deterministic seeds).
  let graphIds: string[] = []
  let graphSeedKeys: string[] = []
  let graphFailed: string | null = null
  if (useGraph) {
    try {
      const ranked = await graphRankFunders(supabase, ex.semantic_query, {
        limit: limit * 2,
        maxHops: 3,
        seedKeys: derivedSeedKeys,
      })
      graphIds = ranked.funderIds
      graphSeedKeys = ranked.seedKeys
    } catch (e) {
      graphFailed = e instanceof Error ? e.message : 'graph failed'
      console.warn('search.graph failed, skipping graph layer:', graphFailed)
    }
  }

  const sourceCounts = {
    vector: vectorIds.length,
    docVector: docVectorIds.length,
    fts: ftsIds.length,
    graph: graphIds.length,
  }

  // 3) Fuse.
  let fused = rrf([vectorIds, docVectorIds, ftsIds, graphIds]).slice(0, limit * 2)

  // 3a) Structured completeness. When the query carries deterministic criteria
  // (geo / asset / size / intl), consider the WHOLE active roster, not just what
  // vector + FTS + graph happened to retrieve.
  //
  // This used to fire only when the embed hop was down or retrieval came back
  // empty, which left a silent recall hole the rest of the time:
  // "equipment financing in Canada" returned a handful of lenders while
  // several times as many passed the fit filter. Banks whose stated geography
  // is literally Canada were absent, not because they were excluded but
  // because no retriever surfaced them. A broker asking for Canadian financing and not
  // being shown the Canadian banks is the same firing-level error as a wrong
  // lender, just in the other direction.
  //
  // Structured matching is exact and the roster is a few hundred rows, so
  // letting a vector's top-K decide who is even considered was never sound.
  // Semantic order still ranks (it is the tiebreaker inside rankByFit); it just
  // no longer gates. hasStructured keeps a constraint-less query from dumping
  // the whole index.
  //
  // Every exclusion-capable dimension counts here, not just the first four.
  // usage_codes / operation_category / lender_type_required were omitted, and
  // lenderTypeDim can hard-exclude — so ticking "Lender: Bank" only ever
  // subtracted from whatever ≤50 rows retrieval happened to surface, while
  // ticking "Asset: Equipment" searched the whole roster. Two menus in the same row,
  // two different universes, and no way for the operator to tell which one they
  // were in. That is half of "the search functions do not consistently work".
  const hasStructured =
    effectiveAssetClasses.length > 0 ||
    effective.geographic_scope.length > 0 ||
    effective.deal_size_min_usd !== null ||
    effective.deal_size_max_usd !== null ||
    effective.intl_required ||
    (effective.usage_codes ?? []).length > 0 ||
    Boolean(effective.operation_category) ||
    Boolean(effective.lender_type_required) ||
    (effective.us_states ?? []).length > 0 ||
    (effective.asset_year ?? null) !== null
  let structuralFallback = false
  if (hasStructured) {
    // Ordered so the appended tail has a stable, meaningful sequence. Ranking
    // still decides position; this only settles exact ties (see rankByFit).
    // If this scan fails the shortlist is silently short with no degraded
    // banner — the whole point of the pass is that retrieval alone under-recalls.
    const { data: allActive, error: rosterErr } = await supabase
      .from('funding_sources')
      .select('id')
      .or('active.is.null,active.eq.true')
      .order('company_name', { ascending: true })
    if (rosterErr) {
      throw new Error(`Could not read the funding-source roster — ${rosterErr.message}`)
    }
    const seen = new Set(fused)
    for (const r of (allActive ?? []) as Array<{ id: string }>) {
      if (!seen.has(r.id)) fused.push(r.id)
    }
    structuralFallback = fused.length > 0
  }

  if (fused.length === 0) {
    return {
      results: [],
      extraction: ex,
      effective,
      effectiveAssetClasses,
      graphSeedKeys,
      sourceCounts,
      flags: { embedFailed, graphFailed, rerankFailed: null, nameLookup: null },
      timings: { embedMs, totalMs: Date.now() - t0 },
    }
  }

  // 3b) Past-deal boost. Cap candidates at `limit` normally, but in structural-
  // fallback mode keep the WHOLE pool (no pre-rank cap) so deal-fit ranking sees
  // every eligible lender — the fallback set has no semantic order, so an
  // arbitrary pre-rank slice could drop a best-fit lender. The full active roster
  // is small (hundreds); the final `.slice(0, limit)` after ranking trims display.
  const candidateCap = structuralFallback ? fused.length : limit
  const tokens = tokenizeQuery(ex.semantic_query)
  const boostedIds = await fundingSourceIdsWithPastDeal(supabase, tokens, fused)
  fused = applyPastDealBoost(fused, boostedIds).slice(0, candidateCap)

  // 4) Hydrate + deal-fit re-rank (hard-excludes stated-criteria contradictions).
  //    `active=false` is the soft-delete flag and is dropped here. Being closed
  //    for business is a DIFFERENT column (`lending_status`/`status`) that no
  //    filter here touches — rankByFit sorts those to the bottom instead, since
  //    a paused lender may reopen and the team needs to see it.
  // Destructure `error`. Swallowing it here meant a failed hydration returned
  // HTTP 200 with `results: []`, which the list renders as "No funding sources
  // match your filters." — the authoritative-empty-result bug that was fixed at
  // the route layer on 2026-09-08, still reachable from underneath it.
  const { data: rawRows, error: hydrateErr } = await supabase
    .from('funding_sources')
    .select('*')
    .in('id', fused)
  if (hydrateErr) throw new Error(`Could not load the matching lenders — ${hydrateErr.message}`)
  const rows = (rawRows ?? []).filter((r: { active?: boolean | null }) => r.active !== false)
  const order = new Map(fused.map((id, i) => [id, i]))
  const deal: DealCriteria = {
    asset_classes: effectiveAssetClasses,
    geographic_scope: effective.geographic_scope,
    deal_size_min_usd: effective.deal_size_min_usd,
    deal_size_max_usd: effective.deal_size_max_usd,
    intl_required: effective.intl_required,
    usage_codes: effective.usage_codes,
    operation_category: effective.operation_category,
    lender_type_required: effective.lender_type_required,
    us_states: effective.us_states ?? [],
    asset_year: effective.asset_year ?? null,
    as_of_year: new Date().getUTCFullYear(),
    size_confidence: effective.deal_size_confidence ?? 'stated',
    asset_year_confidence: effective.asset_year_confidence ?? 'stated',
  }
  const ordered0 = rankByFit((rows ?? []) as HydratedRow[], deal, order)
  // NO display cap in structural-fallback mode.
  //
  // This used to `.slice(0, limit)` "so the UI stays scannable". rankByFit has
  // already dropped every lender that CONTRADICTS a stated criterion, so what
  // survives is the set of lenders that can actually do the deal — and cutting
  // that at 25 hides qualified lenders behind a number with no meaning to the
  // operator. "Equipment in West Virginia, $12,000,000" returned 25 when many
  // more of the roster can write that deal. Truncating a
  // ranked shortlist of eligible lenders is the same firing-level error as a
  // wrong lender, in the other direction — the broker never learns the lender
  // existed. Ranking still puts the best fit first; the roster is a few hundred
  // rows, so there is nothing to protect the page from.
  //
  // The semantic-only path (no stated criteria) still honours `limit`, because
  // there nothing has been filtered and the tail is just descending similarity.
  let ordered = ordered0

  // 5) Optional LLM reranker.
  let rerankFailed: string | null = null
  if (useRerank && ordered.length > 1) {
    try {
      const candidates = ordered.slice(0, Math.min(ordered.length, 25)).map((r) => ({
        id: r.id,
        label: r.company_name,
        summary: [r.internal_notes ?? '', r.rate_notes ?? ''].join(' · ').slice(0, 400),
      }))
      const rerankedIds = await rerankCandidates(supabase, ex.semantic_query, candidates, {
        limit: candidates.length,
      })
      const byId = new Map(ordered.map((r) => [r.id, r]))
      const head = rerankedIds.map((id) => byId.get(id)).filter(Boolean) as typeof ordered
      ordered = [...head, ...ordered.slice(head.length)]
    } catch (e) {
      rerankFailed = e instanceof Error ? e.message : 'rerank failed'
      console.warn('search.rerank failed, keeping fused order:', rerankFailed)
    }
  }

  return {
    results: ordered,
    extraction: ex,
    effective,
    effectiveAssetClasses,
    graphSeedKeys,
    sourceCounts,
    flags: { embedFailed, graphFailed, rerankFailed, nameLookup: null },
    timings: { embedMs, totalMs: Date.now() - t0 },
  }
}
