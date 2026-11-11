/**
 * The internal notes are read, and what they say changes the order.
 *
 * Everything, including the internal notes, is free for the local model to
 * read and parse: if the notes indicate a preference for a region, or highlight
 * an avoidance of one, that is accounted for in the results and ranking.
 *
 * Every note below is an invented sentence shaped like a typical
 * `internal_notes` cell: short, often with a negation in it.
 *
 * The line this file pins hardest is the one the accuracy mandate draws: a
 * notes-derived signal RANKS and never EXCLUDES. A lender whose own notes say
 * "No deals in HI or AK" must still be returned for a Hawaii deal — at the
 * bottom, with the sentence attached — because this is a machine reading of
 * prose and a deletion would be invisible.
 */

import { describe, it, expect } from 'vitest'
import { scoreFit, rankByFit, hasContradiction, type DealCriteria } from './structured-filter'
import { NOTE_SIGNALS_VERSION, validateNoteSignals } from '@/lib/notes/signals'

const NO: DealCriteria = {
  asset_classes: [],
  geographic_scope: [],
  deal_size_min_usd: null,
  deal_size_max_usd: null,
  intl_required: false,
}

const sig = (o: {
  prefers?: { place: string; quote: string }[]
  avoids?: { place: string; quote: string }[]
  assets?: { asset: string; quote: string }[]
  paused?: { quote: string } | null
}) => ({
  version: NOTE_SIGNALS_VERSION,
  extracted_at: '2026-09-14T00:00:00.000Z',
  model: 'qwen2.5:3b',
  prefers: o.prefers ?? [],
  avoids: o.avoids ?? [],
  assets: o.assets ?? [],
  paused: o.paused ?? null,
})

describe('a preference in the notes makes a nationwide lender local', () => {
  // A nationwide row (geographic_scope ["US"], specific_geographic "All")
  // whose notes say where it is headquartered. lending_status is left unset so
  // the ordering is exercised on its own, outside the not-lending block.
  const hq = {
    geographic_scope: ['US'],
    specific_geographic: 'All',
    note_signals: sig({ prefers: [{ place: 'Nebraska', quote: 'Headquartered in Nebraska' }] }),
  }

  it('the notes name the state the search asked for', () => {
    const v = scoreFit(hq, { ...NO, us_states: ['nebraska'] })
    expect(v.notesPrefer).toBe('Headquartered in Nebraska')
  })

  it('but the structured geography still does not — this is not localToRequest', () => {
    // The distinction is the whole point of keeping them separate: a curated
    // cell outranks a machine reading of prose, so they cannot share a flag.
    const v = scoreFit(hq, { ...NO, us_states: ['nebraska'] })
    expect(v.localToRequest).toBe(false)
  })

  it('a state the notes do not mention is unaffected', () => {
    expect(scoreFit(hq, { ...NO, us_states: ['texas'] }).notesPrefer).toBeNull()
  })

  it('resolves a postal code in the notes against a state name in the deal', () => {
    // The vocabulary is shared with the structured path on purpose: an earlier
    // bug was two halves of one comparison disagreeing about what "LA" meant.
    const v = scoreFit(
      {
        geographic_scope: ['US'],
        note_signals: sig({
          prefers: [{ place: 'TN', quote: 'Prefers TN deals and the South East' }],
        }),
      },
      { ...NO, us_states: ['tennessee'] },
    )
    expect(v.notesPrefer).toBe('Prefers TN deals and the South East')
  })

  it('ranks a notes-local lender above an equally-fitting nationwide one', () => {
    const rows = [
      { id: 'plain', company_name: 'AAA Capital', geographic_scope: ['US'] },
      { id: 'notes', company_name: 'ZZZ Bank', ...hq },
    ]
    const out = rankByFit(rows, { ...NO, us_states: ['nebraska'] }, new Map())
    expect(out.map((r) => r.id)).toEqual(['notes', 'plain'])
    // Alphabetical is the final tiebreaker, so without the signal ZZZ would be
    // last — proving the move came from the notes and not from the sort order.
    expect(out.map((r) => r.id)).not.toEqual(['plain', 'notes'])
  })

  it('a curated geography cell still leads a notes-derived one', () => {
    const rows = [
      {
        id: 'notes',
        company_name: 'AAA Bank',
        geographic_scope: ['US'],
        note_signals: sig({ prefers: [{ place: 'Nebraska', quote: 'Headquartered in Nebraska' }] }),
      },
      { id: 'curated', company_name: 'ZZZ Bank', geographic_scope: ['US Specific', 'NE'] },
    ]
    const out = rankByFit(rows, { ...NO, us_states: ['nebraska'] }, new Map())
    expect(out.map((r) => r.id)).toEqual(['curated', 'notes'])
  })
})

