/**
 * Does a word the model called "a place" actually name one?
 *
 * Why this exists: the verbatim-quote gate in signals.ts checks that the
 * SENTENCE is real. It does not check that the place the model attached to that
 * sentence is real, or that the sentence even mentions it. A small local model
 * makes both mistakes:
 *
 *   notes "Will not finance collateral outside the US or Canada" — reported
 *   `avoids: India`. India appears nowhere in the record. The quote it cited
 *   was real, so the quote gate passed it.
 *
 *   notes "No units older than ten years" — reported `avoids: "No units"`.
 *   Not a place at all.
 *
 * Both are caught here, deterministically, without asking the model again:
 * a place must resolve to a geography this codebase already knows, and it must
 * appear in the sentence it claims to come from.
 *
 * The vocabulary is deliberately the SAME one the matcher uses — FOREIGN_GEOS
 * and the fifty states — because a place that resolves here and not there would
 * be a signal that can never match anything, and a place that resolves there and
 * not here would be silently unwritable. Two vocabularies for one comparison is
 * the bug that put a lender on a Louisiana shortlist it did not belong on.
 */

import { FOREIGN_GEOS, FOREIGN_REGIONS } from '@/lib/search/countries'
import { ASSET_CATEGORIES } from '@/lib/config/domain'

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
const US_STATE_NAMES = new Set(Object.values(US_STATE_CODES))

/** US multi-state regions the notes actually use — "Southeast", "Mid West". */
const US_REGIONS = new Set([
  'midwest', 'mid west', 'northeast', 'north east', 'southeast', 'south east',
  'southwest', 'south west', 'northwest', 'north west', 'west coast', 'east coast',
  'new england', 'pacific northwest',
])

const norm = (s: string) => s.toLowerCase().trim()

/**
 * The canonical form of a place the notes name, or null when it names none.
 *
 * Accepts a state name, an uppercase two-letter state code, a US region, a
 * country or region in FOREIGN_GEOS. Rejects everything else — including "US",
 * "United States" and "domestic", which are coverage categories rather than
 * places and would make every lender "prefer" the whole country.
 */
export function canonicalNotePlace(raw: string): string | null {
  const s = norm(raw)
  if (!s) return null

  if (US_STATE_NAMES.has(s)) return s
  if (US_REGIONS.has(s)) return s

  const code = raw.trim().toUpperCase()
  if (code.length === 2 && US_STATE_CODES[code]) return US_STATE_CODES[code]

  for (const name of Object.keys(FOREIGN_GEOS)) {
    if (norm(name) === s) return name
  }
  for (const [name, patterns] of Object.entries(FOREIGN_GEOS)) {
    if (patterns.some((p) => norm(p) === s)) return name
  }
  for (const name of Object.keys(FOREIGN_REGIONS)) {
    if (norm(name) === s) return name
  }
  return null
}

/**
 * Word-boundary-safe containment, so "IN" (Indiana) does not match inside
 * "financing" and "Oman" does not match inside "Romania".
 */
const padded = (s: string) => ` ${s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `

/**
 * Does the sentence the model cited actually mention the place it reported?
 *
 * A two-letter state code only counts when it is UPPERCASE in the raw sentence,
 * which is the same rule `usStatesNamedBy` applies for the same reason. Matching
 * it case-insensitively made ` in `, ` or `, ` me `, ` hi ` and ` la ` into valid
 * mentions of Indiana, Oregon, Maine, Hawaii and Louisiana — so "Will not finance
 * collateral outside the US or Canada" satisfied the gate for `place: Oregon`, which is
 * precisely the class of read this gate was built to stop.
 */
export function quoteMentionsPlace(quote: string, rawPlace: string, canonical: string): boolean {
  const hay = padded(quote)

  // Case-insensitive candidates: full names and country synonyms, all of which
  // are long enough that an accidental match is not a real risk.
  const loose = new Set<string>([canonical])
  const rawNorm = norm(rawPlace)
  if (rawNorm.length > 2) loose.add(rawNorm)
  for (const p of FOREIGN_GEOS[canonical] ?? []) loose.add(norm(p))
  if ([...loose].some((c) => c.length > 0 && hay.includes(` ${c} `))) return true

  // Two-letter codes: uppercase in the original sentence only.
  const upper = ` ${quote.replace(/[^A-Za-z0-9]+/g, ' ').trim()} `
  for (const [code, name] of Object.entries(US_STATE_CODES)) {
    if (name === canonical && upper.includes(` ${code} `)) return true
  }
  return false
}

/**
 * Words that make a sentence a refusal.
 *
 * Required on the `avoids` side only. A sentence with no negation in it cannot
 * be evidence that a lender will not lend somewhere, whatever the model decided
 * — "Headquartered in San Diego, California" is not an avoidance of California.
 *
 * This does NOT solve negation SCOPE, and nothing deterministic can: "Will not
 * finance collateral outside the US or Canada" contains both a negation and
 * Canada, and means Canada is allowed. That residual error is why an avoid
 * signal may only demote, never exclude, and why the sentence is printed next
 * to the lender — a human reading it on a Canada search sees the mistake
 * immediately and can correct the record.
 */
const NEGATION = /\b(?:no|not|non|never|cannot|can't|cant|won't|wont|doesn't|does not|don't|dont|excluding|exclude|except|avoid|avoids|unable|unwilling|refuse|declin\w*|prohibit\w*)\b/i

