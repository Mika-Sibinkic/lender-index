'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { useEffect, useRef, useState } from 'react'
import { SearchCriteria } from '@/components/funding-sources/search-criteria'
import type { SearchConstraints, EffectiveCriteria } from '@/lib/search/constraints'
import type { Tag } from '@/lib/tags/repo'
import { TagFilter } from '@/components/funding-sources/tag-filter'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { QuickAddForm } from '@/components/funding-sources/quick-add-form'
import { SEARCH_FIT_KEY } from '@/components/funding-sources/search-fit'
import { humanError } from '@/lib/ui/error-message'
import { DEMO_QUERY } from '@/lib/config/domain'
import {
  FACET_PARAM_NAMES,
  readFacetParams,
  writeFacetParams,
} from '@/lib/search/facet-params'

/**
 * Constraint keys the "Narrow by" menus can set.
 *
 * geographic_scope and intl_keyword_active are deliberately absent: they only
 * ever come from the search sentence. That is what makes carrying facet picks
 * across a new sentence safe — the stale-geography failure the reset guards
 * against (clear geography on a Texas deal, then search Brazil, and US-only
 * lenders lead a Brazil shortlist) cannot be reached through a facet.
 *
 * us_states and asset_year ARE facet-settable despite being geography- and
 * asset-shaped, because neither can widen: us_states is an AND-narrowing
 * dimension that never feeds the international derivation, and asset_year
 * only ever excludes lenders whose own record states a limit it breaks.
 */
const FACET_SETTABLE_KEYS = [
  'asset_classes',
  'deal_size_min_usd',
  'deal_size_max_usd',
  'usage_codes',
  'operation_category',
  'lender_type_required',
  'us_states',
  'asset_year',
] as const satisfies readonly (keyof SearchConstraints)[]

/** Shallow equality that treats arrays by content, for change detection. */
function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => v === b[i])
  }
  return a === b
}

/** Keep only the keys the operator set via a facet menu; drop chip edits. */
function facetsOnly(c: SearchConstraints, keys: ReadonlySet<string>): SearchConstraints {
  const out: SearchConstraints = {}
  for (const k of FACET_SETTABLE_KEYS) {
    if (keys.has(k) && c[k] !== undefined) {
      ;(out as Record<string, unknown>)[k] = c[k]
    }
  }
  return out
}

// Sentinel id used when a semantic search returns zero hits, so the list
// renders an honest empty state instead of silently falling back to "all".
const NO_MATCH_ID = '00000000-0000-0000-0000-000000000000'

/**
 * Primary search bar = natural-language deal-match.
 *
 * The user types a deal in plain English (DEMO_QUERY in
 * src/lib/config/vocabulary.ts is the placeholder); on submit we POST to /api/search, which
 * deduces deal parameters, runs the hybrid pgvector + FTS + graph pipeline,
 * and returns a ranked lender list. The ranked ids ride the URL (`ids=`) so
 * the server-rendered list renders them in order.
 *
 * This replaces the old literal `ilike` substring filter — typing a sentence
 * into a substring matcher matched nothing.
 *
 * The criteria the search understood are rendered as editable chips underneath
 * (SearchCriteria), replacing the old standalone "Asset focus" row. That row was
 * a second, competing control: it filtered only asset type, was disconnected
 * from whatever the sentence had been parsed into, and left the parse itself
 * invisible. Now there is one control — sentence in, understood criteria on
 * screen, one click to adjust any of them.
 */