describe('an avoidance in the notes sinks the lender and never removes it', () => {
  // Nationwide coverage in the structured cell, two states ruled out in prose.
  const legacy = {
    id: 'legacy',
    company_name: 'AAA Example Bank',
    geographic_scope: ['US'],
    note_signals: sig({ avoids: [{ place: 'HI', quote: 'No deals in HI or AK' }] }),
  }

  it('reports the sentence for a Hawaii search', () => {
    expect(scoreFit(legacy, { ...NO, us_states: ['hawaii'] }).notesAvoid).toBe('No deals in HI or AK')
  })

  it('is NOT excluded — the accuracy mandate lets an inferred value rank only', () => {
    const v = scoreFit(legacy, { ...NO, us_states: ['hawaii'] })
    expect(hasContradiction(v)).toBe(false)
    expect(rankByFit([legacy], { ...NO, us_states: ['hawaii'] }, new Map())).toHaveLength(1)
  })

  it('sorts below a lender that has said nothing, despite leading alphabetically', () => {
    const other = { id: 'other', company_name: 'ZZZ Capital', geographic_scope: ['US'] }
    const out = rankByFit([legacy, other], { ...NO, us_states: ['hawaii'] }, new Map())
    expect(out.map((r) => r.id)).toEqual(['other', 'legacy'])
  })

  it('is inert for a state it did not rule out', () => {
    const v = scoreFit(legacy, { ...NO, us_states: ['texas'] })
    expect(v.notesAvoid).toBeNull()
  })

  it('works for a country as well as a state', () => {
    const both = {
      geographic_scope: ['US', 'All Domestic including AK and HI'],
      intl_domestic: 'Both',
      note_signals: sig({ avoids: [{ place: 'Canada', quote: 'No deals in Canada' }] }),
    }
    expect(scoreFit(both, { ...NO, geographic_scope: ['Canada'] }).notesAvoid).toBe('No deals in Canada')
  })

  it('a stated not-lending demotion still outranks a notes avoidance', () => {
    // Ordering contract: notLending is decided from a curated cell and applies
    // first; the notes avoidance sorts within what is left.
    const dormant = {
      id: 'dormant',
      company_name: 'AAA Dormant',
      geographic_scope: ['US'],
      lending_status: 'No',
    }
    const out = rankByFit([dormant, legacy], { ...NO, us_states: ['hawaii'] }, new Map())
    expect(out.map((r) => r.id)).toEqual(['legacy', 'dormant'])
  })
})

