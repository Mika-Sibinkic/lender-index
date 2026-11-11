/**
 * Structured deal-fit scoring + filtering for lender search results.
 *
 * Rules (per operator directives):
 *   - A lender field that is EMPTY/blank = UNKNOWN → kept (we don't know, so
 *     we don't exclude — this is the "Brazil bug" fix: never drop blank-field
 *     lenders just because a field is empty).
 *   - A lender field that is POPULATED and CONTRADICTS the deal → EXCLUDED.
 *     "Stick to the stated locations": a lender stated US-only must NEVER show
 *     for a Brazil deal. Same hard-exclude applies to asset class and deal
 *     size (a $4M-max lender is not a real match for an $8M deal).
 *   - A lender field that MATCHES → ranked up.
 *
 * Geo matching is synonym-aware: free-text geo data ("All Domestic incl AK/HI",
 * "Worldwide", "UK", "NY") would over-exclude under naive exact match, so a
 * domestic-coverage lender matches any US-state deal, and a global-coverage
 * lender matches anything — but a US-only lender still fails an international
 * (e.g. Brazil) deal.
 */

import { parseUsageCodes } from '@/lib/funding-sources/usage-codes'
import { familyOf, isGenericParent } from '@/lib/config/domain'
import { oldestYearAllowed, parseVintageRule } from '@/lib/funding-sources/vintage'
import type { Confidence } from '@/lib/search/money'
import { FOREIGN_GEOS, FOREIGN_REGIONS, regionContains } from './countries'
import { asNoteSignals, type NoteSignalPlace } from '@/lib/notes/signals'
import { usRegionCovers } from '@/lib/notes/places'

export interface LenderRow {
  asset_classes?: string[] | null
  geographic_scope?: string[] | null
  deal_size_min_usd?: number | null
  deal_size_max_usd?: number | null
  intl_domestic?: string | null
  // Template rank-signal fields (migration 0017). These sharpen ranking but,
  // except lender_type-when-asked, NEVER exclude — absence ≠ "can't do it".
  usage_codes?: string | null
  operation_category?: string | null
  lender_type?: string | null
  // Whether the lender is open for business right now. `lending_status` is the
  // spreadsheet's "Lending Status" cell verbatim; `status` is its normalized
  // form. Demotes, never excludes — see notLending on FitVerdict.
  lending_status?: string | null
  status?: string | null
  /** Free-text asset age limit — see lib/funding-sources/vintage.ts. */
  vintage_restriction?: string | null
  /** Free-text geography detail. Read as a geo cell — see lenderGeoCells. */
  specific_geographic?: string | null
  /**
   * Typed signals read out of `internal_notes` by the local model — see
   * lib/notes/signals.ts and migration 0023.
   *
   * This is the one field on LenderRow that nobody typed, so it is held to a
   * stricter rule than the rest: it RANKS and it never EXCLUDES. Deliberately
   * absent from `hasContradiction`. Notes are accounted for in ranking; the
   * stated-vs-inferred rule is what decides how far that is allowed to go.
   */
  note_signals?: unknown
}

/**
 * Every cell that states where this lender lends.
 *
 * `specific_geographic` used to be written, displayed, exported and embedded but
 * never read by any filter, so a state or country typed into it on the record
 * card was invisible to the hard geo match. Only XLSX-imported rows escaped
 * that, because the importer happens to copy the cell into geographic_scope as
 * well.
 *
 * This was first written as "can only ever ADD coverage — it cannot make a
 * lender look narrower than it is." That was WRONG, and it cost three lenders.
 * A row with an empty `geographic_scope` and a `specific_geographic` of "All"
 * used to reach the blank → unknown → kept branch in geoDim. Reading the detail
 * cell makes the list non-empty, so the blank branch stops firing and a cell
 * naming no recognisable place falls through to `contradict`, so such rows
 * were hard-excluded from every geography-bearing search. See
 * statesNoGeographicRestriction, which restores the floor.
 */
function lenderGeoCells(lender: LenderRow): string[] {
  const cells = lender.geographic_scope ?? []
  const detail = (lender.specific_geographic ?? '').trim()
  return detail ? [...cells, detail] : cells
}

export interface DealCriteria {
  asset_classes: string[]
  geographic_scope: string[]
  deal_size_min_usd: number | null
  deal_size_max_usd: number | null
  /** Query explicitly asked for an INTERNATIONAL lender (generic, not a country). */
  intl_required: boolean
  /**
   * US states picked from the "Narrow by → State" menu. Deliberately a SEPARATE
   * dimension from geographic_scope rather than merged into it, because geoServes
   * is an ANY test: union a state into the deal geography and a Texas-only lender
   * would satisfy a Brazil deal by serving Texas. As its own AND-constraint it can
   * only ever narrow, which is what "narrow by" has to mean.
   */
  us_states?: string[]
  /** Model year of the asset being financed, when the deal states one. */
  asset_year?: number | null
  /**
   * The year to measure a lender's "N Years" age limit against. Passed in rather
   * than read from the clock so the verdict is a pure function of its inputs and
   * a test does not change meaning every January.
   */
  as_of_year?: number
  /**
   * Whether the deal size and asset year were STATED by the operator or
   * INFERRED by us from an ambiguous sentence.
   *
   * An inferred value may rank but must never exclude. Excluding on a number we
   * worked out ourselves — a currency we converted, a "mil" we chose a reading
   * for, a year we picked between two — can remove the only lender who could
   * write the deal, and nothing on screen would show that it had happened.
   * Ranking on the same number costs nothing when we are wrong.
   */
  size_confidence?: Confidence
  asset_year_confidence?: Confidence
  /**
   * Rank-signal deal params (all optional — a query need not mention them).
   * usage_codes: usage codes the deal needs (USAGE_CODES in config).
   * operation_category: an OPERATION_CATEGORIES value if the deal states one.
   * lender_type_required: set ONLY when the query explicitly asks for a lender
   *   kind ("credit union", "non-bank") — the one rank field that can hard-exclude.
   */
  usage_codes?: string[]
  operation_category?: string | null
  lender_type_required?: string | null
}

export type DimensionVerdict = 'match' | 'unknown' | 'contradict'

