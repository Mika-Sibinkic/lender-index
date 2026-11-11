/**
 * Structured signals read out of a lender's free-text `internal_notes`.
 *
 * Why this file exists
 * --------------------
 * A roster's notes column carries real matching criteria that live nowhere else.
 * Typical shapes: "Headquartered in Idaho, prefers to stay local", "Prefers
 * Texas and neighboring states", "No deals in HI or AK", "No deals in Canada",
 * "cannot consider Japan". A lender like that looks generic to the matcher and
 * reads as a regional bank, or as a refusal, to a human.
 *
 * Once read, those lenders move to where a human would put them: a lender
 * based in Idaho leads an Idaho search, a Texas-focused lender leads Texas.
 *
 * The requirement: if a preference to a certain region is indicated in the
 * internal notes or an avoidance to a certain region is highlighted, that should
 * be accounted for in the results and ranking mechanism.
 *
 * Why a derived column and not "just embed the notes"
 * --------------------------------------------------
 * The notes ALREADY reach the embedding — `internal_notes` is the second field
 * in `sourceText()` (lib/embeddings/index.ts) — and that is precisely the
 * problem. An embedding has no negation. "No Canada" sits NEAR Canada in vector
 * space, so today a lender that refuses Canadian deals is boosted by its own
 * refusal on a Canada search. Reading the sentence into a typed avoid/prefer
 * pair is the only way the "no" survives.
 *
 * Why every signal carries the sentence it came from
 * --------------------------------------------------
 * This is an LLM reading prose, so it can be wrong. Under the accuracy mandate a
 * value we worked out ourselves may RANK but must never EXCLUDE (stated
 * criteria may exclude; inferred ones only rank). The quote is what
 * makes that safe and auditable: it is shown on the row, so a human sees why a
 * lender moved, and `validateNoteSignals` throws away any signal whose quote is
 * not literally present in the notes — an extraction that invents its evidence
 * cannot reach the ranker.
 */

import { z } from 'zod'
import { ASSET_CLASS_IDS } from '@/lib/config/domain'
import {
  canonicalNotePlace,
  quoteMentionsAsset,
  quoteMentionsPlace,
  quoteReadsAsLendingPause,
  quoteReadsAsRefusal,
} from './places'

/**
 * Bumped whenever the extraction prompt or this shape changes, so a re-run can
 * tell "already done" from "done by an older reader". Stored on the row.
 */
export const NOTE_SIGNALS_VERSION = 1

/** Asset class ids a note may name ('other' says nothing a matcher can use). */
const NOTE_ASSET_IDS = ASSET_CLASS_IDS.filter((id) => id !== 'other')

export interface NoteSignalPlace {
  /** The place as the note names it — "Nebraska", "CA", "Southeast", "Canada". */
  place: string
  /** The exact words from internal_notes that say so. Verified verbatim. */
  quote: string
}

export interface NoteSignalAsset {
  /** Asset class id from src/lib/config/vocabulary.ts, e.g. `real_estate`. */
  asset: string
  quote: string
}

export interface NoteSignals {
  version: number
  extracted_at: string
  model: string
  /** Places the lender is based in, focused on, or says it prefers. */
  prefers: NoteSignalPlace[]
  /** Places the lender says it will not or would rather not lend in. */
  avoids: NoteSignalPlace[]
  /** Asset classes the notes say they finance that the structured cell omits. */
  assets: NoteSignalAsset[]
  /** The notes say lending is paused/stopped, whatever `lending_status` claims. */
  paused: { quote: string } | null
  /**
   * Fingerprint of the notes this was read from, so a re-run can tell "already
   * done" from "the notes changed underneath it" without re-reading every row
   * through the model. Written by the batch script and the PATCH route; absent
   * on hand-written test fixtures.
   */
  source?: string
}