describe('a pause mentioned only in the notes changes nothing but the screen', () => {
  // lending_status "Yes", but the notes say new lending is on hold.
  //
  // Stay on the safe side: keep it visible rather than hiding it from
  // potentially valid results, so staff can see it, open the card and correct
  // the record if needed.
  const origin = {
    id: 'origin',
    company_name: 'Example Bank',
    geographic_scope: ['US Specific', 'LA', 'TX'],
    lending_status: 'Yes',
    note_signals: sig({ paused: { quote: 'New loans on hold' } }),
  }

  it('surfaces the sentence', () => {
    expect(scoreFit(origin, { ...NO, us_states: ['texas'] }).notesPaused).toBe('New loans on hold')
  })

  it('does not set notLending — that stays a curated-cell decision', () => {
    expect(scoreFit(origin, { ...NO, us_states: ['texas'] }).notLending).toBe(false)
  })

  it('does not move it in the order', () => {
    // Same geography on both rows, so the pause is the only difference between
    // them and alphabetical is the only thing left to decide the order. Origin
    // leads because "Example Bank" sorts before "ZZZ Bank" — not because it was
    // spared a demotion, and it is not demoted either.
    const paused = { ...origin, geographic_scope: ['US Specific', 'TX'] }
    const plain = { id: 'plain', company_name: 'ZZZ Bank', geographic_scope: ['US Specific', 'TX'] }
    const out = rankByFit([paused, plain], { ...NO, us_states: ['texas'] }, new Map())
    expect(out.map((r) => r.id)).toEqual(['origin', 'plain'])
  })
})

describe('an asset the notes mention cannot get a lender deleted', () => {
  // Notes can mention real estate financing while the structured asset_classes
  // cell does not carry it. Curating the cell fixes it for good; this branch
  // covers the gap until then.
  const mixed = {
    asset_classes: ['medical_equipment', 'construction_equipment'],
    note_signals: sig({ assets: [{ asset: 'real_estate', quote: 'Also does warehouse loans' }] }),
  }

  it('downgrades the exclusion to unknown', () => {
    const v = scoreFit(mixed, { ...NO, asset_classes: ['real_estate'] })
    expect(v.asset).toBe('unknown')
    expect(hasContradiction(v)).toBe(false)
  })

  it('does not award a point for it — unknown is not a match', () => {
    expect(scoreFit(mixed, { ...NO, asset_classes: ['real_estate'] }).score).toBe(0)
  })

  it('a lender whose notes say nothing about it is still excluded', () => {
    const v = scoreFit({ asset_classes: ['medical_equipment'] }, { ...NO, asset_classes: ['real_estate'] })
    expect(v.asset).toBe('contradict')
    expect(hasContradiction(v)).toBe(true)
  })
})

describe('"Currently Inactive" demotes, like the dropdown says it should', () => {
  it('is read as not lending', () => {
    const v = scoreFit({ lending_status: 'Currently Inactive' }, NO)
    expect(v.notLending).toBe(true)
  })

  it('is still not excluded', () => {
    const row = { id: 'x', company_name: 'X', lending_status: 'Currently Inactive' }
    expect(rankByFit([row], NO, new Map())).toHaveLength(1)
  })

  it('blank is still unknown and is left alone', () => {
    expect(scoreFit({ lending_status: null }, NO).notLending).toBe(false)
    expect(scoreFit({ lending_status: '' }, NO).notLending).toBe(false)
  })
})