export interface FitVerdict {
  score: number
  asset: DimensionVerdict
  geo: DimensionVerdict
  size: DimensionVerdict
  intl: DimensionVerdict
  // Rank signals — 'match' | 'unknown' only (usage/operation never contradict);
  // lenderType may 'contradict' ONLY when the query explicitly asked for a type.
  usage: DimensionVerdict
  operation: DimensionVerdict
  lenderType: DimensionVerdict
  /** Selected US states vs the states the lender lists. Can contradict. */
  state: DimensionVerdict
  /** Asset model year vs the lender's stated asset age limit. Can contradict. */
  vintage: DimensionVerdict
  /**
   * The record explicitly states the lender is NOT currently lending. Sorts
   * below every lending candidate regardless of fit score, and never excludes:
   * a paused lender may reopen, and staff need to be able to see one
   * and decide. Blank is unknown and is left alone.
   */
  notLending: boolean
  /**
   * The lender's record NAMES the state or country that was asked for, rather
   * than covering it through a nationwide or worldwide phrase. Ranks the
   * shortlist; never excludes anyone. See namesRequestedPlace.
   */
  localToRequest: boolean
  /**
   * How many places the lender names, when it is local to the request. Lower is
   * more focused; Infinity when the lender is not local. Tiebreaks BELOW score —
   * see localFootprintSize.
   */
  localFootprint: number
  /**
   * The lender's own notes name the place that was asked for as somewhere it is
   * based or prefers. Carries the sentence, so the row can show why it moved;
   * null when there is no such signal.
   *
   * Ranks immediately BELOW localToRequest: a state written into the structured
   * geography cell is a curated fact, a state read out of prose is a machine
   * reading of one, and the curated one should lead when both exist.
   */
  notesPrefer: string | null
  /**
   * The lender's own notes say it does NOT lend in the place that was asked for
   * — "No HI or AK", "No Canada", "cannot consider india". Carries the sentence.
   *
   * Sorts the lender to the bottom and NEVER excludes it, for the same reason
   * dormant lenders are demoted rather than hidden: this is a machine reading of
   * prose, and deleting a lender on one would be invisible to the operator. The
   * sentence is on screen, so staff can promote it into the structured
   * geography cell — where it becomes a stated criterion and DOES exclude.
   */
  notesAvoid: string | null
  /**
   * The notes say lending is stopped, paused or on hold, whatever the
   * `lending_status` cell claims. The typical case: the cell reads "Yes" and
   * the notes read "they stopped renewing loans and stopped funding new loans".
   *
   * Carries the sentence and does NOTHING else. It does not demote, it does not
   * exclude, it is absent from the sort entirely. Staying on the safe side means
   * keeping the lender visible rather than hiding it from potentially valid
   * results, so staff can see it, open the card and correct the record if
   * needed. The chip is what prompts that edit; when staff agree and set
   * Lending status to No, the existing stated demote (dormant lenders are
   * demoted, not excluded) takes over — from a curated cell, as it should.
   */
  notesPaused: string | null
  reasons: string[]
}

const norm = (s: string) => s.toLowerCase().trim()

function overlaps(a: string[], b: string[]): boolean {
  const set = new Set(a.map(norm))
  return b.some((s) => set.has(norm(s)))
}

// Lender geo tokens meaning "covers everywhere" → matches any deal geo.
//
// 'international' is deliberately NOT here. A roster uses it to mean "not US"
// ("Anything that's not US"), which is a CATEGORY, not a wildcard covering
// every country. While it sat in this list, any lender whose geography
// contained the word matched every deal geography — so a Brazil search
// returned a lender whose stated geography is ["International","Canada"].
// A lender that names one foreign country must not match a different one.
//
// The specific country a lender names is the authoritative answer to "which
// international". See INTERNATIONAL_TOKENS and namesForeignPlace below.
const GLOBAL_TOKENS = ['worldwide', 'global', 'any country', 'anywhere', 'all countries']
/** Lender geo tokens meaning "we do non-US business" — a category, not a wildcard. */
const INTERNATIONAL_TOKENS = ['international']
// Lender geo tokens meaning "covers the US" → matches any US-state / US deal geo.
// Matched whole-word by hasToken, so 'us' no longer fires inside "Australia" and
// 'national' no longer fires inside "international".
const DOMESTIC_TOKENS = [
  'domestic', 'nationwide', 'national', 'all states', 'united states', 'usa', 'us',
  'u s', 'continental', 'lower 48', 'all 50',
]

const US_STATES = new Set([
  'alabama', 'alaska', 'arizona', 'arkansas', 'california', 'colorado', 'connecticut',
  'delaware', 'florida', 'georgia', 'hawaii', 'idaho', 'illinois', 'indiana', 'iowa',
  'kansas', 'kentucky', 'louisiana', 'maine', 'maryland', 'massachusetts', 'michigan',
  'minnesota', 'mississippi', 'missouri', 'montana', 'nebraska', 'nevada', 'new hampshire',
  'new jersey', 'new mexico', 'new york', 'north carolina', 'north dakota', 'ohio',
  'oklahoma', 'oregon', 'pennsylvania', 'rhode island', 'south carolina', 'south dakota',
  'tennessee', 'texas', 'utah', 'vermont', 'virginia', 'washington', 'west virginia',
  'wisconsin', 'wyoming', 'united states', 'midwest', 'northeast', 'southeast',
  'southwest', 'west coast', 'east coast',
])

/**
 * Word-boundary-safe form of a free-text geo cell. The real data is messy —
 * "Middle-East", "India and Canada", "US International" — so punctuation folds
 * to spaces and the result is space-padded, letting us test ` canada ` without
 * matching "oman" inside "romania".
 */
const geoText = (s: string) => ` ${s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `

const isUsDeal = (g: string) => US_STATES.has(norm(g))

/**
 * Whole-word token test against a free-text geo cell.
 *
 * The old version did `norm(lg).includes(t.trim())`, and the `.trim()` quietly
 * destroyed the space padding that ' us' and 'us ' depended on — leaving a bare
 * substring test for "us". Consequences:
 *   - Australia, Austria, Belarus and Cyprus all classified as US-domestic
 *   - "international" contains "national", so every international lender
 *     classified as US-domestic and matched any US-state deal
 * Between them, a state search returned many lenders unrelated to that state.
 */
const hasToken = (lenderGeos: string[], tokens: readonly string[]) =>
  lenderGeos.some((lg) => tokens.some((t) => geoText(lg).includes(` ${t.trim()} `)))

/**
 * Lender geo cells that mean "everywhere in the US", overriding any state codes
 * that appear alongside them — "All Domestic including AK and HI" names two
 * states but is nationwide.
 */
const NATIONWIDE_TOKENS = [
  'all domestic', 'anywhere domestic', 'nationwide', 'all states', 'all 50',
  'lower 48', 'continental', 'conus', 'national',
] as const

