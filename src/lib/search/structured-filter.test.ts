import { describe, it, expect } from 'vitest'
import { scoreFit, rankByFit, hasContradiction, type DealCriteria } from './structured-filter'
import { extractDeal } from './extract-deal'

/** Bridge extractDeal → DealCriteria the way run.ts does, for end-to-end checks. */
function dealFromQuery(q: string): DealCriteria {
  const ex = extractDeal(q)
  return {
    asset_classes: ex.asset_classes,
    geographic_scope: ex.geographic_scope,
    deal_size_min_usd: ex.deal_size_min_usd,
    deal_size_max_usd: ex.deal_size_max_usd,
    intl_required: ex.intl_required,
  }
}

const NO: DealCriteria = {
  asset_classes: [],
  geographic_scope: [],
  deal_size_min_usd: null,
  deal_size_max_usd: null,
  intl_required: false,
}

describe('geo — stated location is a hard constraint', () => {
  it('blank lender geo = unknown (kept)', () => {
    const v = scoreFit({ geographic_scope: [] }, { ...NO, geographic_scope: ['Brazil'] })
    expect(v.geo).toBe('unknown')
    expect(hasContradiction(v)).toBe(false)
  })
  it('US-only lender CONTRADICTS a Brazil deal', () => {
    const v = scoreFit({ geographic_scope: ['All Domestic including AK and HI'] }, { ...NO, geographic_scope: ['Brazil'] })
    expect(v.geo).toBe('contradict')
    expect(hasContradiction(v)).toBe(true)
  })
  it('UK lender CONTRADICTS a Brazil deal', () => {
    expect(scoreFit({ geographic_scope: ['UK'] }, { ...NO, geographic_scope: ['Brazil'] }).geo).toBe('contradict')
  })
  it('domestic lender MATCHES a Texas deal (synonym-aware, no false exclude)', () => {
    expect(scoreFit({ geographic_scope: ['All Domestic including AK and HI'] }, { ...NO, geographic_scope: ['Texas'] }).geo).toBe('match')
  })
  it('worldwide lender MATCHES a Brazil deal', () => {
    expect(scoreFit({ geographic_scope: ['Worldwide'] }, { ...NO, geographic_scope: ['Brazil'] }).geo).toBe('match')
  })
  it('exact country match works', () => {
    expect(scoreFit({ geographic_scope: ['Brazil', 'Latin America'] }, { ...NO, geographic_scope: ['Brazil'] }).geo).toBe('match')
  })
})

describe('asset + size hard constraints', () => {
  it('non-construction lender contradicts a construction_equipment deal', () => {
    const v = scoreFit({ asset_classes: ['medical_equipment', 'agricultural_equipment'] }, { ...NO, asset_classes: ['construction_equipment'] })
    expect(v.asset).toBe('contradict')
  })
  it('$4M-max lender contradicts an $8M deal', () => {
    const v = scoreFit({ deal_size_min_usd: 1_000_000, deal_size_max_usd: 4_000_000 }, { ...NO, deal_size_min_usd: 8_000_000, deal_size_max_usd: 8_000_000 })
    expect(v.size).toBe('contradict')
  })
  it('blank asset/size = unknown (kept)', () => {
    const v = scoreFit({ asset_classes: null, deal_size_min_usd: null, deal_size_max_usd: null }, { ...NO, asset_classes: ['construction_equipment'], deal_size_min_usd: 8_000_000 })
    expect(v.asset).toBe('unknown')
    expect(v.size).toBe('unknown')
    expect(hasContradiction(v)).toBe(false)
  })
})