describe('the verbatim-quote gate', () => {
  const notes = 'Headquartered in Nebraska. Referred by a partner in 2020. No deals in HI or AK.'

  it('keeps a signal whose quote is really in the notes', () => {
    const out = validateNoteSignals(
      notes,
      {
        prefers: [{ place: 'Nebraska', quote: 'Headquartered in Nebraska' }],
        avoids: [],
        assets: [],
        paused: null,
      },
      { model: 'test' },
    )
    expect(out.prefers).toHaveLength(1)
  })

  it('throws away a signal the model invented', () => {
    // The failure this exists to stop: a plausible-sounding criterion with no
    // sentence behind it. It cannot reach the ranker.
    const out = validateNoteSignals(
      notes,
      {
        prefers: [{ place: 'Texas', quote: 'prefers Texas deals' }],
        avoids: [],
        assets: [],
        paused: null,
      },
      { model: 'test' },
    )
    expect(out.prefers).toHaveLength(0)
  })

  it('throws away a paraphrase, however accurate', () => {
    const out = validateNoteSignals(
      notes,
      {
        prefers: [],
        avoids: [{ place: 'HI', quote: 'does not lend in Hawaii or Alaska' }],
        assets: [],
        paused: null,
      },
      { model: 'test' },
    )
    expect(out.avoids).toHaveLength(0)
  })

  it('tolerates whitespace differences, since notes often contain double spaces', () => {
    const out = validateNoteSignals(
      'Rates vary.  Also does warehouse loans.',
      {
        prefers: [],
        avoids: [],
        assets: [{ asset: 'real_estate', quote: 'Also does   warehouse loans' }],
        paused: null,
      },
      { model: 'test' },
    )
    expect(out.assets).toHaveLength(1)
  })

  it('drops an asset outside the known set', () => {
    const out = validateNoteSignals(
      notes,
      {
        prefers: [],
        avoids: [],
        assets: [{ asset: 'space_elevator', quote: 'Headquartered in Nebraska' }],
        paused: null,
      },
      { model: 'test' },
    )
    expect(out.assets).toHaveLength(0)
  })

  it('drops both halves when one place is read as preferred AND avoided', () => {
    const conflicting = 'Texas based. Not lending in Texas this quarter.'
    const out = validateNoteSignals(
      conflicting,
      {
        prefers: [{ place: 'Texas', quote: 'Texas based' }],
        avoids: [{ place: 'TX', quote: 'Not lending in Texas this quarter' }],
        assets: [],
        paused: null,
      },
      { model: 'test' },
    )
    expect(out.prefers).toHaveLength(0)
    expect(out.avoids).toHaveLength(0)
  })
})

/**
 * The quote gate alone passes a read whose SENTENCE is real but whose place
 * (or asset) is not. These gates catch that class of model error.
 */