/**
 * Phrases that mean the lender WILL look at something, which override a
 * negation word elsewhere in the same sentence.
 *
 * Example: "Can consider borrowers outside Montana, not just in-state" is a
 * Montana bank saying it will go BEYOND Montana. Read as an avoidance it demotes
 * a Montana bank on Montana searches — an inversion, strictly worse than having
 * no signal at all.
 *
 * Two changes came out of it. `outside` left the negation list entirely, because
 * "outside of X" and "applicants outside X" mean opposite things and no
 * word-level test separates them. And an explicit affirmative beats a negation:
 * "can consider" cannot be a refusal, whatever else the sentence contains.
 *
 * `\bcan\b` does not match "cannot", so "cannot consider india" is untouched.
 */
const AFFIRMATIVE =
  /\b(?:can|will|may|would|do)\s+(?:also\s+)?(?:consider|do|look\s+at|entertain|finance|fund|lend)\b|\bacceptable\b|\bcase[- ]by[- ]case\b/i

export function quoteReadsAsRefusal(quote: string): boolean {
  if (AFFIRMATIVE.test(quote)) return false
  return NEGATION.test(quote)
}

/**
 * Words that count as naming an asset, so the same "does the sentence actually
 * say this?" test applies to `assets` as to places.
 *
 * Without it the asset gate checked only that the QUOTE was real. A lender
 * came back with an asset on a sentence that never mentions it — the identical
 * failure the place gate was added for, one field over.
 *
 * The words come from src/lib/config/vocabulary.ts: a class's label, keywords and
 * makes, each also accepted with a plural "s".
 */
const ASSET_WORDS: Record<string, string[]> = Object.fromEntries(
  ASSET_CATEGORIES.map((c) => [
    c.id,
    [c.label, ...c.keywords, ...(c.makes ?? [])].map((w) => padded(w).trim()).filter(Boolean),
  ]),
)

export function quoteMentionsAsset(quote: string, asset: string): boolean {
  const hay = padded(quote)
  const words = ASSET_WORDS[asset.toLowerCase().trim()]
  if (!words) return false
  return words.some((w) => hay.includes(` ${w} `) || hay.includes(` ${w}s `))
}

/**
 * Phrases that actually say lending has stopped.
 *
 * With no gate beyond "the quote is real", a small model marks most
 * signal-bearing lenders paused, on quotes about rates, LTV or asset age, while
 * only a handful of notes contain pause language. A "Check status" chip on a
 * third of the index is noise, and noise on an accuracy surface is worse than
 * silence — users learn to ignore the chip, including the few times it is right.
 *
 * The few it is right about are the ones that matter, because their
 * `lending_status` cell does NOT say No: "stopped funding new loans", "Done
 * lending for now", "New deals on hold this quarter".
 */
const LENDING_PAUSE =
  /\b(?:not\s+lending|no\s+longer\s+lending|not\s+currently\s+lending|stopped\s+(?:lending|funding|renewing)|paused\s+lending|lending\s+paused|on\s+hold|done\s+lending|shut(?:ting)?\s+down|ceased|exited|wind(?:ing)?\s+down|wound\s+down|suspended|no\s+longer\s+active|not\s+active)\b/i

export function quoteReadsAsLendingPause(quote: string): boolean {
  return LENDING_PAUSE.test(quote)
}

/**
 * Which states each US region covers.
 *
 * `canonicalNotePlace` accepts "Southeast" and "Mid West" because notes use
 * them — a note can be just the word "Southeast", or "Prefers TN deals and the
 * South East". Without this table those signals were stored and then matched
 * nothing, which is the worst of both: the cost of reading them and none of the
 * benefit, and a `prefers` chip that could never appear.
 *
 * Census divisions, widened where common usage is plainly wider (brokers often
 * count KY and WV as Southeast). A region is a preference, never an exclusion,
 * so an over-wide member list costs ordering and nothing else.
 */
const REGION_STATES: Record<string, readonly string[]> = {
  southeast: [
    'alabama', 'arkansas', 'florida', 'georgia', 'kentucky', 'louisiana',
    'mississippi', 'north carolina', 'south carolina', 'tennessee', 'virginia',
    'west virginia',
  ],
  northeast: [
    'connecticut', 'maine', 'massachusetts', 'new hampshire', 'new jersey',
    'new york', 'pennsylvania', 'rhode island', 'vermont',
  ],
  midwest: [
    'illinois', 'indiana', 'iowa', 'kansas', 'michigan', 'minnesota', 'missouri',
    'nebraska', 'north dakota', 'ohio', 'south dakota', 'wisconsin',
  ],
  southwest: ['arizona', 'new mexico', 'oklahoma', 'texas'],
  northwest: ['idaho', 'montana', 'oregon', 'washington', 'wyoming'],
  'west coast': ['california', 'oregon', 'washington'],
  'east coast': [
    'connecticut', 'delaware', 'florida', 'georgia', 'maine', 'maryland',
    'massachusetts', 'new hampshire', 'new jersey', 'new york', 'north carolina',
    'rhode island', 'south carolina', 'virginia',
  ],
  'new england': [
    'connecticut', 'maine', 'massachusetts', 'new hampshire', 'rhode island',
    'vermont',
  ],
  'pacific northwest': ['idaho', 'oregon', 'washington'],
}

/** Aliases that canonicalNotePlace accepts, folded onto one key each. */
const REGION_ALIAS: Record<string, string> = {
  'mid west': 'midwest',
  'south east': 'southeast',
  'north east': 'northeast',
  'south west': 'southwest',
  'north west': 'northwest',
}

/** True when `place` is a US region and `state` is one of its states. */
export function usRegionCovers(place: string, state: string): boolean {
  const key = norm(place)
  const members = REGION_STATES[REGION_ALIAS[key] ?? key]
  if (!members) return false
  return members.includes(norm(state))
}