describe('asset hierarchy — a generic parent matches its specific children', () => {
  const ac = (v: string[]): DealCriteria => ({ ...NO, asset_classes: v })
  it('a generic "equipment" deal MATCHES specific-type lenders (no wrong exclude)', () => {
    expect(scoreFit({ asset_classes: ['construction_equipment'] }, ac(['equipment'])).asset).toBe('match')
    expect(scoreFit({ asset_classes: ['medical_equipment'] }, ac(['equipment'])).asset).toBe('match')
    expect(scoreFit({ asset_classes: ['agricultural_equipment'] }, ac(['equipment'])).asset).toBe('match')
  })
  it('a specific-type deal matches a generic "equipment" lender (reverse)', () => {
    expect(scoreFit({ asset_classes: ['equipment'] }, ac(['construction_equipment'])).asset).toBe('match')
  })
  it('generic "equipment" does NOT match another family (vehicles / real_estate)', () => {
    expect(scoreFit({ asset_classes: ['vehicles'] }, ac(['equipment'])).asset).toBe('contradict')
    expect(scoreFit({ asset_classes: ['real_estate'] }, ac(['equipment'])).asset).toBe('contradict')
  })
  it('two DIFFERENT specific types still contradict (agricultural deal ≠ construction lender)', () => {
    expect(scoreFit({ asset_classes: ['construction_equipment'] }, ac(['agricultural_equipment'])).asset).toBe('contradict')
  })
  it('blank lender asset = unknown (kept)', () => {
    expect(scoreFit({ asset_classes: [] }, ac(['equipment'])).asset).toBe('unknown')
  })

  it('a typical query — CA 20yr equipment $10M keeps CA equipment lenders, drops vehicles + wrong-size', () => {
    const deal = dealFromQuery('CA, 20 year old equipment, owner operated, $10,000,000')
    expect(deal.asset_classes).toContain('equipment')
    expect(deal.geographic_scope).toContain('California')
    expect(deal.deal_size_min_usd).toBe(10_000_000)
    const rows = [
      { id: 'construction-ca', asset_classes: ['construction_equipment'], geographic_scope: ['California'], deal_size_min_usd: 1_000_000, deal_size_max_usd: 50_000_000 },
      { id: 'medical-dom', asset_classes: ['medical_equipment'], geographic_scope: ['All Domestic incl AK/HI'], deal_size_min_usd: null, deal_size_max_usd: null },
      { id: 'vehicles-ca', asset_classes: ['vehicles'], geographic_scope: ['California'], deal_size_min_usd: null, deal_size_max_usd: null },
      { id: 'construction-toosmall', asset_classes: ['construction_equipment'], geographic_scope: ['California'], deal_size_min_usd: 100_000, deal_size_max_usd: 4_000_000 },
    ]
    const fused = new Map(rows.map((r, i) => [r.id, i]))
    const out = rankByFit(rows, deal, fused).map((r) => r.id)
    expect(out).toContain('construction-ca') // equipment family + CA + size ok
    expect(out).toContain('medical-dom') // medical + domestic + blank size (kept)
    expect(out).not.toContain('vehicles-ca') // vehicles ≠ equipment
    expect(out).not.toContain('construction-toosmall') // $4M max can't do $10M
  })

  // Auditor regression: extract-deal.ts co-fires the generic 'equipment' tag
  // alongside a specific type ("construction equipment" → ['equipment',
  // 'construction_equipment'] via the shared word). The co-fired generic must
  // NOT wildcard away the specific type, or a sibling-only lender wrongly matches.
  it('a SPECIFIC-type query (via extractDeal) still hard-excludes a sibling-type lender', () => {
    for (const [q, sibling] of [
      ['construction equipment financing in Texas, $5,000,000', 'agricultural_equipment'],
      ['need a medical equipment loan', 'construction_equipment'],
      ['farm equipment and machinery for a dairy', 'medical_equipment'],
    ]) {
      const deal = dealFromQuery(q)
      expect(deal.asset_classes).toContain('equipment') // proves the co-fire happens
      expect(deal.asset_classes.some((a) => a !== 'equipment')).toBe(true) // + a specific type
      expect(scoreFit({ asset_classes: [sibling] }, deal).asset).toBe('contradict')
    }
  })
  it('a specific-type query still matches its own type and a generic-equipment lender', () => {
    const deal = dealFromQuery('construction equipment financing in Texas, $5,000,000')
    expect(scoreFit({ asset_classes: ['construction_equipment'] }, deal).asset).toBe('match')
    expect(scoreFit({ asset_classes: ['equipment'] }, deal).asset).toBe('match') // generic lender does construction
  })
})

