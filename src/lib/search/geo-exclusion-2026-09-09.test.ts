/**
 * A geography cell can say where the lender does NOT lend.
 *
 * `geographic_scope` is free text, and rows can carry an exclusion clause
 * inside it:
 *
 *     "All domestic excluding LA"
 *     "East coast - except GA"
 *     "Except Cuba and Iran"
 *
 * The matcher read only the inclusive half. "All domestic" fired
 * NATIONWIDE_TOKENS and returned 'match' for a Louisiana pick before anything
 * reached the word "excluding" — a lender on the shortlist for the one state its
 * own record rules out, which is the wrong-lender failure the accuracy mandate
 * exists to prevent.
 *
 * The opposite error costs just as much, so the clause only counts when the words
 * after the connector resolve to a PLACE. "Prefer Mid West but not mandatory"
 * carries "but not" and names no place — it is a softener about preference and it
 * must exclude nothing.
 */

import { describe, it, expect } from 'vitest'
import { scoreFit, rankByFit, hasContradiction, type DealCriteria } from './structured-filter'

const NO: DealCriteria = {
  asset_classes: [],
  geographic_scope: [],
  deal_size_min_usd: null,
  deal_size_max_usd: null,
  intl_required: false,
}

describe('an exclusion clause is read as "we do not lend there"', () => {
  // "All domestic" is a NATIONWIDE_TOKENS phrase, which
  // is why this row answered every state in the union including the one it names.
  const ALL_DOMESTIC_EXCEPT_LA = { geographic_scope: ['All domestic excluding LA'] }

  it('"All domestic excluding LA" no longer answers a Louisiana search', () => {
    const byState = scoreFit(ALL_DOMESTIC_EXCEPT_LA, { ...NO, us_states: ['Louisiana'] })
    expect(byState.state).toBe('contradict')
    expect(hasContradiction(byState)).toBe(true)

    const byGeo = scoreFit(ALL_DOMESTIC_EXCEPT_LA, { ...NO, geographic_scope: ['Louisiana'] })
    expect(byGeo.geo).toBe('contradict')
    expect(hasContradiction(byGeo)).toBe(true)
  })

  it('...and still lends in the other 49 — the inclusive half is untouched', () => {
    // Over-exclusion is the worse direction. Reading the clause must not cost
    // this lender the nationwide coverage it actually states.
    expect(scoreFit(ALL_DOMESTIC_EXCEPT_LA, { ...NO, us_states: ['Texas'] }).state).toBe('match')
    expect(scoreFit(ALL_DOMESTIC_EXCEPT_LA, { ...NO, geographic_scope: ['Texas'] }).geo).toBe('match')
    expect(hasContradiction(scoreFit(ALL_DOMESTIC_EXCEPT_LA, { ...NO, us_states: ['Ohio'] }))).toBe(false)
  })

  it('reads the clause from specific_geographic too, not just geographic_scope', () => {
    // Both cells are geography (lenderGeoCells), so an exclusion typed into the
    // detail box on the record card has to bind exactly as hard.
    const detailOnly = { geographic_scope: [], specific_geographic: 'All domestic excluding LA' }
    expect(scoreFit(detailOnly, { ...NO, us_states: ['Louisiana'] }).state).toBe('contradict')
    expect(scoreFit(detailOnly, { ...NO, us_states: ['Texas'] }).state).toBe('match')
  })

  it('"East coast - except GA" no longer answers a Georgia search', () => {
    // A different connector on the same shape. Worse than the LA row: "GA" is an
    // uppercase state code, so usStatesNamedBy read the EXCLUDED state as the
    // lender's state list and returned "lends in the selected state".
    const seaboard = { geographic_scope: ['East coast - except GA'] }
    expect(scoreFit(seaboard, { ...NO, us_states: ['Georgia'] }).state).toBe('contradict')
    expect(scoreFit(seaboard, { ...NO, geographic_scope: ['Georgia'] }).geo).toBe('contradict')
  })

  it('"Except Cuba and Iran" no longer answers a Cuba deal', () => {
    // Whole-cell exclusion, no inclusive half. The country name sat in the cell,
    // so coversForeignGeo matched it and the record that names Cuba as a place
    // it will not go led a Cuba search.
    const exceptCn = { geographic_scope: ['Except Cuba and Iran'] }
    expect(scoreFit(exceptCn, { ...NO, geographic_scope: ['Cuba'], intl_required: true }).geo)
      .toBe('contradict')
    expect(scoreFit(exceptCn, { ...NO, geographic_scope: ['Iran'], intl_required: true }).geo)
      .toBe('contradict')
  })

  it('drops the excluded lender from the shortlist, not merely down it', () => {
    // rankByFit filters on hasContradiction — staff must never see the
    // row at all, at any rank, for the place the record rules out.
    const rows = [
      { id: 'a', company_name: 'Excludes Louisiana', geographic_scope: ['All domestic excluding LA'] },
      { id: 'b', company_name: 'Alderamin Bank', geographic_scope: ['All Domestic including AK and HI'] },
    ]
    const kept = rankByFit(rows, { ...NO, us_states: ['Louisiana'] }, new Map())
    expect(kept.map((r) => r.id)).toEqual(['b'])
  })
})

