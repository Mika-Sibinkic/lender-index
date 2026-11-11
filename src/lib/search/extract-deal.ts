/**
 * Deterministic deal-parameter extraction — NO LLM.
 *
 * Replaces the two cold qwen2.5:7b structured calls that were in the search
 * hot path (query-rewrite + graph seed extraction). Those, plus a model swap
 * to embed, pushed /api/search past the 30s function cap → 504 Gateway
 * Timeout on a self-hosted model. This runs in <1ms and leaves a single embed
 * call as the only AI hop, getting search to ~2-5s.
 *
 * Coverage follows src/lib/config/vocabulary.ts: asset classes, makes and models
 * for graph seeding, borrower industries, usage codes and operation
 * categories — plus US states + countries/regions and $ amounts.
 */

import { ASSET_CLASSES } from '@/lib/types/funding-source'
import {
  ASSET_AGE,
  ASSET_CATEGORIES,
  ASSET_MAKES,
  BORROWER_INDUSTRIES,
  OPERATION_CATEGORIES,
  USAGE_CODES,
} from '@/lib/config/domain'
import { FOREIGN_GEOS, FOREIGN_GEO_NAMES } from '@/lib/search/countries'
import {
  convertToUsd,
  resolveMilAmount,
  type Confidence,
} from '@/lib/search/money'

export interface DealExtract {
  semantic_query: string
  asset_classes: string[]
  deal_size_min_usd: number | null
  deal_size_max_usd: number | null
  geographic_scope: string[]
  industry_filters: string[]
  asset_families: string[]
  asset_models: string[]
  /**
   * Deal is INTERNATIONAL → engage the intl hard-exclude (Domestic-only lenders
   * are contradicted). True when the query either used a generic international
   * keyword (international/overseas/abroad/worldwide/…) OR named a specific
   * non-US foreign country/region (Argentina, Portugal, Japan, Middle East, …).
   */
  intl_required: boolean
  /**
   * Rank-signal deal params (optional). Populated only when the query states
   * them; downstream they BOOST matches (usage/operation) or, for an explicit
   * lender-kind ask, filter (lender_type). Absence never excludes a lender.
   */
  usage_codes?: string[]
  operation_category?: string | null
  lender_type_required?: string | null
  /**
   * US states picked from the "Narrow by → State" menu. Never set by parsing —
   * a state named in the sentence flows through geographic_scope as it always
   * has. This exists so a facet pick can narrow without being merged into the
   * deal's geography, where it would widen instead (see DealCriteria.us_states).
   */
  us_states?: string[]
  /** Asset model year stated in the query ("2019 Caterpillar 320"). */
  asset_year?: number | null
  /**
   * The query quoted an amount in a currency that is not USD (R$, €, £ …).
   * The lender columns are USD, converting needs a live FX rate, and a stale
   * rate is a wrong record — so the size constraint is deliberately NOT set and
   * this names the currency so the screen can say why.
   */
  size_currency_unsupported?: string | null
  /**
   * The amount used a unit that means different things in different languages.
   * Today that is exactly one word: "mil". English finance uses it for
   * MILLION ("International lender above 20 mil"),
   * while in Portuguese and Spanish it means THOUSAND. Reading "800 mil" as
   * $800M excludes the entire roster; reading "20 mil" as $20k excludes almost
   * none of it. Both are wrong, so when the sentence carries other Portuguese or
   * Spanish words we decline to pick and say so.
   */
  size_unit_ambiguous?: string | null
  /**
   * How much authority the deal size carries. 'stated' may hard-exclude a
   * lender; 'inferred' may only rank. See lib/search/money.ts — excluding on a
   * number we worked out ourselves can drop the one lender who could write the
   * deal, and the operator never learns it existed.
   */
  deal_size_confidence?: Confidence
  /** Plain-English account of how the size was arrived at, for the chip row. */
  deal_size_basis?: string | null
  /** Same rule for the asset year. */
  asset_year_confidence?: Confidence
  asset_year_basis?: string | null
}