describe('a second family — vehicles / commercial_trucks', () => {
  it('a truck deal matches truck and generic-vehicle lenders, NOT equipment lenders', () => {
    const deal = dealFromQuery('$4M semi truck deal')
    expect(deal.asset_classes).toContain('commercial_trucks')
    expect(scoreFit({ asset_classes: ['commercial_trucks'] }, deal).asset).toBe('match')
    expect(scoreFit({ asset_classes: ['vehicles'] }, deal).asset).toBe('match')
    expect(scoreFit({ asset_classes: ['equipment'] }, deal).asset).toBe('contradict')
    expect(scoreFit({ asset_classes: ['construction_equipment'] }, deal).asset).toBe('contradict')
  })
  it('a generic vehicle deal reaches a truck-only lender', () => {
    const deal = dealFromQuery('vehicle financing, $2,000,000')
    expect(deal.asset_classes).toEqual(['vehicles'])
    expect(scoreFit({ asset_classes: ['commercial_trucks'] }, deal).asset).toBe('match')
  })
  it('a generic equipment deal does NOT reach a truck-only lender', () => {
    const deal = dealFromQuery('20 year old equipment, $10,000,000')
    expect(scoreFit({ asset_classes: ['commercial_trucks'] }, deal).asset).toBe('contradict')
    expect(scoreFit({ asset_classes: ['construction_equipment'] }, deal).asset).toBe('match') // same family still matches
  })
})

describe('intl — "international lender" hard-excludes Domestic-only', () => {
  const INTL: DealCriteria = { ...NO, intl_required: true }
  it('Domestic-stated lender CONTRADICTS an international ask', () => {
    const v = scoreFit({ intl_domestic: 'Domestic' }, INTL)
    expect(v.intl).toBe('contradict')
    expect(hasContradiction(v)).toBe(true)
  })
  it('International / Both lender MATCHES', () => {
    expect(scoreFit({ intl_domestic: 'International' }, INTL).intl).toBe('match')
    expect(scoreFit({ intl_domestic: 'Both' }, INTL).intl).toBe('match')
  })
  it('blank intl_domestic + US-only geo → contradict', () => {
    expect(scoreFit({ intl_domestic: null, geographic_scope: ['All Domestic'] }, INTL).intl).toBe('contradict')
  })
  it('blank intl_domestic + blank geo → unknown (kept)', () => {
    const v = scoreFit({ intl_domestic: null, geographic_scope: [] }, INTL)
    expect(v.intl).toBe('unknown')
    expect(hasContradiction(v)).toBe(false)
  })
  it('no intl requirement → intl dim is unknown for everyone', () => {
    expect(scoreFit({ intl_domestic: 'Domestic' }, NO).intl).toBe('unknown')
  })
  it('rankByFit drops Domestic-only lenders for an international deal', () => {
    const rows = [
      { id: 'dom', intl_domestic: 'Domestic' },
      { id: 'intl', intl_domestic: 'International' },
      { id: 'both', intl_domestic: 'Both' },
      { id: 'blank', intl_domestic: null, geographic_scope: [] },
    ]
    const fused = new Map([['dom', 0], ['intl', 1], ['both', 2], ['blank', 3]])
    const out = rankByFit(rows, INTL, fused).map((r) => r.id)
    expect(out).not.toContain('dom')
    expect(out).toContain('intl')
    expect(out).toContain('both')
    expect(out).toContain('blank')
  })
})

