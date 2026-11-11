import { describe, it, expect, afterEach } from 'vitest'
import { browserNavigation, cameFromList, type NavigationLike } from './return-to-list'

const ORIGIN = 'https://lenders.example.com'

/** A history stack, current entry last unless `index` says otherwise. */
function nav(urls: (string | null)[], index = urls.length - 1): NavigationLike {
  return {
    currentEntry: { index },
    entries: () => urls.map((url) => ({ url })),
  }
}

describe('cameFromList', () => {
  it('goes back to the search the operator left', () => {
    // The reported symptom: pressing the back button 'All sources' boots you out
    // of your search and erases the bar instead of returning to the
    // already-rendered results page.
    // `ids` IS the shortlist; a push to `/` throws it away.
    const listUrl = `${ORIGIN}/?q_semantic=a+Caterpillar+in+Texas&ids=aaa,bbb,ccc`
    expect(cameFromList(nav([listUrl, `${ORIGIN}/source/aaa`]), ORIGIN)).toBe(true)
  })

  it('goes back for a facet-only browse, which carries no search sentence', () => {
    // A common operator workflow — Narrow by → State, empty search box. The state
    // lives in the facet params, so it is lost by exactly the same push.
    const listUrl = `${ORIGIN}/?us_states=TX&lender_type_required=bank`
    expect(cameFromList(nav([listUrl, `${ORIGIN}/source/aaa`]), ORIGIN)).toBe(true)
  })

  it('goes back to an unfiltered list too — back is never worse than /', () => {
    expect(cameFromList(nav([`${ORIGIN}/`, `${ORIGIN}/source/aaa`]), ORIGIN)).toBe(true)
  })

  it('tolerates a full-roster id list (300 uuids, ~11 KB of query string)', () => {
    const ids = Array.from({ length: 300 }, (_, i) =>
      `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`
    ).join(',')
    const listUrl = `${ORIGIN}/?q_semantic=equipment+financing&ids=${ids}`
    expect(listUrl.length).toBeGreaterThan(9000)
    expect(cameFromList(nav([listUrl, `${ORIGIN}/source/aaa`]), ORIGIN)).toBe(true)
  })

  it('does NOT go back when the record was opened cold', () => {
    // A link in an operator's email, a bookmark, a refresh: index 0 means there is no
    // same-origin entry behind this one. Going "back" here leaves the app.
    expect(cameFromList(nav([`${ORIGIN}/source/aaa`]), ORIGIN)).toBe(false)
  })

  it('does NOT go back when the previous entry is another record', () => {
    const stack = [`${ORIGIN}/source/aaa`, `${ORIGIN}/source/bbb`]
    expect(cameFromList(nav(stack), ORIGIN)).toBe(false)
  })

  it('does NOT go back when the previous entry is another page of the app', () => {
    expect(cameFromList(nav([`${ORIGIN}/activity`, `${ORIGIN}/source/aaa`]), ORIGIN)).toBe(false)
  })

  it('does NOT go back to another origin', () => {
    // entries() is specified same-origin-only; this is the belt to that braces,
    // because the failure mode is throwing the operator out of the app.
    expect(cameFromList(nav([`https://outlook.office.com/mail`, `${ORIGIN}/source/aaa`]), ORIGIN)).toBe(false)
  })

  it('does NOT go back when the previous URL is hidden or unparseable', () => {
    expect(cameFromList(nav([null, `${ORIGIN}/source/aaa`]), ORIGIN)).toBe(false)
    expect(cameFromList(nav(['not a url', `${ORIGIN}/source/aaa`]), ORIGIN)).toBe(false)
  })

  it('does NOT go back when the browser has no Navigation API', () => {
    expect(cameFromList(null, ORIGIN)).toBe(false)
    expect(cameFromList(undefined, ORIGIN)).toBe(false)
    expect(cameFromList({ entries: () => [] }, ORIGIN)).toBe(false)
  })

  it('does NOT go back when reading history throws', () => {
    const hostile: NavigationLike = {
      currentEntry: { index: 1 },
      entries: () => {
        throw new Error('nope')
      },
    }
    expect(cameFromList(hostile, ORIGIN)).toBe(false)
  })
})

describe('browserNavigation', () => {
  afterEach(() => {
    delete (window as unknown as { navigation?: unknown }).navigation
  })

  it('returns null when the API is missing, so the plain link stands', () => {
    expect(browserNavigation()).toBeNull()
  })

  it('returns the object when the API is present', () => {
    const fake = nav([`${ORIGIN}/`])
    ;(window as unknown as { navigation?: unknown }).navigation = fake
    expect(browserNavigation()).toBe(fake)
  })
})