/**
 * High-signal Portuguese / Spanish words. Used only to detect that a sentence is
 * NOT English so an ambiguous unit can be flagged rather than guessed — never to
 * set a constraint of its own.
 */
const PT_ES_MARKERS = [
  ' um ', ' uma ', ' un ', ' una ', ' no ', ' na ', ' em ', ' para ', ' de la ',
  'financiamento', 'financiacion', 'financiación', 'empresa', 'operador',
  'milhoes', 'milhões', 'millones', 'reais', 'dolares', 'dólares',
]

function looksIberian(q: string): boolean {
  const hay = ` ${q.toLowerCase()} `
  return PT_ES_MARKERS.some((m) => hay.includes(m))
}

/**
 * Asset model year, e.g. the "2019" in "2019 Caterpillar 320 – Mexico".
 *
 * Gated on the query also naming an asset, because this dimension EXCLUDES
 * lenders and a false positive here drops good ones. "5 deals closed in 2019"
 * names no asset, so nothing is read from it. Deal amounts cannot collide:
 * extractDealSize only counts a number carrying `$` or a k/m/b unit, so a bare
 * year was already being ignored there.
 */
function extractAssetYear(
  query: string,
  hasAssetContext: boolean,
): { year: number | null; confidence: Confidence; basis: string | null } {
  const none = { year: null, confidence: 'stated' as Confidence, basis: null }
  if (!hasAssetContext) return none
  const thisYear = new Date().getUTCFullYear()
  // Not preceded by $ or a digit/comma/period, so "$2,005,000" cannot match.
  // Any four digits; the range check below applies ASSET_AGE.oldestYear.
  const re = /(?<![$\d.,])\b(\d{4})\b(?![\d,.])/g
  const hits: Array<{ year: number; index: number }> = []
  let m: RegExpExecArray | null
  while ((m = re.exec(query)) !== null) {
    const y = Number(m[1])
    if (y >= ASSET_AGE.oldestYear && y <= thisYear + 1) hits.push({ year: y, index: m.index })
  }
  if (hits.length === 0) return none
  if (hits.length === 1) return { year: hits[0].year, confidence: 'stated', basis: null }

  // More than one year in the sentence. Taking the first was wrong: "deals since
  // 2019 for a 2005 Caterpillar" read 2019 and would have hard-excluded on an
  // asset age the deal never stated. Prefer a year that actually sits in
  // front of an asset word, which is how anyone writes one: "2005
  // Caterpillar", "a 2012 excavator".
  const lower = query.toLowerCase()
  const nouns = [...ASSET_MAKES, ...ASSET_CATEGORIES.flatMap((c) => c.keywords.map((k) => k.trim()))]
  const attached = hits.filter((h) => {
    const after = lower.slice(h.index + 4, h.index + 4 + 24)
    return nouns.some((n) => after.includes(n))
  })
  if (attached.length === 1) {
    return { year: attached[0].year, confidence: 'stated', basis: null }
  }
  // Still ambiguous. Rather than drop it entirely — which left a stated asset
  // year doing nothing at all — take the OLDEST plausible year and mark it inferred,
  // so it ranks but can never exclude. Oldest is the conservative choice: it is
  // the reading under which the fewest lenders are eliminated, and an inferred
  // year is barred from eliminating any of them regardless.
  const oldest = hits.reduce((a, b) => (b.year < a.year ? b : a))
  const years = [...new Set(hits.map((h) => h.year))].sort()
  return {
    year: oldest.year,
    confidence: 'inferred',
    basis: `sentence names ${years.join(' and ')}; read as ${oldest.year} for ranking only`,
  }
}

// Generic "lends internationally" intent — distinct from a specific foreign
// country (those flow through geographic_scope + geoDim). Triggers the intl
// hard-exclude of Domestic-only lenders.
const INTL_KEYWORDS = [
  'international', 'internationally', 'overseas', 'abroad', 'foreign',
  'cross-border', 'cross border', 'outside the us', 'outside the u.s',
  'non-us', 'non us', 'worldwide', 'global', 'globally',
  // PT / ES / FR / DE. Note 'international' is already the French spelling.
  'internacional', 'internacionalmente', 'no exterior', 'estrangeiro',
  'extranjero', 'mundial', 'transfronterizo', 'transfronteirico',
  "a l'etranger", 'a letranger', 'ausland', 'international',
]