describe('rankByFit — excludes contradictions, keeps unknowns', () => {
  const deal: DealCriteria = { ...NO, geographic_scope: ['Brazil'] }

  it('drops US-only lenders, keeps blank-geo + Brazil lenders', () => {
    const rows = [
      { id: 'blank', geographic_scope: [] },
      { id: 'brazil', geographic_scope: ['Brazil'] },
      { id: 'usonly', geographic_scope: ['All Domestic including AK and HI'] },
      { id: 'uk', geographic_scope: ['UK'] },
    ]
    const fused = new Map([['blank', 0], ['brazil', 1], ['usonly', 2], ['uk', 3]])
    const out = rankByFit(rows, deal, fused).map((r) => r.id)
    expect(out).toContain('brazil')
    expect(out).toContain('blank')
    expect(out).not.toContain('usonly')
    expect(out).not.toContain('uk')
  })

  it('orders match above unknown, fused rank as tiebreak', () => {
    const rows = [
      { id: 'blank', geographic_scope: [] },        // unknown, fused 0
      { id: 'brazil', geographic_scope: ['Brazil'] }, // match,   fused 1
    ]
    const fused = new Map([['blank', 0], ['brazil', 1]])
    expect(rankByFit(rows, deal, fused).map((r) => r.id)).toEqual(['brazil', 'blank'])
  })

  it('asset/size contradictions are HARD — excluded (hide all that do not fit)', () => {
    const d: DealCriteria = { ...NO, asset_classes: ['construction_equipment'], deal_size_min_usd: 8_000_000, deal_size_max_usd: 8_000_000 }
    const rows = [
      { id: 'wrongsize', asset_classes: ['construction_equipment'], deal_size_min_usd: 1_000_000, deal_size_max_usd: 4_000_000 }, // size contradict
      { id: 'wrongasset', asset_classes: ['agricultural_equipment'], deal_size_min_usd: 5_000_000, deal_size_max_usd: 20_000_000 }, // asset contradict
      { id: 'good', asset_classes: ['construction_equipment'], deal_size_min_usd: 5_000_000, deal_size_max_usd: 20_000_000 },     // both match
      { id: 'blank', asset_classes: [], deal_size_min_usd: null, deal_size_max_usd: null },                            // unknown → kept
    ]
    const fused = new Map([['wrongsize', 0], ['wrongasset', 1], ['good', 2], ['blank', 3]])
    const out = rankByFit(rows, d, fused).map((r) => r.id)
    expect(out).not.toContain('wrongsize')
    expect(out).not.toContain('wrongasset')
    expect(out).toContain('good')
    expect(out).toContain('blank') // unknown kept
    expect(out[0]).toBe('good')    // clean match first
  })
})

