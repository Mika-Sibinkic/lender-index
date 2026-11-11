/**
 * Narrow by must update the results.
 *
 * The last reachable path, and the one that survived an earlier fix.
 *
 * That fix taught `applyConstraints` to delete `q_semantic` and `ids` before it
 * writes the facet params, so a facet ticked with an empty box is a real browse.
 * It left the other half untouched: emptying the box does not tell the rest of
 * the bar that the search is over. `effective` — the server's parse of the dead
 * sentence — is still set, and `SearchCriteria` reads every menu's ticked state
 * and count badge from `constraints[key] ?? effective[key]`. So after
 * select-all-delete the operator sees Asset lit "1" and Construction equipment
 * already ticked for a sentence that is no longer in the box and no longer
 * filtering the list, and the click that looks like "narrow to construction
 * equipment" is computed as a toggle against
 * that stale list — it UNticks, writes nothing, and the list does not move.
 *
 * The sentence is a typical operator query ("2005 Caterpillar 320 excavator"), run
 * through the production extractor rather than a hand-built object, so the
 * criteria the menus are seeded from are the ones production would produce.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { extractDeal } from '@/lib/search/extract-deal'
import { mergeConstraints } from '@/lib/search/constraints'
import { buildFundingSourceQuery } from '@/lib/queries/funding-sources'
import { hasAnyFacet } from '@/lib/search/facet-params'
import { DEMO_QUERY } from '@/lib/config/domain'

const SENTENCE = '2005 Caterpillar 320 excavator around $8M for a borrower in Texas'

/**
 * The live query string, shared with the `next/navigation` mock. `router.replace`
 * writes it, `useSearchParams` reads it — the same round trip the App Router
 * makes, so a test step can assert on what the server would have been asked for.
 */
const url = vi.hoisted(() => ({ search: '', replaced: [] as string[] }))

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    replace: (href: string) => {
      url.replaced.push(href)
      url.search = href.replace(/^\?/, '')
    },
    push: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
  }),
  useSearchParams: () => new URLSearchParams(url.search),
}))

// Intake is a different control on the same bar; it drags in the whole document
// parse stack and none of this exercises it.
vi.mock('@/components/funding-sources/quick-add-form', () => ({
  QuickAddForm: () => null,
}))

import { FilterBar } from '@/components/funding-sources/filter-bar'

/** What /api/search returns for SENTENCE, derived by the production code. */
function searchResponse() {
  const effective = mergeConstraints(extractDeal(SENTENCE), undefined, {
    queryHasIntlKeyword: false,
  })
  return {
    results: [{ id: 'aaaaaaaa-0000-4000-8000-000000000001', fit: null }],
    effective,
    extraction: { deal_size_min_usd: 8_000_000, deal_size_max_usd: 8_000_000 },
    flags: {},
  }
}

const box = () => screen.getByPlaceholderText(DEMO_QUERY)
// Not the "Asset age" menu, which shares the prefix.
const assetMenu = () => screen.getByRole('button', { name: /^Asset(?! age)/ })
const lastUrl = () => new URLSearchParams(url.replaced.at(-1)?.replace(/^\?/, '') ?? '')

/** Run SENTENCE through the bar and leave the results on screen. */
async function runTheSearch() {
  render(<FilterBar tags={[]} />)
  fireEvent.change(box(), { target: { value: SENTENCE } })
  fireEvent.click(screen.getByRole('button', { name: 'Search' }))
  await waitFor(() => expect(url.replaced.length).toBeGreaterThan(0))
}

beforeEach(() => {
  cleanup()
  url.search = ''
  url.replaced = []
  window.sessionStorage.clear()
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(searchResponse()), { status: 200 })),
  )
})

describe('the search box emptied without clicking Clear', () => {
  it('pins the ranked ids in the URL while the search is up', async () => {
    await runTheSearch()
    expect(lastUrl().get('q_semantic')).toBe(SENTENCE)
    expect(lastUrl().get('ids')).toBe('aaaaaaaa-0000-4000-8000-000000000001')
  })

  it('reads the asset year and the state out of the operator’s sentence', () => {
    // The menus below are seeded from these, which is what makes the staleness
    // visible rather than theoretical.
    const ex = extractDeal(SENTENCE)
    expect(ex.asset_year).toBe(2005)
    expect(ex.asset_classes).toContain('construction_equipment')
  })

  it('lights the Asset badge from the sentence the search actually ran', async () => {
    await runTheSearch()
    await waitFor(() => expect(assetMenu().textContent).toMatch(/1/))
    expect(screen.getByLabelText('Search criteria')).toBeTruthy()
  })

  it('drops the ranked ids from the URL the moment the box is emptied', async () => {
    await runTheSearch()
    const before = url.replaced.length
    fireEvent.change(box(), { target: { value: '' } })
    await waitFor(() => expect(url.replaced.length).toBeGreaterThan(before))
    expect(lastUrl().get('ids')).toBeNull()
    expect(lastUrl().get('q_semantic')).toBeNull()
  })

  it('stops seeding the Narrow-by menus from the dead sentence', async () => {
    await runTheSearch()
    await waitFor(() => expect(assetMenu().textContent).toMatch(/1/))
    fireEvent.change(box(), { target: { value: '' } })
    // Asset was ticked by the sentence, not by the operator. With the sentence
    // gone, a click on "Construction equipment" has to mean "narrow to
    // construction equipment" — it cannot be a
    // toggle that unticks something the operator never ticked.
    await waitFor(() => expect(assetMenu().textContent).not.toMatch(/1/))
    expect(screen.queryByLabelText('Search criteria')).toBeNull()
  })
})