describe('the place gate', () => {
  it('drops a place the cited sentence never mentions', () => {
    // A model reporting `avoids: India` off a sentence about the US and
    // Canada. India appears nowhere in the record.
    const notes = 'Will not finance collateral outside the US or Canada.'
    const out = validateNoteSignals(
      notes,
      {
        prefers: [],
        avoids: [{ place: 'India', quote: 'Will not finance collateral outside the US or Canada' }],
        assets: [],
        paused: null,
      },
      { model: 'test' },
    )
    expect(out.avoids).toHaveLength(0)
  })

  it('drops something that is not a place at all', () => {
    const out = validateNoteSignals(
      'No units older than ten years.',
      {
        prefers: [],
        avoids: [{ place: 'No units', quote: 'No units older than ten years' }],
        assets: [],
        paused: null,
      },
      { model: 'test' },
    )
    expect(out.avoids).toHaveLength(0)
  })

  it('drops "US" — a coverage category is not a place', () => {
    // Otherwise almost every lender would "prefer" the entire country, which
    // would make the signal fire on every domestic search and rank nothing.
    const out = validateNoteSignals(
      'US based lender.',
      {
        prefers: [{ place: 'US', quote: 'US based lender' }],
        avoids: [],
        assets: [],
        paused: null,
      },
      { model: 'test' },
    )
    expect(out.prefers).toHaveLength(0)
  })

  it('requires an avoidance sentence to actually contain a refusal', () => {
    // "Headquartered in San Diego, California" is not an avoidance of California.
    const out = validateNoteSignals(
      'Headquartered in San Diego, California',
      {
        prefers: [],
        avoids: [{ place: 'California', quote: 'Headquartered in San Diego, California' }],
        assets: [],
        paused: null,
      },
      { model: 'test' },
    )
    expect(out.avoids).toHaveLength(0)
  })

  it('keeps a refusal that names its place', () => {
    const out = validateNoteSignals(
      'Terms up to seven years. No deals in HI or AK.',
      {
        prefers: [],
        avoids: [{ place: 'HI', quote: 'No deals in HI or AK' }],
        assets: [],
        paused: null,
      },
      { model: 'test' },
    )
    expect(out.avoids).toEqual([{ place: 'hawaii', quote: 'No deals in HI or AK' }])
  })

  it('canonicalises the place, so the ranker never compares LA to Louisiana', () => {
    const out = validateNoteSignals(
      'Nationwide except LA.',
      {
        prefers: [],
        avoids: [{ place: 'LA', quote: 'Nationwide except LA' }],
        assets: [],
        paused: null,
      },
      { model: 'test' },
    )
    expect(out.avoids[0]?.place).toBe('louisiana')
  })

  it('drops an asset the cited sentence never names', () => {
    // A model reporting an asset off a sentence that names none. Same failure
    // as the place gate, one field over.
    const out = validateNoteSignals(
      'Open to refinancing deals. Flexible on terms.',
      {
        prefers: [],
        avoids: [],
        assets: [{ asset: 'medical_equipment', quote: 'Open to refinancing deals' }],
        paused: null,
      },
      { model: 'test' },
    )
    expect(out.assets).toHaveLength(0)
  })

  it('keeps an asset the sentence does name', () => {
    const out = validateNoteSignals(
      'Rates vary. Also does warehouse loans.',
      {
        prefers: [],
        avoids: [],
        assets: [{ asset: 'real_estate', quote: 'Also does warehouse loans' }],
        paused: null,
      },
      { model: 'test' },
    )
    expect(out.assets).toEqual([{ asset: 'real_estate', quote: 'Also does warehouse loans' }])
  })

  it('an affirmative beats a stray negation word', () => {
    // A Montana bank saying it will go beyond Montana, read as AVOIDS Montana.
    // Demoting it on Montana searches is an inversion, strictly worse than no
    // signal at all. The sentence also contains "not", so the affirmative has
    // to win over a real negation word.
    const out = validateNoteSignals(
      'Can consider borrowers outside Montana, not just in-state.',
      {
        prefers: [],
        avoids: [
          {
            place: 'Montana',
            quote: 'Can consider borrowers outside Montana, not just in-state',
          },
        ],
        assets: [],
        paused: null,
      },
      { model: 'test' },
    )
    expect(out.avoids).toHaveLength(0)
  })

  it('still reads "cannot consider" as a refusal', () => {
    // The affirmative test must not swallow this one: \bcan\b does not match
    // inside "cannot".
    const out = validateNoteSignals(
      'Asia-Pacific focus; cannot consider Japan.',
      {
        prefers: [],
        avoids: [{ place: 'Japan', quote: 'cannot consider Japan' }],
        assets: [],
        paused: null,
      },
      { model: 'test' },
    )
    expect(out.avoids).toHaveLength(1)
  })

  it('drops a "paused" whose quote says nothing about lending stopping', () => {
    // Without this gate a model sets `paused` on quotes about rates or LTV.
    // A "Check status" chip on a third of the index teaches users to ignore
    // the chip, including the few times it is right.
    for (const quote of ['competitive rates', '75% LTV', 'Higher rates', 'No used units.']) {
      const out = validateNoteSignals(
        `Some notes. ${quote}`,
        { prefers: [], avoids: [], assets: [], paused: { quote } },
        { model: 'test' },
      )
      expect(out.paused, quote).toBeNull()
    }
  })

  it('keeps the pauses that are real', () => {
    // A pause matters most when the lending_status cell does NOT say No,
    // which is exactly why surfacing it is worth anything.
    const real = [
      'Stopped funding new loans until further notice.',
      'Done lending for now',
      'New deals on hold this quarter',
      'Term loans on hold',
      'Not lending while the division winds down',
      'No longer active in this market.',
    ]
    for (const quote of real) {
      const out = validateNoteSignals(
        `Notes. ${quote}`,
        { prefers: [], avoids: [], assets: [], paused: { quote } },
        { model: 'test' },
      )
      expect(out.paused?.quote, quote).toBe(quote)
    }
  })

  it('accepts a country', () => {
    const out = validateNoteSignals(
      'Cannot consider Germany.',
      {
        prefers: [],
        avoids: [{ place: 'Germany', quote: 'Cannot consider Germany' }],
        assets: [],
        paused: null,
      },
      { model: 'test' },
    )
    expect(out.avoids).toHaveLength(1)
  })
})