describe('rank signals — boost, never wrongly exclude (tribal-knowledge safe)', () => {
  it('usage boosts a matching lender but NEVER excludes a non-listing one', () => {
    const deal: DealCriteria = { ...NO, usage_codes: ['lease'] }
    const matches = scoreFit({ usage_codes: 'owner, lease' }, deal)
    const others = scoreFit({ usage_codes: 'owner' }, deal) // lists only owner — may still do lease
    const blank = scoreFit({ usage_codes: null }, deal)
    expect(matches.usage).toBe('match')
    expect(others.usage).toBe('unknown') // NOT contradict — absence is not a "no"
    expect(blank.usage).toBe('unknown')
    expect(hasContradiction(others)).toBe(false)
    expect(matches.score).toBeGreaterThan(others.score) // boosted above
  })

  it('operation category boosts on match, never excludes', () => {
    const deal: DealCriteria = { ...NO, operation_category: 'Commercial' }
    expect(scoreFit({ operation_category: 'Personal, Commercial' }, deal).operation).toBe('match')
    const personal = scoreFit({ operation_category: 'Personal' }, deal)
    expect(personal.operation).toBe('unknown')
    expect(hasContradiction(personal)).toBe(false)
  })

  it('lender_type EXCLUDES only when the query explicitly asked for a kind', () => {
    const asked: DealCriteria = { ...NO, lender_type_required: 'credit union' }
    // asked + different stated kind → contradict (excluded)
    const bank = scoreFit({ lender_type: 'Bank' }, asked)
    expect(bank.lenderType).toBe('contradict')
    expect(hasContradiction(bank)).toBe(true)
    // asked + matching kind → match
    expect(scoreFit({ lender_type: '(C) Credit Union' }, asked).lenderType).toBe('match')
    // asked + blank lender kind → unknown (kept — never guessed out)
    const blank = scoreFit({ lender_type: null }, asked)
    expect(blank.lenderType).toBe('unknown')
    expect(hasContradiction(blank)).toBe(false)
    // NOT asked → lender_type never excludes anyone
    expect(scoreFit({ lender_type: 'Bank' }, NO).lenderType).toBe('unknown')
  })

  it('non-bank request excludes ONLY banks — credit unions + PE are non-bank, kept', () => {
    const asked: DealCriteria = { ...NO, lender_type_required: 'non-bank' }
    expect(hasContradiction(scoreFit({ lender_type: 'Bank' }, asked))).toBe(true)
    expect(scoreFit({ lender_type: 'Non Bank' }, asked).lenderType).toBe('match')
    expect(scoreFit({ lender_type: 'NB' }, asked).lenderType).toBe('match')
    // A credit union and a PE fund ARE non-bank — must be kept, not excluded.
    expect(scoreFit({ lender_type: 'Credit Union' }, asked).lenderType).toBe('match')
    expect(scoreFit({ lender_type: 'Private Equity' }, asked).lenderType).toBe('match')
    expect(hasContradiction(scoreFit({ lender_type: 'Credit Union' }, asked))).toBe(false)
    expect(hasContradiction(scoreFit({ lender_type: 'Private Equity' }, asked))).toBe(false)
  })

  it('rank boosts never override a hard contradiction (still excluded)', () => {
    // a wrong-asset lender that happens to match usage + operation must STILL be excluded
    const deal: DealCriteria = { ...NO, asset_classes: ['construction_equipment'], usage_codes: ['lease'], operation_category: 'Commercial' }
    const v = scoreFit(
      { asset_classes: ['agricultural_equipment'], usage_codes: 'lease', operation_category: 'Commercial' },
      deal
    )
    expect(v.asset).toBe('contradict')
    expect(hasContradiction(v)).toBe(true)
  })
})

describe('END-TO-END — off-list foreign deal hard-excludes a Domestic-only lender', () => {
  // The exact failure the fix targets: a named foreign country that the OLD
  // dictionary did not know (Argentina/Portugal/Japan/Nigeria/Indonesia/Chile…)
  // must engage the intl/geo hard-exclude so a US/domestic-only lender NEVER
  // surfaces for that foreign deal. Drives extractDeal → scoreFit/rankByFit
  // exactly as run.ts does.

  // A Domestic-only lender, stated two ways: explicit intl_domestic, and the
  // blank-intl-but-US-geo inference path. Both must be excluded.
  const domesticByFlag = { id: 'dom-flag', intl_domestic: 'Domestic', geographic_scope: [] }
  const domesticByGeo = { id: 'dom-geo', intl_domestic: null, geographic_scope: ['All Domestic incl AK/HI'] }
  // Lenders that MUST survive a foreign deal.
  const global = { id: 'intl', intl_domestic: 'International', geographic_scope: ['Worldwide'] }
  const blank = { id: 'blank', intl_domestic: null, geographic_scope: [] } // unknown → kept (mandate)

  const rows = [domesticByFlag, domesticByGeo, global, blank]
  const fused = new Map(rows.map((r, i) => [r.id, i]))

  for (const q of [
    'finance equipment for a borrower in Argentina',
    'tractor deal in Portugal',
    'equipment financing in Japan',
    'a borrower in Nigeria',
    'operator based in Indonesia',
    'a UK-based equipment buyer',
  ]) {
    it(`"${q}" → excludes both Domestic-only lenders, keeps Worldwide + blank`, () => {
      const deal = dealFromQuery(q)
      expect(deal.intl_required).toBe(true) // foreign country engaged intl intent
      const out = rankByFit(rows, deal, fused).map((r) => r.id)
      expect(out).not.toContain('dom-flag')
      expect(out).not.toContain('dom-geo')
      expect(out).toContain('intl')
      expect(out).toContain('blank') // blank stays — never guessed out
    })
  }

  it('US-state deal does NOT trigger the intl exclude (no regression)', () => {
    const deal = dealFromQuery('Philips scanner for a Texas logistics company')
    expect(deal.intl_required).toBe(false)
    // A domestic lender with no other contradiction must be KEPT for a Texas deal.
    const texRows = [
      { id: 'dom', intl_domestic: 'Domestic', geographic_scope: ['All Domestic incl AK/HI'] },
      { id: 'blank', intl_domestic: null, geographic_scope: [] },
    ]
    const f = new Map(texRows.map((r, i) => [r.id, i]))
    const out = rankByFit(texRows, deal, f).map((r) => r.id)
    expect(out).toContain('dom') // domestic lender serves a Texas deal
    expect(out).toContain('blank')
  })
})