describe('a clause that names no place excludes nothing', () => {
  it('"Prefer Mid West but not mandatory" is a preference, not an exclusion', () => {
    // The cell shape that makes a naive "split on but not" parser dangerous:
    // "mandatory" is not a place. Pinned at 'match' in structured-filter.test.ts
    // for a different reason (uppercase-only state codes) and held here too.
    const midwest = { geographic_scope: ['US', 'Prefer Mid West but not mandatory'] }
    expect(scoreFit(midwest, { ...NO, geographic_scope: ['Texas'] }).geo).toBe('match')
    expect(scoreFit(midwest, { ...NO, us_states: ['Texas'] }).state).toBe('match')
    expect(scoreFit(midwest, { ...NO, us_states: ['Louisiana'] }).state).toBe('match')
    expect(hasContradiction(scoreFit(midwest, { ...NO, geographic_scope: ['Ohio'] }))).toBe(false)
  })

  it('ignores an exclusion whose object is a condition rather than a place', () => {
    // "except where prohibited" names no geography. Falling back to today's
    // reading keeps a nationwide lender nationwide.
    const boilerplate = { geographic_scope: ['Nationwide except where prohibited'] }
    expect(scoreFit(boilerplate, { ...NO, us_states: ['Texas'] }).state).toBe('match')
    expect(scoreFit(boilerplate, { ...NO, geographic_scope: ['Texas'] }).geo).toBe('match')
  })

  it('does not fire on a word that merely starts with the connector', () => {
    // "Exceptional" and "Excluded-asset" are not exclusion clauses; whole-word
    // matching keeps them out.
    const odd = { geographic_scope: ['US', 'Exceptional credits only'] }
    expect(scoreFit(odd, { ...NO, us_states: ['Louisiana'] }).state).toBe('match')
  })

  it('a deal naming two places survives when only one of them is excluded', () => {
    // geoServes is an ANY test and the State facet is an OR, so a lender that
    // excludes Louisiana is still a real candidate for the Texas half of the same
    // search. Excluding it there would be the same wrong-lender error pointed the
    // other way.
    const lender = { geographic_scope: ['All domestic excluding LA'] }
    expect(scoreFit(lender, { ...NO, geographic_scope: ['Louisiana', 'Texas'] }).geo).toBe('match')
    expect(scoreFit(lender, { ...NO, us_states: ['Louisiana', 'Texas'] }).state).toBe('match')
  })

  it('leaves the unknown-geography floor exactly where it was', () => {
    // statesNoGeographicRestriction and the blank branch were added the same day
    // to fix a WRONG exclusion. Nothing here may claw that back.
    expect(scoreFit({ geographic_scope: [] }, { ...NO, us_states: ['Louisiana'] }).state).toBe('unknown')
    expect(scoreFit({ geographic_scope: [], specific_geographic: 'All' }, { ...NO, us_states: ['Louisiana'] }).state)
      .toBe('unknown')
    expect(scoreFit({ geographic_scope: [], specific_geographic: 'All' }, { ...NO, geographic_scope: ['Brazil'] }).geo)
      .toBe('unknown')
  })
})