export function FilterBar({ tags = [], isAdmin = false }: { tags?: Tag[]; isAdmin?: boolean }) {
  const router = useRouter()
  const params = useSearchParams()
  const [q, setQ] = useState(params.get('q_semantic') ?? '')
  const [busy, setBusy] = useState(false)
  // Search | Add mode. Add turns the same bar into a natural-language intake:
  // paste lender prose or drop a card/PDF → the AI parses it into a pre-filled
  // card (with required gaps highlighted, dedup on submit).
  const [mode, setMode] = useState<'search' | 'add'>('search')
  const [addText, setAddText] = useState('')
  const [addOpen, setAddOpen] = useState(false)
  const [seedText, setSeedText] = useState('')
  const [seedFile, setSeedFile] = useState<File | null>(null)
  const addFileRef = useRef<HTMLInputElement>(null)

  function openAddWithText() {
    if (!addText.trim()) return
    setSeedFile(null)
    setSeedText(addText)
    setAddOpen(true)
  }
  function openAddWithFile(file: File) {
    setSeedText('')
    setSeedFile(file)
    setAddOpen(true)
  }
  // True when the last search degraded to keyword-only because the AI embedding
  // hop failed (on-prem backend down). Vector recall is off, so results may be
  // incomplete — we say so rather than presenting a thin list as authoritative.
  const [degraded, setDegraded] = useState(false)
  // A failed search must never be presented as a successful empty one.
  const [searchError, setSearchError] = useState<string | null>(null)
  // Set when the query was a lender NAME rather than a deal — the result is a
  // lookup, and saying so stops it reading as a (very short) shortlist.
  const [nameLookup, setNameLookup] = useState<string | null>(null)
  // The operator's edits to the parsed criteria, and the criteria the server
  // actually ran on. `effective` is the single source of truth for the chips —
  // never a client-side re-derivation, which could drift from the matching logic.
  const [constraints, setConstraints] = useState<SearchConstraints>(() => {
    // Browse mode keeps its facets in the URL, so a reload or a shared link
    // shows them already ticked rather than silently applied.
    const bag: Record<string, string | undefined> = {}
    for (const k of FACET_PARAM_NAMES) bag[k] = params.get(k) ?? undefined
    return readFacetParams(bag)
  })
  // Which constraint keys the operator set via a "Narrow by" menu, as opposed to
  // by editing a chip. Facet picks are standing filters and survive a new search
  // sentence; chip edits belong to the sentence they were made against.
  // Facets already in the URL were set from a menu, so they are standing filters
  // and must survive the first search sentence typed after them. Without this
  // seed, narrowing first and then searching silently dropped the narrowing.
  const [facetKeys, setFacetKeys] = useState<ReadonlySet<string>>(() => {
    const bag: Record<string, string | undefined> = {}
    for (const k of FACET_PARAM_NAMES) bag[k] = params.get(k) ?? undefined
    return new Set(Object.keys(readFacetParams(bag)))
  })
  const [effective, setEffective] = useState<EffectiveCriteria | null>(null)
  // The query the current constraints were edited against.
  const [constrainedQuery, setConstrainedQuery] = useState('')

  // Restore the criteria for a reloaded or shared search.
  //
  // Measured in production: after F5 on an active search the
  // "Understood as" chips vanished and every Narrow-by count reset to zero,
  // while the ranked, hard-excluded list stayed on screen. `q` is rehydrated
  // from the URL but `effective` is not, and `effective` is the only source the
  // chips read. A shortlist with invisible criteria is exactly the unverifiable
  // parse the merged control was built to eliminate.
  const rehydrated = useRef(false)
  useEffect(() => {
    if (rehydrated.current) return
    rehydrated.current = true
    if (!params.get('q_semantic') || effective) return
    void runSearch(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function runSearch(
    e: React.FormEvent | null,
    override?: { constraints?: SearchConstraints },
  ) {
    e?.preventDefault()
    const query = q.trim()
    // Constraints belong to the sentence they were edited against. Carrying them
    // onto a NEW sentence is silently wrong and accuracy-relevant: clear the
    // geography on "an excavator in Texas", then search "a tractor in Brazil", and
    // the stale empty geography would wipe Brazil and disarm the international
    // exclude — putting US-only lenders in front of a Brazil deal.
    const isChipEdit = override !== undefined
    const sameSentence = query === constrainedQuery
    // A "Narrow by" pick is a standing filter the operator set deliberately, so
    // it survives a new search sentence. A chip edit belongs to the sentence it
    // was made against and does not. Before this split, both were wiped together
    // and the facets vanished the moment you ran a search — which is what
    // operators reported. Geography is never facet-settable, so nothing carried here can
    // resurrect the stale-geography bug the reset exists to prevent.
    // The same-sentence guard applies to chip edits too. It used to be
    // short-circuited by `isChipEdit ||`, which left the documented Brazil
    // failure reachable through the very control built to prevent it: remove the
    // Texas chip on "an excavator in Texas", type "a tractor in Brazil" WITHOUT
    // submitting, then tick any Narrow-by item — the click re-ran the search with
    // the new sentence and the old sentence's emptied geography, disarming the
    // international exclude and putting US-only lenders on a Brazil deal.
    const raw = isChipEdit ? (override.constraints ?? {}) : constraints
    const nextConstraints = sameSentence ? raw : facetsOnly(raw, facetKeys)
    if (!sameSentence) setConstraints(nextConstraints)
    const next = new URLSearchParams(params)
    if (!query) {
      next.delete('q_semantic')
      next.delete('ids')
      setDegraded(false)
      setEffective(null)
      router.replace(`?${next.toString()}`)
      return
    }
    setBusy(true)
    try {
      const res = await fetch('/api/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ q: query, constraints: nextConstraints }),
      })
      if (!res.ok) {
        // A 502-character query is rejected by
        // the route's zod schema with HTTP 400, and this code went straight on to
        // read `json.results ?? []`, got an empty array, wrote the NO_MATCH
        // sentinel into the URL and rendered "No funding sources match your
        // filters." The operator is told, authoritatively, that no lender fits a
        // deal that dozens fit. That is the exact outcome the accuracy mandate
        // exists to prevent, and it is worse than a visible error because it
        // looks like an answer. Leave the previous results alone and say what
        // actually happened.
        const body = (await res.json().catch(() => ({}))) as { error?: unknown }
        setSearchError(
          res.status === 400
            ? `That search is too long (${query.length} characters, limit 500). Shorten it and try again.`
            : humanError(res.status, body.error),
        )
        setBusy(false)
        return
      }
      setSearchError(null)
      const json = await res.json().catch(() => ({}))
      const ids: string[] = (json.results ?? []).map((r: { id: string }) => r.id)
      const idsKey = ids.length ? ids.join(',') : NO_MATCH_ID
      // Adopt the server's effective criteria verbatim. It may differ from what
      // was sent — removing the last foreign country also disarms the
      // international requirement, for instance — and the chips must show what
      // actually ran, not what was requested.
      if (json?.effective) setEffective(json.effective as EffectiveCriteria)
      setConstrainedQuery(query)
      // Stash the server's fit verdict + the extracted deal size so the results
      // list can paint fit chips + the appetite-bar marker for THIS search only.
      // Scoped by idsKey (compared against the live ?ids= in search-fit) so a
      // stale search never paints fit onto a plain browse. Verdicts come straight
      // from the server — never recomputed on the client.
      try {
        const fitById: Record<string, unknown> = {}
        for (const r of json.results ?? []) {
          if (r?.id && r?.fit) fitById[r.id] = r.fit
        }
        sessionStorage.setItem(
          SEARCH_FIT_KEY,
          JSON.stringify({
            idsKey,
            deal: {
              min: json?.extraction?.deal_size_min_usd ?? null,
              max: json?.extraction?.deal_size_max_usd ?? null,
            },
            fitById,
          })
        )
      } catch {}
      // /api/search reports degraded retrieval via flags.embedFailed (non-null
      // when the embedding hop fell back to keyword + graph only). Surface it so
      // the operator knows the result set may be incomplete.
      setDegraded(Boolean(json?.flags?.embedFailed))
      setNameLookup((json?.flags?.nameLookup as string | null) ?? null)
      next.set('q_semantic', query)
      next.set('ids', idsKey)
      // Keep the facet params in the URL alongside `ids`.
      //
      // They used to be deleted here, which made a search URL unreproducible:
      // reload or share it and the criteria that produced the list were gone.
      // Re-applying them to the id list is not a risk — listFundingSources
      // short-circuits on `ids` and returns before the facet filter runs, so the
      // params are inert while a search is active and only describe it.
      writeFacetParams(next, nextConstraints)
      router.replace(`?${next.toString()}`)
    } catch {
      // fetch() throws on a network failure. Same rule as above: silence would
      // read as "nothing matched".
      setSearchError('Could not reach the search service. Check your connection and try again.')
    } finally {
      setBusy(false)
    }
  }

  function clear() {
    setQ('')
    setDegraded(false)
    setSearchError(null)
    setNameLookup(null)
    setConstraints({})
    setEffective(null)
    setConstrainedQuery('')
    setFacetKeys(new Set())
    const next = new URLSearchParams(params)
    next.delete('q_semantic')
    next.delete('ids')
    for (const k of FACET_PARAM_NAMES) next.delete(k)
    router.replace(`?${next.toString()}`)
  }

  /**
   * The sentence deleted out of the box, without Clear being clicked.
   *
   * Retiring the search on the URL is only half of it. `effective` is the
   * server's parse of the sentence, and SearchCriteria seeds every Narrow-by
   * menu's ticked state and count badge from `constraints[key] ?? effective[key]`
   * — so a dead sentence left the Asset menu lit "1" with Construction
   * equipment already ticked, and the click that looks like "narrow to
   * construction equipment" was computed as a toggle
   * against that stale list: it unticked, wrote nothing, and the list did not
   * move. That is the last path of "Narrow by does not update the
   * results", surviving an earlier fix to the branch below
   * because that fix only ever ran once a menu had already been mis-seeded.
   *
   * Facet picks are deliberately NOT cleared. They are standing filters that
   * survive a new sentence (see facetKeys), and the URL already carries them —
   * dropping them here would make the menus disagree with the list.
   */
  function onQueryChange(value: string) {
    setQ(value)
    if (value.trim() || !hasActiveSearch) return
    setDegraded(false)
    setSearchError(null)
    setNameLookup(null)
    setEffective(null)
    setConstrainedQuery('')
    const next = new URLSearchParams(params)
    next.delete('q_semantic')
    next.delete('ids')
    router.replace(`?${next.toString()}`)
  }

  /**
   * A chip removed or a facet ticked. With a query up, re-run the search so the
   * server re-derives the criteria and re-ranks. With no query, the list is a
   * plain server-rendered browse, so the asset facet rides the URL instead.
   *
   * Note the deliberate asymmetry: the URL's `asset_classes` is a hard
   * `overlaps` filter in the browse query, which drops lenders whose asset field
   * is blank. That is acceptable for an explicit browse, but it must NEVER be
   * layered on top of a ranked result set — search already applied the
   * blank-is-unknown-so-keep rule, and re-filtering here would quietly delete
   * lenders it had deliberately kept.
   */
  function applyConstraints(nextConstraints: SearchConstraints, source: 'chip' | 'facet' = 'chip') {
    setConstraints(nextConstraints)
    if (source === 'facet') {
      setFacetKeys((prev) => {
        const next = new Set(prev)
        for (const k of FACET_SETTABLE_KEYS) {
          if (!sameValue(nextConstraints[k], constraints[k])) next.add(k)
        }
        return next
      })
    }
    if (q.trim()) {
      void runSearch(null, { constraints: nextConstraints })
      return
    }
    // Browse mode: every facet dimension rides the URL, and the server applies
    // them through the SAME structured matcher the search path uses. Previously
    // only asset_classes was written and it went through a separate `overlaps`
    // SQL filter, so four of the five menus silently did nothing and the one
    // that worked used different rules than search did.
    const next = new URLSearchParams(params)
    // Drop the previous ranked result set first.
    //
    // This branch is reached when the search box is EMPTY, which includes the
    // case where the operator select-all-deleted the sentence instead of
    // clicking Clear. The URL still carried `q_semantic` and `ids` from the last
    // search, and listFundingSources short-circuits on `semanticIds` and returns
    // before it ever reaches the facet block — so the menu badge lit up and the
    // list did not move. That is "Narrow by does not update the results"
    // surviving the fix that was supposed to close it.
    //
    // An empty box means the operator is browsing, so the stale shortlist is not
    // theirs any more. Removing both keys is what makes the facet a real filter
    // over the whole roster rather than a subtractive filter over 25 rows.
    next.delete('q_semantic')
    next.delete('ids')
    writeFacetParams(next, nextConstraints)
    router.replace(`?${next.toString()}`)
  }

  const hasActiveSearch = !!(params.get('q_semantic') || params.get('ids'))

  return (
    <div className="sticky top-16 z-10 border-b border-border/70 bg-background/85 backdrop-blur-[8px]">
      <div className="mx-auto max-w-6xl px-6 pb-3 pt-5">
        <div className="flex items-start gap-4">
          <div className="flex-1">
            <div className="mb-2.5 inline-flex rounded-lg border border-border/70 bg-card/50 p-0.5 text-[12px]">
              {(['search', 'add'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMode(m)}
                  aria-pressed={mode === m}
                  className={
                    'rounded-md px-3.5 py-1 capitalize transition-colors ' +
                    (mode === m
                      ? 'bg-foreground text-background'
                      : 'text-muted-foreground hover:text-foreground')
                  }
                >
                  {m}
                </button>
              ))}
            </div>
            {mode === 'search' ? (
              <>
                <form onSubmit={runSearch} className="flex items-center gap-2">
                  <Input
                    autoFocus
                    placeholder={DEMO_QUERY}
                    value={q}
                    // The route's schema caps `q` at 500. Capping the input too
                    // means the rejected-search path below is a backstop rather
                    // than something an operator can reach by typing.
                    maxLength={500}
                    onChange={(e) => onQueryChange(e.target.value)}
                    className="h-11 rounded-md border-border/70 bg-card/70 px-4 text-[15px] placeholder:text-muted-foreground/70 shadow-[inset_0_1px_0_rgba(0,0,0,0.02)] focus-visible:bg-card focus-visible:ring-accent/40"
                  />
                  <Button type="submit" disabled={busy || !q.trim()} className="h-11 px-5">
                    {busy ? 'Searching…' : 'Search'}
                  </Button>
                  {hasActiveSearch && (
                    <Button type="button" variant="ghost" className="h-11" onClick={clear}>
                      Clear
                    </Button>
                  )}
                </form>
                <SearchCriteria
                  effective={effective}
                  constraints={constraints}
                  onChange={applyConstraints}
                  disabled={busy}
                />
                <TagFilter tags={tags} />
              </>
            ) : (
              <div
                onDragOver={(e) => {
                  e.preventDefault()
                  e.dataTransfer.dropEffect = 'copy'
                }}
                onDrop={(e) => {
                  const f = e.dataTransfer.files?.[0]
                  if (f) {
                    e.preventDefault()
                    openAddWithFile(f)
                  }
                }}
              >
                <div className="flex items-center gap-2">
                  <Input
                    autoFocus
                    placeholder="Paste lender details, or drop a business card or PDF"
                    value={addText}
                    onChange={(e) => setAddText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        openAddWithText()
                      }
                    }}
                    className="h-11 rounded-md border-border/70 bg-card/70 px-4 text-[15px] placeholder:text-muted-foreground/70 focus-visible:bg-card focus-visible:ring-accent/40"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    className="h-11"
                    onClick={() => addFileRef.current?.click()}
                  >
                    Upload
                  </Button>
                  <Button
                    type="button"
                    className="h-11 px-5"
                    disabled={!addText.trim()}
                    onClick={openAddWithText}
                  >
                    Add
                  </Button>
                  <input
                    ref={addFileRef}
                    type="file"
                    accept="image/*,application/pdf,.pdf,.heic,.xlsx,.xls,.csv"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0]
                      if (f) openAddWithFile(f)
                      e.target.value = ''
                    }}
                  />
                </div>
                <p className="mt-2 text-[11px] text-muted-foreground">
                  An existing lender updates in place instead of duplicating.
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
      {searchError && !busy && (
        <div
          role="alert"
          className="border-t border-rose-500/40 bg-rose-500/10 px-6 py-2 text-xs font-medium text-rose-700 dark:text-rose-400"
        >
          {searchError} — the list below is from your previous search, not this one.
        </div>
      )}

      {nameLookup && !busy && (
        <div
          role="status"
          className="border-t border-border/70 bg-foreground/[0.03] px-6 py-2 text-xs text-muted-foreground"
        >
          Lenders whose name matches “{nameLookup}”. Describe a deal to get a ranked
          shortlist instead.
        </div>
      )}

      {degraded && !busy && (
        <div
          role="status"
          className="border-t border-amber-500/40 bg-amber-500/10 px-6 py-2 text-xs font-medium text-amber-700 dark:text-amber-400"
        >
          AI ranking temporarily unavailable. Showing exact structured matches on geography, asset and deal size. Some semantically-relevant lenders may be missing until it is restored.
        </div>
      )}
      {busy && (
        <div className="border-t border-border/40 px-6 py-1.5 text-xs text-muted-foreground animate-pulse">
          Searching lenders…
        </div>
      )}

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="max-h-[92vh] w-full overflow-y-auto p-0 sm:max-w-3xl sm:p-0">
          <DialogHeader className="px-6 pt-6">
            <DialogTitle>Add funding source</DialogTitle>
          </DialogHeader>
          {addOpen && (
            <QuickAddForm
              isAdmin={isAdmin}
              initialPaste={seedText || undefined}
              initialFile={seedFile}
              onCancel={() => setAddOpen(false)}
              onCreated={(id) => {
                setAddOpen(false)
                setAddText('')
                router.push(`/source/${id}`)
                router.refresh()
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