// A lender whose own record says "Currently lending: No" cannot fund a live deal.
// Real rows carry lending_status='No' (status='dormant') with active=true — so
// the active filter in run.ts never touched them and they could rank first. Blank stays unknown and keeps its natural position (the mandate:
// blank is never guessed).
describe('currently-lending state — stated "No" sorts last, blank is untouched', () => {
  it('flags only an explicit no', () => {
    expect(scoreFit({ lending_status: 'No' }, NO).notLending).toBe(true)
    expect(scoreFit({ status: 'dormant' }, NO).notLending).toBe(true)
    expect(scoreFit({ lending_status: 'no ' }, NO).notLending).toBe(true)
    expect(scoreFit({ lending_status: 'Yes' }, NO).notLending).toBe(false)
    expect(scoreFit({ lending_status: null }, NO).notLending).toBe(false)
    expect(scoreFit({}, NO).notLending).toBe(false)
  })

  it('never excludes — a dormant lender is still returned', () => {
    const v = scoreFit({ lending_status: 'No' }, NO)
    expect(hasContradiction(v)).toBe(false)
  })

  it('a better-fitting dormant lender still ranks below a lending one', () => {
    const deal: DealCriteria = { ...NO, asset_classes: ['construction_equipment'], geographic_scope: ['Texas'] }
    const rows = [
      // perfect fit on both dimensions, but not lending
      { id: 'dormant-perfect', lending_status: 'No', asset_classes: ['construction_equipment'], geographic_scope: ['Texas'] },
      // weaker fit (blank asset = unknown), but open for business
      { id: 'lending-weaker', lending_status: 'Yes', asset_classes: [], geographic_scope: ['Texas'] },
    ]
    const fused = new Map(rows.map((r, i) => [r.id, i]))
    const out = rankByFit(rows, deal, fused)
    expect(out.map((r) => r.id)).toEqual(['lending-weaker', 'dormant-perfect'])
    expect(out[0].fit.score).toBeLessThan(out[1].fit.score) // demoted despite scoring higher
  })

  it('blank lending_status keeps its fit-ranked position', () => {
    const deal: DealCriteria = { ...NO, geographic_scope: ['Texas'] }
    const rows = [
      { id: 'blank-match', geographic_scope: ['Texas'] },
      { id: 'yes-unknown', lending_status: 'Yes', geographic_scope: [] },
    ]
    const fused = new Map(rows.map((r, i) => [r.id, i]))
    expect(rankByFit(rows, deal, fused).map((r) => r.id)).toEqual(['blank-match', 'yes-unknown'])
  })
})