describe('the other connectors the column uses', () => {
  it('reads the abbreviated and the wordier forms the same way', () => {
    // Same nationwide-plus-carve-out shape, four ways of writing it. All four
    // must exclude Louisiana and none of them may cost the lender Texas.
    for (const cell of [
      'All domestic exc. LA',
      'All domestic other than LA',
      'All states minus LA',
      'All Domestic but not Louisiana',
    ]) {
      const lender = { geographic_scope: [cell] }
      expect(scoreFit(lender, { ...NO, us_states: ['Louisiana'] }).state, cell).toBe('contradict')
      expect(scoreFit(lender, { ...NO, us_states: ['Texas'] }).state, cell).toBe('match')
    }
  })

  it('carves a country out of a worldwide lender without unplugging the rest', () => {
    const lender = { geographic_scope: ['Worldwide outside of Russia'] }
    expect(scoreFit(lender, { ...NO, geographic_scope: ['Russia'], intl_required: true }).geo)
      .toBe('contradict')
    expect(scoreFit(lender, { ...NO, geographic_scope: ['Brazil'], intl_required: true }).geo)
      .toBe('match')
  })
})

/**
 * The whole row, not just the clause.
 *
 * The fix above is written against the exclusion cell in isolation. Rows
 * do not store it in isolation. Exclusion rows typically repeat the clause in
 * `specific_geographic` beside a bare coverage phrase in `geographic_scope`:
 *
 *     ["US", "All domestic excluding LA"]               + "All domestic excluding LA"
 *     ["US Specific", "East coast - except GA"]         + "East coast - except GA"
 *     ["US and International", "Except Cuba and Iran"]
 *
 * Pinned because the clause has to bind the WHOLE record — the coverage phrase
 * sitting in the cell beside it, and the one repeated in the detail box, must not
 * buy back the state the record rules out.
 */
describe('the whole row, not the clause in isolation', () => {
  const EXCLUDES_LA = {
    company_name: 'Example Bank',
    geographic_scope: ['US', 'All domestic excluding LA'],
    specific_geographic: 'All domestic excluding LA',
    intl_domestic: 'Domestic',
    lending_status: 'Yes',
  }

  it('does not answer a Louisiana pick', () => {
    const v = scoreFit(EXCLUDES_LA, { ...NO, us_states: ['Louisiana'] })
    expect(v.state).toBe('contradict')
    expect(hasContradiction(v)).toBe(true)
  })

  it('does not answer a Louisiana deal geography either', () => {
    const v = scoreFit(EXCLUDES_LA, { ...NO, geographic_scope: ['Louisiana'] })
    expect(v.geo).toBe('contradict')
    expect(hasContradiction(v)).toBe(true)
  })

  it('is off the shortlist entirely, at every rank', () => {
    const rows = [
      { id: 'excl', ...EXCLUDES_LA },
      { id: 'nat', company_name: 'Alderamin Bank', geographic_scope: ['All Domestic including AK and HI'] },
    ]
    expect(rankByFit(rows, { ...NO, us_states: ['Louisiana'] }, new Map()).map((r) => r.id))
      .toEqual(['nat'])
  })

  it('keeps the other 49 — Texas is untouched', () => {
    expect(scoreFit(EXCLUDES_LA, { ...NO, us_states: ['Texas'] }).state).toBe('match')
    expect(scoreFit(EXCLUDES_LA, { ...NO, geographic_scope: ['Texas'] }).geo).toBe('match')
    expect(hasContradiction(scoreFit(EXCLUDES_LA, { ...NO, us_states: ['Texas'] }))).toBe(false)
  })
})