/**
 * Did the international requirement come from a generic keyword rather than a
 * named country? The merged-search UI needs the distinction: a keyword-only
 * "international" is a chip the operator may switch off, but a named foreign
 * country is not — un-stating Brazil on a Brazil deal would put US-only lenders
 * in the shortlist. See lib/search/constraints.ts.
 */
export function hasIntlKeyword(query: string): boolean {
  const hay = pad(query)
  return INTL_KEYWORDS.some((k) => hay.includes(k))
}

/**
 * Query words → canonical asset class, from src/lib/config/vocabulary.ts.
 *
 * Keywords match as substrings of the padded query (pad a keyword with spaces
 * in config when it must be a whole word). Makes match as whole words, so a
 * short brand cannot fire inside a longer word. Keywords in Portuguese /
 * Spanish / French / German sit alongside the English ones: before they did, a
 * Portuguese query produced NO asset class at all, so the asset hard-exclude
 * never engaged and a lender for a different asset stayed eligible.
 */
const ASSET_KEYWORDS: Record<string, string[]> = Object.fromEntries(
  ASSET_CATEGORIES.map((c) => [c.id, c.keywords]),
)
const ASSET_MAKES_BY_CLASS: Record<string, string[]> = Object.fromEntries(
  ASSET_CATEGORIES.map((c) => [c.id, c.makes ?? []]),
)

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const hasWord = (hay: string, w: string) => new RegExp(`\\b${escapeRe(w)}\\b`).test(hay)

// Canonical geo → match patterns (lowercased, word-ish). Abbreviations map to
// the canonical name so filter + graph seeding stay consistent.
const US_STATES: Record<string, string[]> = {
  Alabama: ['alabama', ' al '], Alaska: ['alaska'], Arizona: ['arizona', ' az '],
  Arkansas: ['arkansas'], California: ['california', ' ca ', 'socal', 'norcal'],
  Colorado: ['colorado', ' co '], Connecticut: ['connecticut'], Delaware: ['delaware'],
  Florida: ['florida', ' fl '], Georgia: ['georgia', ' ga '], Hawaii: ['hawaii'],
  Idaho: ['idaho'], Illinois: ['illinois', ' il '], Indiana: ['indiana'], Iowa: ['iowa'],
  Kansas: ['kansas'], Kentucky: ['kentucky'], Louisiana: ['louisiana'], Maine: ['maine'],
  Maryland: ['maryland'], Massachusetts: ['massachusetts'], Michigan: ['michigan'],
  Minnesota: ['minnesota'], Mississippi: ['mississippi'], Missouri: ['missouri'],
  Montana: ['montana'], Nebraska: ['nebraska'], Nevada: ['nevada'],
  'New Hampshire': ['new hampshire'], 'New Jersey': ['new jersey'], 'New Mexico': ['new mexico'],
  'New York': ['new york'], 'North Carolina': ['north carolina'], 'North Dakota': ['north dakota'],
  Ohio: ['ohio'], Oklahoma: ['oklahoma'], Oregon: ['oregon'], Pennsylvania: ['pennsylvania'],
  'Rhode Island': ['rhode island'], 'South Carolina': ['south carolina'], 'South Dakota': ['south dakota'],
  Tennessee: ['tennessee'], Texas: ['texas', ' tx '], Utah: ['utah'], Vermont: ['vermont'],
  Virginia: ['virginia'], Washington: ['washington state', 'washington'], 'West Virginia': ['west virginia'],
  Wisconsin: ['wisconsin'], Wyoming: ['wyoming'],
}

/**
 * The 50 canonical state names, in the exact spelling the matcher expects.
 * Exported so the "Narrow by → State" menu offers the same vocabulary the
 * filter reads, rather than a second list that can drift out of step.
 */
export const US_STATE_NAMES: readonly string[] = Object.keys(US_STATES)