const US_STATE_CODES: Record<string, string> = {
  AL: 'alabama', AK: 'alaska', AZ: 'arizona', AR: 'arkansas', CA: 'california',
  CO: 'colorado', CT: 'connecticut', DE: 'delaware', FL: 'florida', GA: 'georgia',
  HI: 'hawaii', ID: 'idaho', IL: 'illinois', IN: 'indiana', IA: 'iowa', KS: 'kansas',
  KY: 'kentucky', LA: 'louisiana', ME: 'maine', MD: 'maryland', MA: 'massachusetts',
  MI: 'michigan', MN: 'minnesota', MS: 'mississippi', MO: 'missouri', MT: 'montana',
  NE: 'nebraska', NV: 'nevada', NH: 'new hampshire', NJ: 'new jersey', NM: 'new mexico',
  NY: 'new york', NC: 'north carolina', ND: 'north dakota', OH: 'ohio', OK: 'oklahoma',
  OR: 'oregon', PA: 'pennsylvania', RI: 'rhode island', SC: 'south carolina',
  SD: 'south dakota', TN: 'tennessee', TX: 'texas', UT: 'utah', VT: 'vermont',
  VA: 'virginia', WA: 'washington', WV: 'west virginia', WI: 'wisconsin', WY: 'wyoming',
}
const US_STATE_NAMES: ReadonlySet<string> = new Set(Object.values(US_STATE_CODES))

/**
 * The specific US states a lender names, as canonical lowercase names.
 *
 * Many rows list states ("US Specific","NV","UT") and
 * until now nothing held them to it, so a Colorado bank answered a Texas
 * search. A two-letter token only counts when it is UPPERCASE in the raw cell —
 * otherwise "US or Canada" would read as Oregon and "Prefer Mid West but not
 * mandatory" would be a state list.
 */
function usStatesNamedBy(lenderGeos: string[]): Set<string> {
  const found = new Set<string>()
  for (const raw of lenderGeos) {
    for (const token of raw.split(/[^A-Za-z0-9]+/)) {
      if (!token) continue
      if (token.length === 2 && token === token.toUpperCase()) {
        const name = US_STATE_CODES[token]
        if (name) found.add(name)
      }
    }
    const padded = geoText(raw)
    for (const name of US_STATE_NAMES) {
      if (padded.includes(` ${name} `)) found.add(name)
    }
  }
  return found
}

const mentions = (lenderGeos: string[], patterns: readonly string[]) =>
  lenderGeos.some((lg) => patterns.some((p) => geoText(lg).includes(` ${p.trim()} `)))

/** True when the lender's geo cells name any real foreign country or region. */
function namesForeignPlace(lenderGeos: string[]): boolean {
  return Object.values(FOREIGN_GEOS).some((patterns) => mentions(lenderGeos, patterns))
}

/** True when the lender's stated geo covers this one foreign deal geography. */
function coversForeignGeo(lenderGeos: string[], dealGeo: string): boolean {
  const patterns = FOREIGN_GEOS[dealGeo]
  if (patterns && mentions(lenderGeos, patterns)) return true
  // A lender stating a REGION covers its member countries: a lender says
  // "Africa" and the deal is Nigeria; another says "Europe" and the deal is France.
  return Object.entries(FOREIGN_REGIONS).some(
    ([region, regionPatterns]) =>
      mentions(lenderGeos, regionPatterns) && regionContains(region, dealGeo),
  )
}

/**
 * Words that introduce an EXCLUSION inside a free-text geo cell.
 *
 * Only the connectors that actually appear in the production column, matched
 * whole-word so "Exceptional" and "Excluding-asset" cannot fire one. `exc` also
 * covers the abbreviated "exc." — the word boundary sits between the "c" and the
 * period, and it cannot match inside "excluding" or "except" because neither has
 * a boundary there.
 */
const EXCLUSION_CONNECTOR =
  /\b(?:excluding|except|exc|but\s+not|other\s+than|outside\s+of|minus)\b/i

/**
 * Split a geo cell into what it INCLUDES and what it rules out.
 *
 * Returns null when the cell carries no exclusion clause at all, which is the
 * overwhelming majority of rows — those keep their existing reading untouched.
 * Only the first connector counts; everything after it is the excluded part.
 */
function splitGeoExclusion(cell: string): { inclusive: string; excluded: string } | null {
  const m = EXCLUSION_CONNECTOR.exec(cell)
  if (!m) return null
  const excluded = cell.slice(m.index + m[0].length)
  if (!excluded.trim()) return null
  return { inclusive: cell.slice(0, m.index), excluded }
}

/**
 * The canonical name of a US place named either way round — "Louisiana" or "LA".
 *
 * An exclusion is only honoured for a place BOTH halves of it resolve to, and
 * the two halves were reading different vocabularies. The lender's half goes
 * through usStatesNamedBy, which resolves an uppercase two-letter code — that is
 * how "LA" in "All domestic excluding LA" is known to mean Louisiana. The deal's
 * half went through isUsDeal alone, which knows the fifty names and no codes, so
 * a state asked for as "LA" resolved to no place at all. The clause was then
 * skipped as though it named nothing, and stateDim fell through to the
 * NATIONWIDE_TOKENS shortcut — which fired on the "All domestic" half of the very
 * same cell and returned 'match': a lender on a Louisiana shortlist, out of a
 * record that names Louisiana as the one state it will not touch.
 *
 * Reachable because the browse path reads `?states=` out of the URL through
 * readFacetParams and hands it to stateDim unaltered; only the search path's
 * resolveConstraints narrows a value to the canonical fifty first.
 *
 * Applied ONLY here, to what an exclusion is measured against. Canonicalising
 * coverage as well would be a behaviour change for every lender in the roster,
 * not a fix for this one; a code that resolves to no state still falls through to
 * today's reading, which over-excludes in the safe direction.
 */
function canonicalUsPlace(place: string): string {
  const wanted = norm(place)
  if (!wanted || US_STATES.has(wanted)) return wanted
  const code = place.trim().toUpperCase()
  return code.length === 2 ? (US_STATE_CODES[code] ?? wanted) : wanted
}

