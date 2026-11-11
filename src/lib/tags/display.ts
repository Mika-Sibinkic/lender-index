/**
 * Which tags belong on a results row.
 *
 * `domestic` and `international` duplicate the structured `intl_domestic` field
 * — and they disagree with it. In a real roster, lenders can carry a `domestic`
 * tag while the field says `International` or `Both`, or carry both tags at once. They came out of
 * the spreadsheet cell-colour import, so they are a snapshot of an older
 * labelling habit, not maintained truth.
 *
 * The effect on screen is corrosive: search a Brazil deal and correctly-matched
 * lenders come back visibly pilled `domestic`. Matching is right — the hard
 * exclude reads the field, never the tag — but the shortlist *reads* wrong, and
 * a shortlist a broker doesn't trust is worth about as much as one that is
 * wrong. The row already states the geography verdict properly, from the
 * authoritative field, as a Geo fit chip.
 *
 * So these two are hidden on list rows only. They stay everywhere else — the tag
 * filter, the detail page — so nothing is lost, the team can still filter by
 * them, and the underlying data can be reconciled without a
 * migration made under time pressure. Every other tag (`preferred`, `bank`,
 * `non-bank`, `stale`, `bad-contact`, …) carries information no field carries
 * and is left alone.
 */

const GEO_TAGS = new Set(['domestic', 'international'])

export function isGeoDuplicateTag(name: string): boolean {
  return GEO_TAGS.has(name.trim().toLowerCase())
}

export function tagsForListRow<T extends { name: string }>(tags: T[] | undefined): T[] {
  return (tags ?? []).filter((t) => !isGeoDuplicateTag(t.name))
}