// US-internal geographies + the United States country token. Foreign countries
// and foreign regions live in ./countries.ts (FOREIGN_GEOS) — recognising one
// there is what engages international intent. Nothing in THIS dict may engage
// intl: a "domestic" / Midwest / West Coast deal is a US deal.
const US_REGIONS_COUNTRY: Record<string, string[]> = {
  // A bare ' us ' is deliberately NOT here. It is the single most dangerous
  // token in this file: written in a Portuguese sentence, "US 3 milhoes no
  // Brasil" matched it, which set geography to United States, suppressed Brazil
  // (see the hasUsGeo rule below) and left intl_required false — putting
  // US-only lenders on a Brazilian deal. Measured 2026-09-08. "US$ 3 milhoes"
  // escaped only because the '$' happened to block the trailing space.
  // Losing ' us ' costs a little narrowing on "lenders in the US"; keeping it
  // cost a wrong shortlist, and under the mandate those are not comparable.
  'United States': ['united states', 'usa', ' u.s', 'stateside', 'domestic'],
  Midwest: ['midwest', 'mid-west'],
  Northeast: ['northeast', 'north-east'],
  Southeast: ['southeast', 'south-east'],
  Southwest: ['southwest', 'south-west'],
  'West Coast': ['west coast'],
  'East Coast': ['east coast'],
}

function pad(s: string): string {
  return ` ${s.toLowerCase().replace(/[,]/g, ' ')} `
}

/**
 * Looser haystack for foreign-geo matching only: also turns hyphens and slashes
 * into spaces so space-padded short tokens (' uk ', ' uae ', ' us ') match common
 * compounds like "UK-based", "US/UK", "UAE-headquartered". Kept separate from
 * pad() so the US-region/asset dicts (which carry hyphenated patterns like
 * 'mid-west', 'tractor-trailer') are unaffected.
 */
function padLoose(s: string): string {
  return ` ${s.toLowerCase().replace(/[,/-]/g, ' ')} `
}

function matchDict(haystack: string, dict: Record<string, string[]>): string[] {
  const out: string[] = []
  for (const [canon, pats] of Object.entries(dict)) {
    if (pats.some((p) => haystack.includes(p))) out.push(canon)
  }
  return out
}

const occurrences = (hay: string, sub: string) => (sub ? hay.split(sub).length - 1 : 0)

/**
 * Drop a match that only exists inside a longer match.
 *
 * "West Virginia" contains "virginia", and "Arkansas" contains "kansas", so
 * plain substring matching returned BOTH states for one place name. A
 * Virginia-only lender then appeared on a West Virginia deal — a stated-geography
 * contradiction, i.e. a wrong lender. [Found on prod 2026-08-10: the chips read
 * `WHERE Virginia` and `WHERE West Virginia` for a single West Virginia query.]
 *
 * Occurrence counting rather than a plain substring test, so a query that names
 * both ("Virginia and West Virginia") keeps both: "virginia" appears twice while
 * "west virginia" appears once, leaving one standalone mention.
 *
 * Note this is a different problem from the foreign-geo one that
 * matchForeignGeos solves. There the fix is token boundaries — "india" inside
 * "indiana" is not a standalone token. Here "virginia" IS a standalone token
 * inside "west virginia", so only length can separate them.
 */
function dropShadowedMatches(
  hay: string,
  matched: string[],
  dict: Record<string, string[]>,
): string[] {
  return matched.filter((canon) => {
    const hits = (dict[canon] ?? []).filter((p) => hay.includes(p))
    return hits.some((hit) => {
      const shadowing = matched
        .filter((other) => other !== canon)
        .flatMap((other) => dict[other] ?? [])
        .filter((p) => p.length > hit.length && p.includes(hit) && hay.includes(p))
      const shadowed = shadowing.reduce((n, p) => n + occurrences(hay, p), 0)
      return occurrences(hay, hit) > shadowed
    })
  })
}