/**
 * The state asked for as a POSTAL CODE — the shape the clause did not cover.
 *
 * Both sides of an exclusion are resolved to a place before they are compared,
 * and until now the two sides used DIFFERENT vocabularies. `usStatesNamedBy`
 * reads the lender's half and resolves an uppercase code, which is how "LA" in
 * "All domestic excluding LA" is known to mean Louisiana. The DEAL's half was
 * resolved by `isUsDeal` alone, which knows the fifty names and no codes — so a
 * state asked for as "LA" resolved to no place at all, the clause was skipped as
 * though it named nothing, and `stateDim` fell through to the nationwide
 * shortcut, which fired on the "All domestic" half of the very same cell and
 * returned 'match': a lender on a Louisiana list, one clause after its own record
 * says Louisiana is the one state it will not touch.
 *
 * Reachable: the browse path takes `?states=` straight out of the URL through
 * `readFacetParams` and hands it to `stateDim` unaltered. Unlike the search
 * path's `resolveConstraints`, nothing there narrows the value to the canonical
 * fifty first, and the list URL is the app's own carrier of search state.
 *
 * The two dimensions also disagreed about the same word: `geoDim` contradicted
 * "LA" while `stateDim` matched it. One vocabulary for both halves, so they
 * cannot disagree about which place a word means.
 */
describe('an exclusion binds whichever way the state is spelled', () => {
  const EXCLUDES_LA = {
    company_name: 'Example Bank',
    geographic_scope: ['US', 'All domestic excluding LA'],
    specific_geographic: 'All domestic excluding LA',
  }

  it('"LA" is Louisiana on the deal side too — the nationwide half cannot buy it back', () => {
    const v = scoreFit(EXCLUDES_LA, { ...NO, us_states: ['LA'] })
    expect(v.state).toBe('contradict')
    expect(hasContradiction(v)).toBe(true)
  })

  it('and it is off the shortlist, not merely below it', () => {
    const rows = [
      { id: 'excl', ...EXCLUDES_LA },
      { id: 'nat', company_name: 'Alderamin Bank', geographic_scope: ['All Domestic including AK and HI'] },
    ]
    expect(rankByFit(rows, { ...NO, us_states: ['LA'] }, new Map()).map((r) => r.id))
      .toEqual(['nat'])
  })

  it('a code for a state the record does NOT exclude still matches', () => {
    // Over-exclusion is the more expensive mistake in the other direction.
    // Reading "LA" as Louisiana must not cost the lender the other forty-nine.
    expect(scoreFit(EXCLUDES_LA, { ...NO, us_states: ['TX'] }).state).toBe('match')
    expect(hasContradiction(scoreFit(EXCLUDES_LA, { ...NO, us_states: ['TX'] }))).toBe(false)
  })

  it('geoDim excludes on the CLAUSE, not because it failed to read the word', () => {
    // geoDim already returned 'contradict' for "LA" — but only because a code it
    // could not resolve fell through to "stated location does not cover the
    // deal". Same verdict, wrong reason, and the reason is what the operator is
    // shown. The clause is the answer here.
    const v = scoreFit(EXCLUDES_LA, { ...NO, geographic_scope: ['LA'] })
    expect(v.geo).toBe('contradict')
    expect(v.reasons).toContain('geography excluded — the record states it does not lend there')
  })

  it('an "except GA" row binds a "GA" pick the same way', () => {
    const eastCoast = {
      geographic_scope: ['US Specific', 'East coast - except GA'],
      specific_geographic: 'East coast - except GA',
    }
    expect(scoreFit(eastCoast, { ...NO, us_states: ['GA'] }).state).toBe('contradict')
  })

  it('a code is never read as a place the record merely NAMES', () => {
    // localToRequest ranks the shortlist. A lender that rules the state out must
    // not be promoted as local to it on the strength of the excluded token.
    expect(scoreFit(EXCLUDES_LA, { ...NO, us_states: ['LA'] }).localToRequest).toBe(false)
  })
})