// Requirement: a lender whose stated geography names Canada must not appear
// for a deal in a different foreign country.
//
// Cause: 'international' sat in GLOBAL_TOKENS, so ANY lender whose stated
// geography contained the word matched EVERY deal geography. A row reading
// ["International","Canada"] matched Brazil.
//
// International means "anything that's not US". It is a CATEGORY, not a
// wildcard for every country. The specific country the lender names is the
// authoritative answer to "which international".
//
// Lender rows below are synthetic.
describe('international is not a wildcard', () => {
  const brazil: DealCriteria = { ...NO, geographic_scope: ['Brazil'], intl_required: true }

  it('a Canadian lender does NOT serve a Brazil deal', () => {
    for (const row of [
      { geographic_scope: ['International', 'Canada'] },
      { geographic_scope: ['US International', 'Canada'] },
      { geographic_scope: ['US and International', 'Canada'] },
    ]) {
      const v = scoreFit(row, brazil)
      expect(v.geo).toBe('contradict')
      expect(hasContradiction(v)).toBe(true)
    }
  })

  it('that same Canadian lender still serves a Canada deal', () => {
    const canada: DealCriteria = { ...NO, geographic_scope: ['Canada'], intl_required: true }
    expect(scoreFit({ geographic_scope: ['International', 'Canada'] }, canada).geo).toBe('match')
  })

  it('a UK-only international lender does not serve Brazil', () => {
    expect(scoreFit({ geographic_scope: ['International', 'UK'] }, brazil).geo).toBe('contradict')
  })

  it('a genuine worldwide lender still serves Brazil', () => {
    expect(scoreFit({ geographic_scope: ['International', 'Worldwide'] }, brazil).geo).toBe('match')
  })

  it('a region covers its member countries', () => {
    const africa = { geographic_scope: ['International', 'Africa'] }
    expect(scoreFit(africa, { ...NO, geographic_scope: ['Nigeria'], intl_required: true }).geo).toBe('match')
    expect(scoreFit(africa, brazil).geo).toBe('contradict')
    const europe = { geographic_scope: ['International', 'US', 'Europe'] }
    expect(scoreFit(europe, { ...NO, geographic_scope: ['France'], intl_required: true }).geo).toBe('match')
    expect(scoreFit(europe, brazil).geo).toBe('contradict')
  })

  it('reads a country out of a run-on cell', () => {
    const runOn = { geographic_scope: ['International', 'UK', 'Japan and India'] }
    expect(scoreFit(runOn, { ...NO, geographic_scope: ['India'], intl_required: true }).geo).toBe('match')
    expect(scoreFit(runOn, brazil).geo).toBe('contradict')
  })

  it('international with NO place named stays UNKNOWN, never excluded', () => {
    // We do not know which countries such a lender serves, so
    // they are kept as candidates but must not read as a confirmed match.
    const v = scoreFit({ geographic_scope: ['International'] }, brazil)
    expect(v.geo).toBe('unknown')
    expect(hasContradiction(v)).toBe(false)
  })

  it('treats a non-place in the geo cell as no place named', () => {
    // ["International","Equipment"]. Dirty data: the second value is an
    // asset class, not a geography. Must not become a Brazil match,
    // and must not hard-exclude either.
    expect(scoreFit({ geographic_scope: ['International', 'Equipment'] }, brazil).geo).toBe('unknown')
  })

  it('a US-domestic lender is still excluded from a foreign deal', () => {
    expect(scoreFit({ geographic_scope: ['All Domestic including AK and HI'] }, brazil).geo).toBe('contradict')
  })
})

