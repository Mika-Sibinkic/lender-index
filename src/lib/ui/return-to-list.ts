/**
 * Does "← All sources" have a shortlist to go back to?
 *
 * The result set an operator is working lives entirely in the list URL —
 * `q_semantic`, the ranked `ids`, the Narrow-by facet params, `tags`. The back
 * link on a lender record was a hardcoded `/`, so clicking it pushed a new,
 * parameterless entry and the server re-rendered the whole roster: shortlist
 * gone, search box blank, and the fit chips gone with them (search-fit only
 * paints a stash whose `idsKey` matches the live `?ids=`). The browser's own Back button always restored it correctly, which
 * is what places the fault in the link rather than in the list.
 *
 * So when the entry we came from IS the list, traverse back to it rather than
 * pushing a fresh one. Back carries the whole query string — up to ~10 KB of
 * `ids` at full roster scale — without that string having to ride a link href,
 * and it restores the scroll position into a long shortlist for free.
 *
 * Read through the Navigation API, which is the only way a client component can
 * see the URL of the entry behind it: `document.referrer` is not updated by the
 * App Router's soft navigations, and `history.length` counts other origins, so
 * it would send an operator who opened a shared link straight out of the app.
 * Where the API is absent the answer is `false` and the plain `/` link stands —
 * today's behaviour, never a worse one.
 */

/** The slice of the Navigation API we read. Not in TypeScript's DOM lib (5.9). */
export interface NavigationLike {
  readonly currentEntry?: { readonly index: number } | null
  entries(): readonly { readonly url?: string | null }[]
}

export function browserNavigation(): NavigationLike | null {
  if (typeof window === 'undefined') return null
  const nav = (window as unknown as { navigation?: NavigationLike }).navigation
  return nav && typeof nav.entries === 'function' ? nav : null
}

/**
 * True when the history entry immediately behind this one is the funding-source
 * list. `entries()` holds only same-origin entries, so index 0 means the record
 * was opened cold — a shared link, a bookmark, a new tab — and there is nothing
 * of ours behind it.
 */
export function cameFromList(
  nav: NavigationLike | null | undefined,
  origin: string
): boolean {
  try {
    const index = nav?.currentEntry?.index
    if (typeof index !== 'number' || index < 1) return false
    const previous = nav?.entries()[index - 1]?.url
    if (!previous) return false
    const url = new URL(previous)
    return url.origin === origin && url.pathname === '/'
  } catch {
    return false
  }
}