describe('a lender with no note signals behaves exactly as before', () => {
  it('reports null for all three', () => {
    const v = scoreFit({ geographic_scope: ['US Specific', 'TX'] }, { ...NO, us_states: ['texas'] })
    expect(v.notesPrefer).toBeNull()
    expect(v.notesAvoid).toBeNull()
    expect(v.notesPaused).toBeNull()
  })

  it('survives a malformed value in the column', () => {
    const v = scoreFit(
      { geographic_scope: ['US'], note_signals: { garbage: true } },
      { ...NO, us_states: ['texas'] },
    )
    expect(v.notesPrefer).toBeNull()
    expect(hasContradiction(v)).toBe(false)
  })
})

/** Regressions: each test below failed before its fix. */
describe('review regressions', () => {
  it('a refusal filed under prefers is thrown away', () => {
    // The gate ran on `avoids` only. A model that put "No deals in Canada" in
    // the wrong list sailed through every check and put a lender that refuses
    // Canada at the top of a Canada search, wearing a green "Local (notes)"
    // chip that quoted the refusal back at you.
    const out = validateNoteSignals(
      'No deals in Canada. Terms up to ten years.',
      {
        prefers: [{ place: 'Canada', quote: 'No deals in Canada' }],
        avoids: [],
        assets: [],
        paused: null,
      },
      { model: 'test' },
    )
    expect(out.prefers).toHaveLength(0)
  })

  it('a lowercase two-letter word is not a state code', () => {
    // " in ", " or ", " me ", " hi " and " la " were all valid mentions of
    // Indiana, Oregon, Maine, Hawaii and Louisiana, so the sentence this gate
    // exists for — "Will not finance collateral outside the US or Canada" —
    // satisfied it for place: Oregon. usStatesNamedBy requires uppercase for
    // the same reason.
    const out = validateNoteSignals(
      'Will not finance collateral outside the US or Canada.',
      {
        prefers: [],
        avoids: [{ place: 'Oregon', quote: 'Will not finance collateral outside the US or Canada' }],
        assets: [],
        paused: null,
      },
      { model: 'test' },
    )
    expect(out.avoids).toHaveLength(0)
  })

  it('an uppercase code still counts', () => {
    const out = validateNoteSignals(
      'Nationwide except LA.',
      {
        prefers: [],
        avoids: [{ place: 'LA', quote: 'Nationwide except LA' }],
        assets: [],
        paused: null,
      },
      { model: 'test' },
    )
    expect(out.avoids[0]?.place).toBe('louisiana')
  })

  it('a curated geography cell outranks a refusal found in prose', () => {
    // The two can contradict. When they do the cell a human typed wins and the
    // conflict is SHOWN, not silently resolved in the model's favour. Sorting the
    // demotion above localToRequest sank a curated Texas bank below a generic
    // nationwide lender on a Texas search.
    const curatedLocal = {
      id: 'local',
      company_name: 'ZZZ Texas Bank',
      geographic_scope: ['US Specific', 'TX'],
      note_signals: sig({ avoids: [{ place: 'TX', quote: 'no new TX deals' }] }),
    }
    const nationwide = { id: 'wide', company_name: 'AAA Nationwide', geographic_scope: ['US'] }
    const out = rankByFit([nationwide, curatedLocal], { ...NO, us_states: ['texas'] }, new Map())
    expect(out.map((r) => r.id)).toEqual(['local', 'wide'])
    // …and the contradiction is on the row rather than hidden.
    expect(out[0].fit.notesAvoid).toBe('no new TX deals')
  })

  it('a lending-pause sentence is not a geographic preference', () => {
    // A sentence about a lender pausing came back as `prefers: Texas`, because
    // it names Texas and contains no refusal word. It rendered as "The notes
    // name this location: ...stopped funding new loans".
    const quote = 'Merged with another bank in Texas and stopped funding new loans while it integrates.'
    const out = validateNoteSignals(
      quote,
      {
        prefers: [{ place: 'Texas', quote }],
        avoids: [],
        assets: [],
        paused: { quote },
      },
      { model: 'test' },
    )
    expect(out.prefers).toHaveLength(0)
    // …and it is still reported as what it is.
    expect(out.paused?.quote).toBe(quote)
  })

  it('a region in the notes covers its states', () => {
    // A note that is just the word "Southeast", or one saying "the South East".
    // canonicalNotePlace accepts those, so before this they were stored and then
    // matched nothing at all.
    const southeast = {
      geographic_scope: ['US'],
      note_signals: sig({ prefers: [{ place: 'southeast', quote: 'Southeast' }] }),
    }
    expect(scoreFit(southeast, { ...NO, us_states: ['georgia'] }).notesPrefer).toBe('Southeast')
    expect(scoreFit(southeast, { ...NO, us_states: ['tennessee'] }).notesPrefer).toBe('Southeast')
    // Not a member of the region.
    expect(scoreFit(southeast, { ...NO, us_states: ['oregon'] }).notesPrefer).toBeNull()
  })

  it('reads the spaced spelling of a region too', () => {
    const spaced = {
      geographic_scope: ['US'],
      note_signals: sig({
        prefers: [{ place: 'South East', quote: 'Prefers TN deals and the South East' }],
      }),
    }
    expect(scoreFit(spaced, { ...NO, us_states: ['alabama'] }).notesPrefer).not.toBeNull()
  })
})