/**
 * Whole-token match for foreign geos: a pattern matches only as a standalone
 * token, so a bare 'india' does NOT match inside 'indiana', 'china' not inside
 * 'chinatown', 'oman' not inside 'romania'. (Substring matching here wrongly
 * flagged populous US places international and hard-excluded valid domestic
 * lenders — the inverse of the foreign-geography exclusion.) Uses the padLoose haystack so compounds
 * like 'UK-based' still match. Patterns are trimmed so pre-padded entries behave.
 */
function matchForeignGeos(haystack: string): string[] {
  const out: string[] = []
  for (const [canon, pats] of Object.entries(FOREIGN_GEOS)) {
    if (pats.some((p) => haystack.includes(` ${p.trim()} `))) out.push(canon)
  }
  return out
}

/**
 * Currencies we can recognise but must NOT silently treat as USD.
 *
 * Measured 2026-09-08: "um caminhao de R$8M" produced deal_size 8,000,000 USD.
 * R$8M is roughly USD 1.5M, so the deal was read as five times its real size
 * and sizeDim hard-excluded every lender whose ceiling sat under $8M — exactly
 * the lenders who could have written it. That is a wrong shortlist, not a miss.
 *
 * Converting would need a live FX rate, and a stale rate is a wrong record. So
 * we recognise the currency, refuse to guess, and say so on screen.
 */
const NON_USD_MARKERS: Array<[string, RegExp]> = [
  ['BRL', /(r\$|\breais\b|\bbrl\b)/i],
  ['EUR', /(€|\beur\b|\beuros?\b)/i],
  ['GBP', /(£|\bgbp\b|\blibras\b)/i],
  ['MXN', /\bmxn\b/i],
  ['CAD', /\bcad\b/i],
  ['CHF', /\bchf\b/i],
  ['JPY', /(¥|\bjpy\b)/i],
]

/** The non-USD currency this query quotes an amount in, if any. */
export function unsupportedCurrency(q: string): string | null {
  // US$ and USD are dollars; strip them before looking, so "US$ 3 milhoes"
  // is not mistaken for something exotic.
  const hay = q.replace(/\bus\$/gi, '$').replace(/\busd\b/gi, '')
  for (const [code, re] of NON_USD_MARKERS) if (re.test(hay)) return code
  return null
}

/** Parse a dollar token like "$8M", "8 million", "500k", "1,200,000" → number. */
function parseAmount(raw: string): number | null {
  const m = raw.toLowerCase().replace(/[$,\s]/g, '').match(
    /^(\d+(?:\.\d+)?)(k|m|mm|b|million|mil|billion|milhoes|milhões|millones|millions|millionen)?$/,
  )
  if (!m) return null
  let n = parseFloat(m[1])
  const unit = m[2]
  // NOTE: 'mil' means MILLION here, an existing English-finance shorthand. It is
  // NOT the Portuguese/Spanish 'mil' (= thousand) and must never be extended to
  // cover it — "800 mil" is R$800k, and reading it as 800 million would exclude
  // every lender in the roster.
  if (unit === 'k') n *= 1_000
  else if (
    unit === 'm' || unit === 'mm' || unit === 'mil' || unit === 'million' ||
    unit === 'milhoes' || unit === 'milhões' || unit === 'millones' ||
    unit === 'millions' || unit === 'millionen'
  ) n *= 1_000_000
  else if (unit === 'b' || unit === 'billion') n *= 1_000_000_000
  return Number.isFinite(n) ? n : null
}

const UNIT = 'k|m|mm|b|million|mil|billion|milhoes|milhões|millones|millions|millionen'