/**
 * The shape the model is asked for.
 *
 * Deliberately NO `.regex()` anywhere: a regex in a schema handed to the
 * openai-compatible endpoint crashes the on-prem model runner outright. Shape
 * constraints only; correctness is enforced afterwards by validateNoteSignals,
 * which is deterministic and runs on our side.
 */
const placeSchema = z.object({
  place: z.string().describe('The place named, exactly as the note writes it'),
  quote: z.string().describe('The exact words from the note that say this, copied verbatim'),
})

export const noteSignalsExtractionSchema = z.object({
  prefers: z
    .array(placeSchema)
    .describe('Places the lender is based in, focused on, or prefers to lend in'),
  avoids: z
    .array(placeSchema)
    .describe('Places the lender says it will not lend in, or does not like'),
  assets: z
    .array(
      z.object({
        asset: z.string().describe(`One of: ${NOTE_ASSET_IDS.join(', ')}`),
        quote: z.string().describe('The exact words from the note, copied verbatim'),
      }),
    )
    .describe('Asset types the note says this lender finances'),
  paused: z
    .object({
      quote: z.string().describe('The exact words from the note, copied verbatim'),
    })
    .nullable()
    .describe('Set only if the note says lending is stopped, paused or on hold'),
})

export type NoteSignalsExtraction = z.infer<typeof noteSignalsExtractionSchema>

/** Asset tokens we accept from the notes. Anything else is dropped. */
const KNOWN_NOTE_ASSETS = new Set(NOTE_ASSET_IDS)

/**
 * Whitespace- and case-insensitive containment.
 *
 * The model reliably reproduces the words and unreliably reproduces the spacing
 * — hand-typed notes contain double spaces, stray newlines and non-breaking
 * spaces — so comparing raw would reject true quotes. Punctuation is kept:
 * dropping it would let "no Canada" pass against a note reading "no, Canada".
 */
const squash = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()

/**
 * Strip every signal whose quote is not actually in the notes.
 *
 * This is the anti-hallucination gate, and it is the reason a notes-derived
 * signal is allowed to touch the ranking at all. A model that paraphrases,
 * summarises, or invents a criterion fails here and the signal is discarded —
 * silently for that entry, loudly in the script's dry-run diff.
 *
 * Also enforces: a place must be non-empty, an asset must be one we know, and
 * the same place cannot be both preferred and avoided (contradictory reads are
 * dropped from BOTH lists — we do not get to pick which half was right).
 */