/**
 * True when a lender's own geography states, in writing, that it does not lend
 * in `place`.
 *
 * Rows can carry exclusion clauses like "All domestic excluding LA",
 * "East coast - except GA", "Except Cuba and Iran". Only the inclusive half was ever read, so "All domestic" fired
 * NATIONWIDE_TOKENS and the row answered a Louisiana search — a wrong lender out
 * of a record that names Louisiana as the one state it will not touch. The GA row
 * was worse: "GA" is an uppercase state code, so usStatesNamedBy read the
 * EXCLUDED state as the lender's state LIST and reported "lends in the selected
 * state".
 *
 * The clause only counts when the words after the connector resolve to a PLACE we
 * already know — a US state, or a country/region in FOREIGN_GEOS. "Prefer Mid
 * West but not mandatory" carries "but not" and names no place; it is a softener
 * about preference, and reading it as an exclusion would drop a lender on a word.
 * A clause naming nothing recognisable is ignored entirely and the cell falls back
 * to today's reading, because over-excluding is the more expensive mistake.
 *
 * No new vocabulary: the same helpers that decide coverage decide exclusion, so
 * the two can never disagree about what a word means.
 *
 * Both HALVES are resolved through that one vocabulary too — see
 * canonicalUsPlace. They were not, and a state asked for by its postal code slid
 * straight past the clause.
 */
function statedExclusionCovers(lenderGeos: string[], place: string): boolean {
  const wanted = canonicalUsPlace(place)
  if (!wanted) return false
  for (const cell of lenderGeos) {
    const split = splitGeoExclusion(cell)
    if (!split) continue
    const excluded = [split.excluded]
    const excludedStates = usStatesNamedBy(excluded)
    // Names no place → not an exclusion clause. Ignore it and read the cell as
    // we do today.
    if (excludedStates.size === 0 && !namesForeignPlace(excluded)) continue
    const hit = isUsDeal(wanted)
      ? excludedStates.has(wanted)
      : coversForeignGeo(excluded, place)
    if (hit) return true
  }
  return false
}

/**
 * Cell values that state NO geographic restriction at all.
 *
 * Matched as the WHOLE cell, not as a token inside it. A first attempt tested
 * "does this cell name any place we recognise", which read "Belarus" — a real
 * country simply absent from FOREIGN_GEOS — as unreadable, and would have put a
 * Belarus-only lender in front of a Texas deal. A place we do not have in our
 * vocabulary is still a stated restriction; only these words are an absence of
 * one.
 *
 * Whole-cell equality also keeps "All Domestic excluding LA" out: it contains
 * the word "all" while stating a real, narrower restriction.
 */
const UNSPECIFIED_GEO = new Set([
  'all', 'any', 'anywhere', 'all geographies', 'all locations', 'all markets',
  'no restriction', 'no restrictions', 'none', 'n a', 'na', 'varies', 'tbd',
  'unknown', 'flexible', 'open',
])

/**
 * True when every geo cell states an absence of restriction rather than a place.
 *
 * A blank geography is unknown and therefore kept — that is the accuracy rule.
 * A cell reading "All" is the same state of knowledge expressed in a word, and
 * it must land in the same place. A row can carry exactly that value in
 * `specific_geographic` with an empty `geographic_scope`. Once lenderGeoCells
 * started reading the detail cell, such a row's cell list stopped being empty,
 * geoDim's blank branch stopped firing, and it was hard-excluded from every
 * geography-bearing search.
 *
 * Deliberately UNKNOWN, not MATCH. "All" almost certainly does mean everywhere,
 * but promoting it to a confirmed match would rank a lender as stated coverage
 * on one ambiguous word. Unknown keeps it in the shortlist without claiming
 * anything — blank means unknown, never guessed into a match.
 */
function statesNoGeographicRestriction(lenderGeos: string[]): boolean {
  if (lenderGeos.length === 0) return false
  return lenderGeos.every((cell) => UNSPECIFIED_GEO.has(norm(cell)))
}

/** True if the lender's stated geo can serve at least one of the deal geos. */
function geoServes(dealGeos: string[], lenderGeos: string[]): boolean {
  if (hasToken(lenderGeos, GLOBAL_TOKENS)) return true
  if (overlaps(lenderGeos, dealGeos)) return true

  const usDealGeos = dealGeos.filter(isUsDeal)
  if (usDealGeos.length > 0) {
    // A lender that lists its states is held to them. "US Specific / AK / AZ /
    // CA / ID / WA" is not a nationwide lender, and answering a Texas search
    // with it is exactly what operators object to. An explicit nationwide phrase
    // wins over any states listed beside it, because "All Domestic including AK
    // and HI" names two states while meaning all fifty.
    if (!hasToken(lenderGeos, NATIONWIDE_TOKENS)) {
      const states = usStatesNamedBy(lenderGeos)
      if (states.size > 0) return usDealGeos.some((d) => states.has(norm(d)))
    }
    if (hasToken(lenderGeos, DOMESTIC_TOKENS)) return true
  }

  // foreign deal geo: the lender must actually name it, or a region containing it
  return dealGeos.some((d) => !isUsDeal(d) && coversForeignGeo(lenderGeos, d))
}

function geoDim(deal: DealCriteria, lender: LenderRow, reasons: string[]): DimensionVerdict {
  if (deal.geographic_scope.length === 0) return 'unknown'
  const lg = lenderGeoCells(lender)
  if (lg.length === 0) {
    reasons.push('geography not specified')
    return 'unknown'
  }
  // A place the record explicitly rules out cannot be served by the same record.
  // Filtered rather than short-circuited because geoServes is an ANY test: a deal
  // naming Texas and Louisiana is still servable by a lender who excludes only
  // Louisiana, on the Texas leg.
  const servable = deal.geographic_scope.filter((g) => !statedExclusionCovers(lg, g))
  if (servable.length === 0) {
    reasons.push('geography excluded — the record states it does not lend there')
    return 'contradict'
  }
  if (geoServes(servable, lg)) {
    reasons.push('geography served')
    return 'match'
  }
  // Flagged international but naming no actual country or region: we genuinely
  // do not know which foreign markets it serves, so it is UNKNOWN, not a
  // mismatch. Real rows are like this, plus rows whose geo cell holds
  // something that is not a place at all (Societe Sceptrum's
  // ["International","Equipment"]). Blank stays kept — never guessed either way.
  if (
    deal.geographic_scope.some((d) => !isUsDeal(d)) &&
    hasToken(lg, INTERNATIONAL_TOKENS) &&
    !namesForeignPlace(lg)
  ) {
    reasons.push('lender lends internationally but does not say which countries')
    return 'unknown'
  }
  if (statesNoGeographicRestriction(lg)) {
    reasons.push('geography states no restriction')
    return 'unknown'
  }
  reasons.push('geography mismatch — stated location does not cover the deal')
  return 'contradict'
}

/**
 * Asset-class fit with a one-level hierarchy from src/lib/config/vocabulary.ts: a
 * generic parent (e.g. "equipment") on either side matches any of its children
 * on the other (so "20yr equipment" doesn't drop a construction- or medical-
 * equipment lender). Specific-vs-different-specific still contradicts (an
 * agricultural deal ≠ a construction-only lender), as do different families.
 * Blank = unknown = kept.
 */