function extractDealSize(q: string): { min: number | null; max: number | null } {
  const lower = ` ${q.toLowerCase()} `

  // A RANGE, with or without the word "between".
  //
  // "$8M-$10M" and "8 to 10 million" used to fall through to the single-amount
  // loop below, which recorded 8,000,000 as BOTH bounds — turning a range into
  // an exact-size constraint and hard-excluding every lender whose window was
  // 9-10M. Measured 2026-09-08. Only "between X and Y" was ever handled.
  const range = lower.match(
    new RegExp(
      `(?:between\\s+)?\\$?\\s*([\\d.,]+\\s*(?:${UNIT})?)\\s*(?:and|to|-|–|—)\\s*\\$?\\s*([\\d.,]+\\s*(?:${UNIT}))`,
      'i',
    ),
  )
  if (range) {
    const a = parseAmount(range[1]); const b = parseAmount(range[2])
    // A bare leading number inherits the trailing unit: "8 to 10 million".
    const a2 = a === null && /^[\d.,]+$/.test(range[1].trim())
      ? parseAmount(`${range[1].trim()}${(range[2].match(new RegExp(UNIT, 'i')) ?? [''])[0]}`)
      : a
    if (a2 !== null && b !== null && a2 !== b) {
      return { min: Math.min(a2, b), max: Math.max(a2, b) }
    }
  }
  // Amounts only count when they carry a `$` or a magnitude unit (k/m/b).
  // A bare number (year "1987", model "350", count "2") is ignored.
  // Qualifiers in EN/PT/ES/FR, and the same UNIT list parseAmount understands —
  // these two had drifted apart, so "US$ 8 milhoes" matched the bare "8", fell
  // under the sub-$1k guard, and the size constraint vanished with no notice.
  const QUAL = 'under|below|up to|max|maximum|less than|no more than|over|above|at least|min|minimum|more than|north of|around|about|approximately|~|ate|até|hasta|menos de|mas de|más de|acima de|al menos|environ|jusqu\'a'
  const amtRe = new RegExp(
    `(${QUAL})?\\s*(?:\\$\\s*(\\d[\\d.,]*)\\s*(${UNIT})?(?![a-z])|(\\d[\\d.,]*)\\s*(${UNIT})(?![a-z]))`,
    'gi',
  )
  let min: number | null = null
  let max: number | null = null
  let m: RegExpExecArray | null
  while ((m = amtRe.exec(lower)) !== null) {
    const amt = m[2] !== undefined
      ? parseAmount(`${m[2]}${m[3] ?? ''}`)
      : parseAmount(`${m[4]}${m[5]}`)
    if (amt === null || amt < 1000) continue // ignore sub-$1k
    let qual = (m[1] ?? '').trim()
    // Qualifiers also come AFTER the amount — "$5M max", "$5M or less", "$3M+".
    // Only a leading qualifier was read, so "$5M max" became an exact $5M deal
    // and excluded every lender whose range topped out below it.
    if (!qual) {
      const tail = lower.slice(m.index + m[0].length, m.index + m[0].length + 14)
      if (/^\s*(?:or\s+)?(?:max|maximum|or less|and under|and below|ceiling)\b/.test(tail)) qual = 'max'
      else if (/^\s*(?:\+|or\s+more|and\s+up|minimum|min|and\s+above)\b/.test(tail)) qual = 'min'
    }
    const MAXQ = ['under', 'below', 'up to', 'max', 'maximum', 'less than', 'no more than',
      'ate', 'até', 'hasta', 'menos de', "jusqu'a"]
    const MINQ = ['over', 'above', 'at least', 'min', 'minimum', 'more than', 'north of',
      'mas de', 'más de', 'acima de', 'al menos']
    if (MAXQ.includes(qual)) {
      max = max === null ? amt : Math.max(max, amt)
    } else if (MINQ.includes(qual)) {
      min = min === null ? amt : Math.min(min, amt)
    } else {
      // bare or "around" → treat as target deal size (both bounds)
      if (min === null) min = amt
      if (max === null) max = amt
    }
  }
  return { min, max }
}

function extractModels(q: string): string[] {
  const lower = q.toLowerCase()
  const out = new Set<string>()
  if (ASSET_MAKES.length === 0) return []
  // make + alphanumeric designator: "caterpillar 320", "john deere 8r", "komatsu pc210"
  const re = new RegExp(
    `\\b(${ASSET_MAKES.map(escapeRe).join('|')})\\s+([a-z]{0,3}\\d{1,4}[a-z]{0,3})\\b`,
    'g',
  )
  let m: RegExpExecArray | null
  while ((m = re.exec(lower)) !== null) out.add(`${m[1]} ${m[2]}`.trim())
  return Array.from(out)
}