describe('the operator’s click, end to end', () => {
  it('narrows the whole roster instead of unticking the dead sentence', async () => {
    await runTheSearch()
    await waitFor(() => expect(assetMenu().textContent).toMatch(/1/))
    fireEvent.change(box(), { target: { value: '' } })
    await waitFor(() => expect(assetMenu().textContent).not.toMatch(/1/))

    fireEvent.pointerDown(assetMenu())
    fireEvent.click(assetMenu())
    await waitFor(() => expect(screen.getByRole('menuitemcheckbox', { name: 'Construction equipment' })).toBeTruthy())
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Construction equipment' }))

    // The click means "narrow to construction equipment", and it has to reach the server as that.
    await waitFor(() => expect(lastUrl().get('asset_classes')).toBe('construction_equipment'))
    expect(lastUrl().get('ids')).toBeNull()
    expect(lastUrl().get('q_semantic')).toBeNull()
    // Which is a browse the list query actually filters on, rather than a
    // pinned id list it returns before it reads a facet.
    const asked = buildFundingSourceQuery(Object.fromEntries(lastUrl()))
    expect(asked.semanticIds).toHaveLength(0)
    expect(asked.facets.asset_classes).toEqual(['construction_equipment'])
  })
})

describe('the three things the fix must not break', () => {
  it('narrow first, then search: the facet survives the new sentence', async () => {
    // Narrow first, then search. The facet is a standing filter; emptying the box must never be what drops it.
    url.search = 'asset_classes=construction_equipment'
    render(<FilterBar tags={[]} />)
    fireEvent.change(box(), { target: { value: SENTENCE } })
    fireEvent.click(screen.getByRole('button', { name: 'Search' }))
    await waitFor(() => expect(url.replaced.length).toBeGreaterThan(0))
    const sent = JSON.parse(
      (vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string,
    )
    expect(sent.constraints.asset_classes).toEqual(['construction_equipment'])
    expect(lastUrl().get('asset_classes')).toBe('construction_equipment')
    expect(lastUrl().get('ids')).toBeTruthy()
  })

  it('a sentence still in the box keeps both the ranked ids and the facets', async () => {
    url.search = 'states=Texas'
    render(<FilterBar tags={[]} />)
    fireEvent.change(box(), { target: { value: SENTENCE } })
    fireEvent.click(screen.getByRole('button', { name: 'Search' }))
    await waitFor(() => expect(url.replaced.length).toBeGreaterThan(0))
    // Typing more of the sentence must not retire anything — the guard is on an
    // EMPTY box, not on any edit.
    fireEvent.change(box(), { target: { value: `${SENTENCE} for a logistics company` } })
    expect(lastUrl().get('ids')).toBeTruthy()
    expect(lastUrl().get('q_semantic')).toBe(SENTENCE)
    expect(lastUrl().get('states')).toBe('Texas')
  })

  it('back to a list URL still restores the search it carries', async () => {
    // The back-navigation fix traverses to the list entry rather than
    // pushing `/`, so the bar mounts onto a URL that already holds the search.
    // Nothing here may read that as an emptied box.
    url.search = `q_semantic=${encodeURIComponent(SENTENCE)}&ids=aaaaaaaa-0000-4000-8000-000000000001`
    render(<FilterBar tags={[]} />)
    expect((box() as HTMLInputElement).value).toBe(SENTENCE)
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled())
    await waitFor(() => expect(screen.getByLabelText('Search criteria')).toBeTruthy())
    expect(lastUrl().get('ids')).toBe('aaaaaaaa-0000-4000-8000-000000000001')
  })
})

describe('what the server is asked for once the box is empty', () => {
  it('reaches the facet block instead of short-circuiting on the id list', () => {
    // listFundingSources returns the pinned ids before it ever reads the facets,
    // so the facet params only bite once `ids` is gone. This is the server half
    // of the same bug.
    const pinned = buildFundingSourceQuery({ ids: 'a,b,c', states: 'Texas' })
    expect(pinned.semanticIds).toHaveLength(3)
    expect(hasAnyFacet(pinned.facets)).toBe(true) // set, and unreachable

    const browsing = buildFundingSourceQuery({ states: 'Texas' })
    expect(browsing.semanticIds).toHaveLength(0)
    expect(browsing.facets.us_states).toEqual(['Texas'])
  })
})