function assetDim(deal: DealCriteria, lender: LenderRow, reasons: string[]): DimensionVerdict {
  if (deal.asset_classes.length === 0) return 'unknown'
  const lv = lender.asset_classes ?? []
  if (lv.length === 0) {
    reasons.push('asset class not specified')
    return 'unknown'
  }
  const dset = new Set(deal.asset_classes.map(norm))
  const lset = new Set(lv.map(norm))
  for (const d of dset) if (lset.has(d)) {
    reasons.push('asset class matches')
    return 'match'
  }
  // The LENDER's generic parent covers any deal child of that family — it's
  // human-confirmed structured data, not NL-derived noise.
  for (const l of lset) {
    if (isGenericParent(l) && [...dset].some((d) => d !== l && familyOf(d) === l)) {
      reasons.push('generic category matches a specific type in the same family')
      return 'match'
    }
  }
  // The DEAL's generic parent is only a true wildcard when NO more-specific
  // child of the same family is also present. The config keyword lists overlap
  // — a "construction equipment" query co-fires the generic 'equipment' bucket
  // via the shared word — so a co-occurring parent must NOT override a stated
  // specific type (else an agricultural-only lender would wrongly match a
  // construction deal).
  for (const d of dset) {
    if (!isGenericParent(d)) continue
    const dHasSpecificChild = [...dset].some((x) => x !== d && familyOf(x) === d)
    if (!dHasSpecificChild && [...lset].some((l) => l !== d && familyOf(l) === d)) {
      reasons.push('generic category matches a specific type in the same family')
      return 'match'
    }
  }
  // Before excluding: do the lender's own notes say they finance this?
  //
  // A note that mentions an asset the structured cell has not caught up with
  // must not cause the lender to be DELETED from the shortlist on the strength
  // of a cell that is merely incomplete. Downgrades to unknown, which keeps the
  // lender without awarding it a point it has not earned.
  const fromNotes = noteAssets(lender)
  if (fromNotes.size > 0 && [...dset].some((d) => fromNotes.has(d))) {
    reasons.push('asset class not in the structured cell, but the notes mention it')
    return 'unknown'
  }
  reasons.push('asset class mismatch')
  return 'contradict'
}

/**
 * International requirement. Engages whenever deal.intl_required is true — which
 * is set by a generic "international" keyword OR a named foreign country/region
 * (see extract-deal.ts; geoDim votes independently on specific geography).
 * A lender stated Domestic-only must NEVER show for an international ask.
 * Blank intl_domestic falls back to stated geography; truly-unknown is kept.
 */
function intlDim(
  deal: DealCriteria,
  lender: LenderRow,
  reasons: string[],
  geoVerdict: DimensionVerdict,
): DimensionVerdict {
  if (!deal.intl_required) return 'unknown'
  const id = norm(lender.intl_domestic ?? '')
  if (id === 'domestic') {
    // ...unless the lender's OWN stated geography covers this deal. Rows can
    // be tagged Domestic while their geographic_scope names Canada, e.g.
    // ["US and International","Canada"]. Reading
    // both produced a self-contradictory verdict ("geography served" AND
    // "domestic-only, cannot serve an international deal") and dropped every one
    // of them from Canada deals. A specific stated geography is harder evidence
    // than a category flag that has evidently gone stale, so the flag never
    // hard-excludes a lender whose geography says it serves the place.
    if (geoVerdict === 'match') {
      reasons.push('tagged domestic, but its stated geography covers this deal')
      return 'unknown'
    }
    reasons.push('lender is domestic-only — cannot serve an international deal')
    return 'contradict'
  }
  if (id === 'international' || id === 'both') {
    reasons.push('lender lends internationally')
    return 'match'
  }
  // intl_domestic blank → infer from stated geography.
  const lg = lender.geographic_scope ?? []
  if (lg.length === 0) return 'unknown'
  // Either a true wildcard or the international category satisfies "deal is
  // non-US" — that is what this dimension asks. WHICH foreign country is a
  // separate question, answered by geoDim.
  if (hasToken(lg, GLOBAL_TOKENS) || hasToken(lg, INTERNATIONAL_TOKENS)) {
    reasons.push('lender lends outside the US')
    return 'match'
  }
  if (hasToken(lg, DOMESTIC_TOKENS) || lg.every((g) => isUsDeal(g))) {
    reasons.push('stated geography is US-domestic only')
    return 'contradict'
  }
  return 'unknown'
}

function sizeDim(deal: DealCriteria, lender: LenderRow, reasons: string[]): DimensionVerdict {
  if (deal.deal_size_min_usd === null && deal.deal_size_max_usd === null) return 'unknown'
  const lo = lender.deal_size_min_usd ?? null
  const hi = lender.deal_size_max_usd ?? null
  if (lo === null && hi === null) {
    reasons.push('deal size not specified')
    return 'unknown'
  }
  const sizeInferred = deal.size_confidence === 'inferred'
  if (deal.deal_size_min_usd !== null && hi !== null && hi < deal.deal_size_min_usd) {
    if (sizeInferred) {
      reasons.push('deal size was inferred, not stated — kept despite looking too large')
      return 'unknown'
    }
    reasons.push('deal too large for lender')
    return 'contradict'
  }
  if (deal.deal_size_max_usd !== null && lo !== null && lo > deal.deal_size_max_usd) {
    if (sizeInferred) {
      reasons.push('deal size was inferred, not stated — kept despite looking too small')
      return 'unknown'
    }
    reasons.push('deal too small for lender')
    return 'contradict'
  }
  reasons.push('deal size in range')
  return 'match'
}

/**
 * Usage-code rank signal. A lender that lists a matching code is boosted. A
 * lender listing OTHER codes (or none) is NOT excluded — a lender showing
 * "owner, lease" may still do a rental deal (tribal knowledge). So usage NEVER
 * contradicts; it is match-or-unknown only.
 */
function usageDim(deal: DealCriteria, lender: LenderRow, reasons: string[]): DimensionVerdict {
  const need = deal.usage_codes ?? []
  if (need.length === 0) return 'unknown'
  const have = parseUsageCodes(lender.usage_codes ?? '')
  if (have.length === 0) return 'unknown'
  if (have.some((p) => need.includes(p))) {
    reasons.push('usage matches')
    return 'match'
  }
  return 'unknown' // stated other codes ≠ contradiction (absence is not a "no")
}