// Usage codes the deal states (owner-operated, leased out, rental …), from
// config. Boost-only downstream, so a loose match is safe; keywords still match
// as whole words (space-padded) so they cannot fire inside a longer word.
function extractUsageCodes(hay: string): string[] {
  return USAGE_CODES.filter((u) => u.keywords.some((k) => hay.includes(` ${k} `))).map(
    (u) => u.code,
  )
}

// Operation category, if the deal states one: the first configured category
// (other than the combined one, which has no keywords) whose keyword appears.
function extractOperationCategory(hay: string): string | null {
  const hit = OPERATION_CATEGORIES.find(
    (o) => o.keywords.length > 0 && o.keywords.some((k) => hay.includes(k)),
  )
  return hit ? hit.value : null
}

// Lender KIND, only when the query EXPLICITLY asks for a lender of that kind.
// This is the one field allowed to hard-exclude, so arming it on an incidental
// mention would collapse the shortlist ("borrower backed by private equity" is
// about the borrower, not the desired lender). Three phrasings count as an ask:
// a following lender noun ("credit union lender"), a preceding request verb
// ("need a credit union"), or SUBJECT POSITION — the query leads with the kind
// and then aims it ("Bank for North Carolina rental fleet deal, $8M").
// Anything else is an incidental mention and is ignored, because
// missing a real ask is far safer than a wrong exclusion.
const LENDER_NOUN =
  /^\s*\W*(lender|lenders|financing|finance|financier|source|sources|fund|funds|funder|funders|lending|institution)\b/
const LENDER_INTENT_BEFORE =
  /\b(prefer|prefers|want|wants|need|needs|find|seeking|seek|use|using|only|through|from|via|looking for)\b[\sa-z]{0,12}$/
// Subject position aims the kind at the rest of the query. "of" is deliberately
// NOT a target: "Bank of Adhara" is a company name, not a request for banks.
const LENDER_TARGET_AFTER =
  /^\s*\W*(for|in|that|who|serving|covering|doing|to)\b/
function extractLenderTypeRequired(hay: string): string | null {
  // Order matters: "non-bank" must be tested before "bank", or the bare-bank
  // pattern would swallow it and invert the ask.
  const kinds: Array<[string, RegExp]> = [
    ['credit union', /credit[-\s]?union/],
    ['non-bank', /non[-\s]?bank/],
    ['private equity', /private[-\s]?equity/],
    ['bank', /\bbanks?\b/],
  ]
  for (const [label, re] of kinds) {
    const m = re.exec(hay)
    if (!m) continue
    const after = hay.slice(m.index + m[0].length, m.index + m[0].length + 28)
    const before = hay.slice(Math.max(0, m.index - 28), m.index)
    // "bank" is also a company-name word — "Castor Bank", "Bank of Adhara",
    // "Rigel Bank contact". Never arm it from the tail of a name.
    if (label === 'bank' && /\bnon[-\s]?$/.test(before)) continue
    if (LENDER_NOUN.test(after) || LENDER_INTENT_BEFORE.test(before)) return label
    if (before.trim() === '' && LENDER_TARGET_AFTER.test(after)) return label
  }
  return null
}