/**
 * Chip redundancy.
 *
 * These assert the VERDICT pairs that the renderer suppresses on
 * (search-fit.tsx). Two chips making one point is cognitive load, and a
 * caution that fires next to a stronger one stops being read.
 */
describe('a verdict does not restate what the chip beside it already says', () => {
  it('a lender local by its geography cell is ALSO local by its notes', () => {
    // A row whose cell lists TX and whose note says "Prefers Texas and
    // neighboring states" would wear "Local" and "Local (notes)" together.
    // Both verdicts are correct; the renderer shows only the curated one.
    const both = {
      geographic_scope: ['US Specific', 'TX'],
      note_signals: sig({
        prefers: [{ place: 'texas', quote: 'Prefers Texas and neighboring states.' }],
      }),
    }
    const v = scoreFit(both, { ...NO, us_states: ['texas'] })
    expect(v.localToRequest).toBe(true)
    expect(v.notesPrefer).not.toBeNull()
  })

  it('a dormant lender whose notes also mention a pause reports both', () => {
    // A dormant row would wear "DORMANT" and "Check status". The second says
    // nothing the first did not.
    const dormant = {
      lending_status: 'No',
      status: 'dormant',
      note_signals: sig({ paused: { quote: 'Not lending while the division winds down' } }),
    }
    const v = scoreFit(dormant, NO)
    expect(v.notLending).toBe(true)
    expect(v.notesPaused).not.toBeNull()
  })

  it('a pause the lending cell does NOT know about still stands alone', () => {
    // This is the pair worth showing: no "No" in the cell, so nothing else on
    // the row says it.
    const active = {
      lending_status: null,
      status: 'active',
      note_signals: sig({ paused: { quote: 'Term loans on hold' } }),
    }
    const v = scoreFit(active, NO)
    expect(v.notLending).toBe(false)
    expect(v.notesPaused).toBe('Term loans on hold')
  })
})