/** Operation-category rank signal. Boost on match; never excludes. */
function operationDim(deal: DealCriteria, lender: LenderRow, reasons: string[]): DimensionVerdict {
  const want = norm(deal.operation_category ?? '')
  if (!want) return 'unknown'
  const have = norm(lender.operation_category ?? '')
  if (!have) return 'unknown'
  // "commercial" ⊆ "personal, commercial"; substring both ways is fine here.
  if (have.includes(want) || want.includes(have)) {
    reasons.push('operation category matches')
    return 'match'
  }
  return 'unknown'
}

/** Canonicalize a lender-type label or code (Bank/CU/Non-Bank/PE) for comparison. */
function canonLenderType(v: string | null | undefined): string {
  const s = norm(v ?? '').replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim()
  if (!s) return ''
  // Order matters: "non bank" and "credit union" both contain tokens that a
  // naive "bank" check would swallow, so match the specific kinds first.
  if (s.includes('credit union') || s === 'cu' || s === 'c') return 'credit_union'
  if (s.includes('non bank') || s.includes('non-bank') || s === 'nb' || s === 'nonbank') return 'non_bank'
  if (s.includes('private equity') || s === 'pe') return 'private_equity'
  if (s === 'b' || s.includes('bank')) return 'bank'
  // Unrecognized kind (e.g. "lessor", which the roster tags but never writes to
  // lender_type) must NOT canonicalize to itself: lenderTypeDim would then read
  // every Bank as a contradiction and hard-exclude every active bank to honour
  // a kind the column cannot express. Unknown kind = no type constraint.
  return ''
}

/**
 * Lender-type dimension — the ONLY rank field that can hard-exclude, and only
 * when the operator explicitly asked for a kind ("credit union", "non-bank").
 * A blank lender_type is unknown = kept (never guessed out).
 */
function lenderTypeDim(deal: DealCriteria, lender: LenderRow, reasons: string[]): DimensionVerdict {
  const want = canonLenderType(deal.lender_type_required)
  if (!want) return 'unknown'
  const have = canonLenderType(lender.lender_type)
  if (!have) return 'unknown' // lender kind unknown → kept
  // "non-bank" is a NEGATION, not a positive category: a Credit Union or a
  // Private Equity fund IS non-bank and must be kept — only a Bank contradicts.
  if (want === 'non_bank') {
    if (have === 'bank') {
      reasons.push('requested non-bank; lender is a bank')
      return 'contradict'
    }
    reasons.push('lender is non-bank as requested')
    return 'match'
  }
  if (have === want) {
    reasons.push('lender type matches the requested kind')
    return 'match'
  }
  reasons.push('lender is a different kind than requested')
  return 'contradict'
}

/**
 * "Narrow by → State".
 *
 * An AND-constraint on top of geoDim, never a widening of it. Semantics follow
 * the same rules geoServes already uses for a US deal, because the question is
 * identical — can this lender lend in this state:
 *
 *   lender geo blank                    → unknown  (kept; blank is never guessed)
 *   worldwide / nationwide phrase       → match    ("All Domestic including AK and HI")
 *   lender lists states                 → must name one of the selected ones
 *   lender says domestic, lists none    → match    (US-wide by default)
 *   otherwise (foreign-only lender)     → contradict
 */
function stateDim(deal: DealCriteria, lender: LenderRow, reasons: string[]): DimensionVerdict {
  const want = (deal.us_states ?? []).map(norm).filter(Boolean)
  if (want.length === 0) return 'unknown'
  const lg = lenderGeoCells(lender)
  if (lg.length === 0) {
    reasons.push('geography not specified')
    return 'unknown'
  }
  // Before any coverage phrase is read: a state the record names as excluded is
  // not served, however nationwide the rest of the cell sounds. "All domestic
  // excluding LA" is a NATIONWIDE_TOKENS phrase and used to match a Louisiana
  // pick outright, one clause after saying it would not.
  const allowed = want.filter((w) => !statedExclusionCovers(lg, w))
  if (allowed.length === 0) {
    reasons.push('state excluded — the record states it does not lend there')
    return 'contradict'
  }
  if (hasToken(lg, GLOBAL_TOKENS) || hasToken(lg, NATIONWIDE_TOKENS)) {
    reasons.push('lends nationwide')
    return 'match'
  }
  const states = usStatesNamedBy(lg)
  if (states.size > 0) {
    if (allowed.some((w) => states.has(w))) {
      reasons.push('lends in the selected state')
      return 'match'
    }
    reasons.push('state not served — lender lists specific states and this is not one')
    return 'contradict'
  }
  if (hasToken(lg, DOMESTIC_TOKENS)) {
    reasons.push('lends across the US')
    return 'match'
  }
  if (statesNoGeographicRestriction(lg)) {
    reasons.push('geography states no restriction')
    return 'unknown'
  }
  reasons.push('state not served — lender names no US coverage')
  return 'contradict'
}

/**
 * "Narrow by → Asset age".
 *
 * Also closes a wrong-lender hole that predates the menu. `vintage_restriction`
 * was stored, displayed, exported and embedded, but no filter had ever read it —
 * and extract-deal.ts deliberately discards bare numbers, so the "2005" in
 * "2005 Caterpillar 320" was dropped on the floor. A lender whose record says
 * "20 Years" could therefore lead a shortlist for a 40-year-old asset it had
 * stated in writing it would not finance.
 *
 * Excludes only on a restriction we could actually parse AND that the asset
 * actually breaches. Unparseable text is unknown and is kept.
 */
function vintageDim(deal: DealCriteria, lender: LenderRow, reasons: string[]): DimensionVerdict {
  const year = deal.asset_year ?? null
  if (year === null) return 'unknown'
  const rule = parseVintageRule(lender.vintage_restriction)
  if (rule.kind === 'unknown') {
    reasons.push('asset age limit recorded in a form we cannot read')
    return 'unknown'
  }
  const oldest = oldestYearAllowed(rule, deal.as_of_year ?? year)
  if (oldest === null) {
    reasons.push('no asset age restriction')
    return 'match'
  }
  if (year >= oldest) {
    reasons.push('asset is within the stated age limit')
    return 'match'
  }
  if (deal.asset_year_confidence === 'inferred') {
    reasons.push('asset year was inferred, not stated — kept despite the age limit')
    return 'unknown'
  }
  reasons.push(`asset too old — lender finances ${oldest} or newer`)
  return 'contradict'
}