// Requirement: a state-restricted lender whose list omits Texas must not
// appear for a Texas deal.
//
// Three causes, all in token matching. hasToken() ran `.trim()` on its patterns,
// which destroyed the space padding ' us' was relying on, so ANY string
// containing the letters "us" counted as US-domestic. And "international"
// contains "national". And a lender naming specific states was never constrained
// to them — and many rows list state codes.
//
// Lender rows below are synthetic.
describe('US state geography', () => {
  const texas: DealCriteria = { ...NO, geographic_scope: ['Texas'] }

  it('a lender that lists its states is held to them', () => {
    // several states, none of them Texas
    expect(scoreFit({ geographic_scope: ['US Specific', 'NV', 'UT', 'OR'] }, texas).geo)
      .toBe('contradict')
    // one state
    expect(scoreFit({ geographic_scope: ['US', 'NM'] }, texas).geo).toBe('contradict')
    expect(scoreFit({ geographic_scope: ['US Specific', 'GA'] }, texas).geo).toBe('contradict')
  })

  it('...and still matches when Texas IS in its list', () => {
    expect(scoreFit({ geographic_scope: ['US', 'NM', 'OK', 'TX'] }, texas).geo).toBe('match')
    expect(scoreFit({ geographic_scope: ['US Specific', 'TX'] }, texas).geo).toBe('match')
  })

  it('a genuinely nationwide lender still serves every state', () => {
    for (const geo of [
      ['US'],
      ['US & Canada'],
      ['All Domestic including AK and HI'], // names AK/HI but says "All Domestic"
      ['US', 'Anywhere Domestic'],
    ]) {
      expect(scoreFit({ geographic_scope: geo }, texas).geo, JSON.stringify(geo)).toBe('match')
    }
  })

  it('an international lender is not secretly US-domestic', () => {
    // "international" contains "national", which was in DOMESTIC_TOKENS, so every
    // international lender matched every US-state deal.
    expect(scoreFit({ geographic_scope: ['International'] }, texas).geo).toBe('contradict')
  })

  it('a foreign country containing the letters "us" is not US-domestic', () => {
    // ' us' was trimmed to 'us', so Australia / Austria / Belarus / Cyprus all
    // read as United States.
    for (const country of ['Australia', 'Austria', 'Belarus', 'Cyprus']) {
      expect(scoreFit({ geographic_scope: [country] }, texas).geo, country).toBe('contradict')
    }
  })

  it('does not read an English word as a state code', () => {
    // "OR"/"IN"/"OK" are states; "or"/"in"/"ok" in prose are not. Only an
    // uppercase two-letter token counts.
    expect(scoreFit({ geographic_scope: ['US', 'Prefer Mid West but not mandatory'] }, texas).geo)
      .toBe('match')
  })

  it('reads a full state name, not just the code', () => {
    // A misspelled category word next to a full state name.
    const named = { geographic_scope: ['US Specifc', 'Oregon'] }
    expect(scoreFit(named, texas).geo).toBe('contradict')
    expect(scoreFit(named, { ...NO, geographic_scope: ['Oregon'] }).geo).toBe('match')
  })

  it('blank geography is still kept as unknown', () => {
    expect(scoreFit({ geographic_scope: [] }, texas).geo).toBe('unknown')
  })
})

// Field disagreement: the intl_domestic CATEGORY contradicting the lender's own
// stated GEOGRAPHY. Rows can be tagged Domestic while their geographic_scope
// names Canada or International. The matcher was reading both and
// hard-excluding, producing a self-contradictory verdict — the reasons list
// literally read "geography served | lender is domestic-only, cannot serve an
// international deal" — and a lender whose geography says Canada was dropped
// from every Canada deal.
//
// Rule: a specific stated geography beats a vague category flag. The flag may
// never hard-exclude a lender whose own geography covers the deal.
describe('intl_domestic must not override a stated geography', () => {
  const canada: DealCriteria = { ...NO, geographic_scope: ['Canada'], intl_required: true }

  it('a Domestic-tagged lender whose geography names Canada still serves Canada', () => {
    for (const row of [
      { intl_domestic: 'Domestic', geographic_scope: ['US and International', 'Canada'] },
      { intl_domestic: 'Domestic', geographic_scope: ['US & Canada'] },
      { intl_domestic: 'Domestic', geographic_scope: ['US', 'Canada'] },
    ]) {
      const v = scoreFit(row, canada)
      expect(v.geo).toBe('match')
      expect(hasContradiction(v)).toBe(false)
    }
  })

  it('a Domestic lender with NO foreign geography is still excluded', () => {
    // The flag is still load-bearing when the geography agrees with it.
    const v = scoreFit(
      { intl_domestic: 'Domestic', geographic_scope: ['All Domestic including AK and HI'] },
      canada,
    )
    expect(v.intl).toBe('contradict')
    expect(hasContradiction(v)).toBe(true)
  })

  it('a Domestic lender with blank geography is still excluded from a foreign deal', () => {
    const v = scoreFit({ intl_domestic: 'Domestic', geographic_scope: [] }, canada)
    expect(v.intl).toBe('contradict')
  })
})