export function extractDeal(query: string): DealExtract {
  const hay = pad(query)
  const hayLoose = padLoose(query)
  const assetSet = new Set<string>()
  for (const [cls, kws] of Object.entries(ASSET_KEYWORDS)) {
    if (kws.some((k) => hay.includes(k))) assetSet.add(cls)
  }
  for (const [cls, makes] of Object.entries(ASSET_MAKES_BY_CLASS)) {
    if (makes.some((mk) => hasWord(hay, mk))) assetSet.add(cls)
  }
  const asset_classes = [...assetSet].filter((c) =>
    (ASSET_CLASSES as readonly string[]).includes(c),
  )

  const usStates = dropShadowedMatches(hay, matchDict(hay, US_STATES), US_STATES)
  const usRegions = matchDict(hay, US_REGIONS_COUNTRY)
  const hasUsGeo = usStates.length > 0 || usRegions.length > 0
  // Foreign geos are matched WHOLE-TOKEN (above). And if the deal explicitly
  // names a US state/region we treat it as DOMESTIC and drop any foreign-town-name
  // collision ("Panama City, Florida", "Peru, Illinois") so we never wrongly
  // hard-exclude valid domestic lenders for a US deal. Both directions matter
  // under "no wrong lender, ever".
  const foreignGeos = hasUsGeo ? [] : matchForeignGeos(hayLoose)
  const geographic_scope = [...usStates, ...usRegions, ...foreignGeos]
  const industry_filters = BORROWER_INDUSTRIES.filter((i) => hay.includes(` ${i} `) || hay.includes(`${i} `))
  const asset_families = ASSET_MAKES.filter((f) => hasWord(hay, f))
  const asset_models = extractModels(query)
  const parsedSize = extractDealSize(query)
  let min = parsedSize.min
  let max = parsedSize.max
  let deal_size_confidence: Confidence = 'stated'
  let deal_size_basis: string | null = null
  let size_currency_unsupported: string | null = null
  let size_unit_ambiguous: string | null = null

  const fx = unsupportedCurrency(query)
  const milMatch = /(\d[\d.,]*)\s*mil\b(?!h)/i.exec(query)

  if (fx) {
    // A foreign amount is converted only if somebody has supplied a dated rate
    // (money.ts FX_RATES, empty by default — this repo cannot know a rate, and a
    // stale one silently mis-sizes every foreign deal). Converted or not, the
    // result never hard-excludes.
    const lo = min !== null ? convertToUsd(min, fx) : null
    const hi = max !== null ? convertToUsd(max, fx) : null
    if (lo || hi) {
      min = lo ? lo.usd : null
      max = hi ? hi.usd : null
      deal_size_confidence = 'inferred'
      const r = (lo ?? hi)!
      deal_size_basis = `converted from ${fx} at ${r.rate} per USD (rate of ${r.asOf}) — used for ranking only`
    } else {
      min = null
      max = null
      size_currency_unsupported = fx
    }
  } else if (milMatch && min !== null && min === max) {
    // "mil" is million in English finance and thousand in Portuguese.
    // Settle it against what the roster can actually fund rather than by
    // guessing the writer's language; downgrade to ranking when both readings
    // are fundable. See resolveMilAmount.
    const n = parseFloat(milMatch[1].replace(/,/g, ''))
    if (Number.isFinite(n)) {
      const r = resolveMilAmount(n, { iberian: looksIberian(query) })
      min = r.usd
      max = r.usd
      deal_size_confidence = r.confidence
      deal_size_basis = r.basis
      if (r.confidence === 'inferred') size_unit_ambiguous = 'mil'
    }
  }
  // International intent engages on either a generic "international/overseas/…"
  // keyword OR a specific recognised foreign country/region (the foreign-geography fix: a
  // named foreign country hard-excludes a Domestic-only lender even when that
  // lender's stated geography is blank). Suppressed when the deal also names a US
  // location (handled above — foreignGeos is empty in that case).
  const namedForeignGeo = foreignGeos.some((g) => FOREIGN_GEO_NAMES.has(g))
  const intl_required = namedForeignGeo || INTL_KEYWORDS.some((k) => hay.includes(k))
  const assetYear = extractAssetYear(
    query,
    asset_classes.length > 0 || asset_families.length > 0 || asset_models.length > 0,
  )
  const asset_year = assetYear.year

  return {
    semantic_query: query.trim(),
    asset_year,
    asset_year_confidence: assetYear.confidence,
    asset_year_basis: assetYear.basis,
    size_currency_unsupported,
    size_unit_ambiguous,
    deal_size_confidence,
    deal_size_basis,
    us_states: [],
    asset_classes,
    deal_size_min_usd: min,
    deal_size_max_usd: max,
    geographic_scope,
    industry_filters,
    asset_families,
    asset_models,
    intl_required,
    usage_codes: extractUsageCodes(hay),
    operation_category: extractOperationCategory(hay),
    lender_type_required: extractLenderTypeRequired(hay),
  }
}