export function validateNoteSignals(
  notes: string,
  raw: NoteSignalsExtraction,
  meta: { model: string; now?: Date },
): NoteSignals {
  const hay = squash(notes)
  const quoted = (q: string) => {
    const needle = squash(q)
    return needle.length > 0 && hay.includes(needle)
  }

  /**
   * Three gates, all deterministic, all on our side of the model:
   *   1. the sentence is really in the notes (quoted)
   *   2. the place is a place this codebase knows (canonicalNotePlace)
   *   3. that sentence actually mentions it (quoteMentionsPlace)
   *
   * Gates 2 and 3 exist because gate 1 alone lets wrong reads through:
   * `avoids: India` on a lender whose notes never say India but whose cited
   * sentence is real, or `avoids: "No units"`, which is not a place. See
   * lib/notes/places.ts.
   *
   * The place is rewritten to its canonical form on the way through, so the
   * ranker compares "louisiana" to "louisiana" and never "LA" to "Louisiana".
   */
  const keepPlaces = (xs: NoteSignalPlace[], want: 'refusal' | 'preference') => {
    const out: NoteSignalPlace[] = []
    for (const x of xs) {
      if (!x.place?.trim() || !quoted(x.quote)) continue
      const canonical = canonicalNotePlace(x.place)
      if (!canonical) continue
      if (!quoteMentionsPlace(x.quote, x.place, canonical)) continue
      // The refusal test runs on BOTH lists, in opposite directions. Requiring
      // it on `avoids` was obvious; the mirror was missing, so a model that
      // filed "No Canada" under `prefers` sailed through every gate and put a
      // lender that refuses Canada at the top of a Canada search wearing a green
      // "Local (notes)" chip that quoted the refusal back at you.
      const refusal = quoteReadsAsRefusal(x.quote)
      if (want === 'refusal' ? !refusal : refusal) continue
      // A sentence that says lending STOPPED is not evidence of a geographic
      // preference, whichever list it lands in. "Merged with another bank in
      // Texas and stopped funding new loans" names Texas and contains no refusal
      // word, so without this it passes as `prefers: Texas` and puts a sentence
      // about the lender pausing on a chip reading "The notes name this
      // location". It is a pause, and it is reported as one.
      //
      // Preferences only. "Not lending in Texas this quarter" is genuinely both a
      // pause and a geographic refusal, and dropping it from `avoids` too would
      // throw away the half that matters for ranking.
      if (want === 'preference' && quoteReadsAsLendingPause(x.quote)) continue
      out.push({ place: canonical, quote: x.quote })
    }
    return out
  }

  let prefers = keepPlaces(raw.prefers ?? [], 'preference')
  let avoids = keepPlaces(raw.avoids ?? [], 'refusal')

  // A place read as both preferred and avoided is a read we cannot trust in
  // either direction, so neither half survives. Rare, but a note that names a
  // state twice with a condition attached can produce it.
  const norm = (s: string) => s.toLowerCase().trim()
  const conflict = new Set(
    prefers.map((p) => norm(p.place)).filter((p) => avoids.some((a) => norm(a.place) === p)),
  )
  if (conflict.size > 0) {
    prefers = prefers.filter((p) => !conflict.has(norm(p.place)))
    avoids = avoids.filter((a) => !conflict.has(norm(a.place)))
  }

  // Same gate as places, one field over: the sentence must be real AND must
  // actually name the asset. Checking only that the quote existed let a lender
  // come back with an asset off a sentence that never named it.
  const assets = (raw.assets ?? []).filter(
    (a) =>
      KNOWN_NOTE_ASSETS.has(norm(a.asset)) &&
      quoted(a.quote) &&
      quoteMentionsAsset(a.quote, a.asset),
  )

  // The quote must also SAY that lending stopped. Without this the model set
  // `paused` on quotes about rates or LTV, far more often than notes actually
  // contain pause language.
  const paused =
    raw.paused && quoted(raw.paused.quote) && quoteReadsAsLendingPause(raw.paused.quote)
      ? { quote: raw.paused.quote }
      : null

  return {
    version: NOTE_SIGNALS_VERSION,
    extracted_at: (meta.now ?? new Date()).toISOString(),
    model: meta.model,
    prefers,
    avoids,
    assets: assets.map((a) => ({ asset: norm(a.asset), quote: a.quote })),
    paused,
  }
}

/** True when the value on the row was produced by the current reader. */
export function isCurrentNoteSignals(v: unknown): v is NoteSignals {
  return (
    !!v &&
    typeof v === 'object' &&
    (v as NoteSignals).version === NOTE_SIGNALS_VERSION &&
    Array.isArray((v as NoteSignals).prefers)
  )
}

/** Cheap shape guard for a value read back out of jsonb. */
export function asNoteSignals(v: unknown): NoteSignals | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Partial<NoteSignals>
  if (!Array.isArray(o.prefers) || !Array.isArray(o.avoids)) return null
  return {
    version: typeof o.version === 'number' ? o.version : 0,
    extracted_at: typeof o.extracted_at === 'string' ? o.extracted_at : '',
    model: typeof o.model === 'string' ? o.model : '',
    prefers: o.prefers,
    avoids: o.avoids,
    assets: Array.isArray(o.assets) ? o.assets : [],
    paused: o.paused ?? null,
    source: typeof o.source === 'string' ? o.source : undefined,
  }
}