/**
 * Does the lender's record NAME the place that was asked for?
 *
 * An operator narrowed by State = Texas and got everyone who lends nationwide
 * alongside the Texas banks — *"it doesn't really do me a lot of good if I get
 * all of the Texas banks, but then I have all the other ones that do business
 * nationwide. It kind of defeats the process."* Finding
 * lenders in a marketplace is the job; a nationwide lender is a correct answer
 * to "who can fund this", and a poor answer to "who is IN Texas".
 *
 * So this ranks, it does not exclude. A nationwide lender genuinely does serve
 * Texas — dropping it would be lying to the operator about the shortlist, which
 * is the same failure as a wrong lender pointed the other way. What changes is
 * the ORDER: a record that names the state leads, and the nationwide ones
 * follow underneath it.
 *
 * "Names it" means the state or country appears in the lender's own geography
 * cells. Coverage inferred from `nationwide`, `all domestic`, `worldwide` or a
 * bare `US` is real coverage but not local knowledge, so it does not count.
 */
function namesRequestedPlace(deal: DealCriteria, lender: LenderRow): boolean {
  const lg = lenderGeoCells(lender)
  if (lg.length === 0) return false

  const wantStates = (deal.us_states ?? []).map(norm).filter(Boolean)
  if (wantStates.length > 0) {
    const named = usStatesNamedBy(lg)
    if (wantStates.some((w) => named.has(w) && !statedExclusionCovers(lg, w))) return true
  }

  for (const g of deal.geographic_scope) {
    if (statedExclusionCovers(lg, g)) continue
    if (isUsDeal(g)) {
      if (usStatesNamedBy(lg).has(norm(g))) return true
      continue
    }
    // A foreign deal geography the lender names outright — "Brazil" on the
    // record, not "International".
    if (FOREIGN_GEOS[g] && mentions(lg, FOREIGN_GEOS[g])) return true
  }
  return false
}

/**
 * How FOCUSED the lender is on the place that was asked for.
 *
 * Lower is more focused. One lender lists ["US Specific","TX"]; another lists
 * fourteen states including TX. Both genuinely serve Texas and both are
 * `localToRequest`, but a Texas-only bank is more *of* Texas than a
 * fourteen-state lender that happens to include it, and matching a lender's
 * preferred location to the deal's location means exactly that distinction.
 *
 * Used only as a tiebreaker BELOW score, never above it. A focused lender that
 * fits the deal worse must not outrank one that fits it better, and deal size is
 * already a hard dimension — a Texas-only bank that caps at $1M is excluded from
 * a $12M deal on its own merits, not demoted by this.
 *
 * Returns Infinity for a lender that is not local, so the value is inert for
 * everyone outside the local block.
 */
function localFootprintSize(deal: DealCriteria, lender: LenderRow): number {
  const lg = lenderGeoCells(lender)
  if (lg.length === 0) return Number.POSITIVE_INFINITY
  const states = usStatesNamedBy(lg).size
  const countries = Object.keys(FOREIGN_GEOS).filter((c) =>
    mentions(lg, FOREIGN_GEOS[c]),
  ).length
  const named = states + countries
  return named > 0 ? named : Number.POSITIVE_INFINITY
}

/**
 * Does a place named in the notes refer to a place the deal asked for?
 *
 * Runs the note's word through the SAME vocabulary that decides structured
 * coverage — usStatesNamedBy for US places, FOREIGN_GEOS/coversForeignGeo for
 * everything else — by treating the single phrase as a one-cell geo list. That
 * reuse is the point, not a shortcut: an earlier bug was two
 * halves of one comparison reading different vocabularies, where `LA` meant
 * Louisiana on one side and nothing on the other. A second place-parser here
 * would be the same mistake with a new name.
 *
 * Returns the sentence the signal came from, so the caller can show it. Null
 * when nothing in the list refers to the requested place.
 */
function noteSignalHit(places: NoteSignalPlace[], deal: DealCriteria): string | null {
  if (places.length === 0) return null

  const wantStates = (deal.us_states ?? []).map(canonicalUsPlace).filter(Boolean)
  const wantGeos = deal.geographic_scope.filter(Boolean)

  for (const p of places) {
    const cell = [p.place]
    const named = usStatesNamedBy(cell)
    // A region named in the notes covers its member states. A note can be
    // just "Southeast"; canonicalNotePlace accepts that, so without this it
    // was stored and matched nothing.
    if (wantStates.some((w) => named.has(w) || usRegionCovers(p.place, w))) return p.quote
    for (const g of wantGeos) {
      const wanted = canonicalUsPlace(g)
      if (isUsDeal(wanted)) {
        if (named.has(wanted) || usRegionCovers(p.place, wanted)) return p.quote
        continue
      }
      if (coversForeignGeo(cell, g)) return p.quote
    }
  }
  return null
}

/** Asset tokens the notes claim this lender finances. Empty when unread. */
function noteAssets(lender: LenderRow): Set<string> {
  const sig = asNoteSignals(lender.note_signals)
  return new Set((sig?.assets ?? []).map((a) => norm(a.asset)))
}

export function scoreFit(lender: LenderRow, deal: DealCriteria): FitVerdict {
  const reasons: string[] = []
  const asset = assetDim(deal, lender, reasons)
  const geo = geoDim(deal, lender, reasons)
  const size = sizeDim(deal, lender, reasons)
  const intl = intlDim(deal, lender, reasons, geo)
  const lenderType = lenderTypeDim(deal, lender, reasons)
  const usage = usageDim(deal, lender, reasons)
  const operation = operationDim(deal, lender, reasons)
  const state = stateDim(deal, lender, reasons)
  const vintage = vintageDim(deal, lender, reasons)

  // Hard dims (incl. lender-type-when-asked) weigh ±1. Rank boosts (usage,
  // operation) add +0.5 each and never subtract — they lift good matches
  // without ever overpowering or excluding on a stated hard constraint.
  const hard = [asset, geo, size, intl, lenderType, state, vintage]
  const hardScore =
    hard.filter((v) => v === 'match').length - hard.filter((v) => v === 'contradict').length
  const rankScore = 0.5 * [usage, operation].filter((v) => v === 'match').length
  const score = hardScore + rankScore

  const notLending = isNotCurrentlyLending(lender)
  if (notLending) reasons.push('Record says this lender is not currently lending')

  const localToRequest = namesRequestedPlace(deal, lender)
  if (localToRequest) reasons.push('Record names this location specifically')
  const localFootprint = localToRequest
    ? localFootprintSize(deal, lender)
    : Number.POSITIVE_INFINITY

  const sig = asNoteSignals(lender.note_signals)
  const notesPrefer = sig ? noteSignalHit(sig.prefers, deal) : null
  const notesAvoid = sig ? noteSignalHit(sig.avoids, deal) : null
  const notesPaused = sig?.paused?.quote ?? null
  if (notesPrefer) reasons.push(`Notes name this location: "${notesPrefer}"`)
  if (notesAvoid) reasons.push(`Notes rule this location out: "${notesAvoid}"`)
  if (notesPaused && !notLending) {
    reasons.push(`Notes say lending may have stopped: "${notesPaused}"`)
  }

  return {
    score,
    asset,
    geo,
    size,
    intl,
    usage,
    operation,
    lenderType,
    state,
    vintage,
    notLending,
    localToRequest,
    localFootprint,
    notesPrefer,
    notesAvoid,
    notesPaused,
    reasons,
  }
}

/**
 * True only when the record STATES the lender is closed for business —
 * the spreadsheet's "Lending Status: No", or its normalized `status: dormant`.
 * Blank, missing or anything else is unknown and returns false, because an
 * unknown lender is a candidate (accuracy mandate: blank is never guessed).
 */
export function isNotCurrentlyLending(lender: LenderRow): boolean {
  if (norm(lender.status ?? '') === 'dormant') return true
  return STATED_NOT_LENDING.has(norm(lender.lending_status ?? ''))
}

/**
 * The `lending_status` values that mean "closed for business right now".
 *
 * This tested exactly `'no'`, while the dropdown the operator picks from offers
 * a third choice — `Currently Inactive` (vocabularies.ts). A lender set to it
 * was neither demoted nor flagged; it ranked as though it were open. The vocabulary module exists so the two
 * screens cannot disagree about a value, and this is the same class of drift one
 * layer down: the menu and the matcher disagreeing about what the value MEANS.
 *
 * Still only STATED values. Blank stays unknown and is never guessed into a
 * verdict, and a pause that only the free-text notes mention does not belong
 * here — that surfaces as FitVerdict.notesPaused and changes no ordering at all.
 */
const STATED_NOT_LENDING = new Set(['no', 'currently inactive'])

export const hasContradiction = (f: FitVerdict): boolean =>
  f.asset === 'contradict' ||
  f.geo === 'contradict' ||
  f.size === 'contradict' ||
  f.intl === 'contradict' ||
  f.lenderType === 'contradict' ||
  f.state === 'contradict' ||
  f.vintage === 'contradict'

/**
 * Re-rank hydrated candidates by structured fit.
 *
 * ALL stated criteria are hard constraints (operator directive 2026-06-10):
 * a lender whose stated geo, asset class, OR deal-size range contradicts the
 * deal is EXCLUDED entirely ("hide all that don't fit"). Blank/unknown fields
 * are always kept (we don't exclude on missing data). Geo matching is
 * synonym-aware. Order: fit score desc, then original (semantic/RRF) rank.
 * NOTE: left intentionally easy to soften per-dimension if feedback shows
 * over-exclusion — see hasContradiction / the per-dimension verdicts.
 */
export function rankByFit<T extends LenderRow & { id: string; company_name?: string | null }>(
  rows: T[],
  deal: DealCriteria,
  fusedOrder: Map<string, number>,
): Array<T & { fit: FitVerdict }> {
  return rows
    .map((r) => ({ ...r, fit: scoreFit(r, deal) }))
    .filter((r) => !hasContradiction(r.fit))
    .sort((a, b) => {
      // A lender the record says isn't lending sorts below every lending one,
      // however well it fits. It stays in the list; it just can't lead a
      // shortlist for a deal it cannot fund today.
      if (a.fit.notLending !== b.fit.notLending) return a.fit.notLending ? 1 : -1
      // A lender whose record names the requested place leads the ones that
      // merely cover it nationwide. Above `score` deliberately: when the
      // operator picks a state they are asking who is IN that market, and a
      // nationwide lender scoring one point higher on an unrelated dimension
      // should not push the local bank below the fold. Everyone still appears.
      if (a.fit.localToRequest !== b.fit.localToRequest) return a.fit.localToRequest ? -1 : 1
      // Then the ones whose NOTES name it. A lender whose structured geography
      // is a bare "US" and whose notes say "Headquartered in Nebraska" looks
      // like a generic nationwide lender to the matcher and like a regional
      // bank to a human; this closes that gap.
      //
      // Below localToRequest on purpose: a state curated into the geography cell
      // outranks a state read out of prose. Above score for the same reason
      // localToRequest is — picking a place is asking who is IN that market.
      // A lender whose own notes rule the requested place out sinks below every
      // lender that has not said so. It is NOT removed: this is a machine reading
      // of prose, and the mandate's rule is that a value we worked out ourselves
      // may rank and may never exclude. The sentence rides on the row, so the
      // operator sees "No HI or AK" against a Hawaii search and can move it into
      // the structured geography cell, where it becomes stated and does exclude.
      //
      // BELOW localToRequest, not above it. The two can contradict each other —
      // a curated cell listing Texas against a note reading "no Texas deals" —
      // and when they do, the cell a human typed wins and the conflict is shown
      // rather than silently resolved in favour of the model. Sorting this above
      // localToRequest sank a curated Texas bank below a generic nationwide
      // lender on a Texas search, which inverts the rule the comment above states.
      const aAvoid = a.fit.notesAvoid !== null
      const bAvoid = b.fit.notesAvoid !== null
      if (aAvoid !== bAvoid) return aAvoid ? 1 : -1
      const aPrefer = a.fit.notesPrefer !== null
      const bPrefer = b.fit.notesPrefer !== null
      if (aPrefer !== bPrefer) return aPrefer ? -1 : 1
      if (b.fit.score !== a.fit.score) return b.fit.score - a.fit.score
      // Among local lenders that fit equally well, the more focused one leads:
      // a Texas-only bank before a fourteen-state lender that includes Texas.
      // Below score on purpose — see localFootprintSize.
      if (a.fit.localFootprint !== b.fit.localFootprint)
        return a.fit.localFootprint - b.fit.localFootprint
      const fa = fusedOrder.get(a.id) ?? 1e9
      const fb = fusedOrder.get(b.id) ?? 1e9
      if (fa !== fb) return fa - fb
      // Final tiebreaker: alphabetical, always.
      //
      // Without this the order was decided by `Array.sort` stability over the
      // insertion order of an unordered `select('id')` scan. In whole-roster
      // mode most survivors share one score AND have no fused rank, so that was
      // hundreds of exact ties resolved by physical row order — which Postgres
      // is free to change after any update or vacuum. The same search ran twice
      // could return a different top 25, which is what "the search functions do
      // not consistently work" looks like from the outside.
      return (a.company_name ?? '').localeCompare(b.company_name ?? '')
    })
}
