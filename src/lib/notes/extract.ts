/**
 * Read a lender's `internal_notes` into typed signals with the on-prem model.
 *
 * Sizing: roster notes are short, typically under a few hundred characters.
 * That is roughly 20-110 tokens per call — far below the document-intake
 * payloads and well inside a reverse proxy's ~120s request timeout.
 *
 * The system prompt is a module constant and byte-identical on every call, so a
 * batch run reuses the prefix cache the same way the extraction path does.
 */

import { llm, type LlmCallContext } from '@/lib/llm/client'
import { ASSET_CLASS_IDS, DOMAIN_DESCRIPTION } from '@/lib/config/domain'
import {
  noteSignalsExtractionSchema,
  validateNoteSignals,
  type NoteSignals,
} from './signals'

/**
 * Rules, not examples of output.
 *
 * "Copy the words" is stated three times on purpose: the quote is the only
 * thing standing between a hallucinated criterion and the ranking, and
 * validateNoteSignals discards any entry whose quote is not literally in the
 * note. A model that paraphrases produces nothing rather than something wrong.
 */
export const NOTE_SIGNALS_SYSTEM_PROMPT = `You read one ${DOMAIN_DESCRIPTION} lender's internal notes and report only what the notes literally say about WHERE they lend, WHAT they finance, and WHETHER they are currently lending.

Rules:
- Every item must include a "quote" copied word for word from the note. Do not reword, shorten or tidy it. If you cannot copy the words, leave the item out.
- "prefers": places the lender is based in, focused on, or says it prefers. "Headquartered in Ohio", "Prefers GA deals and the Southeast", "Pacific Northwest only", "Colorado and neighboring states" all count.
- "avoids": places the note says they will not lend in or do not like. "No deals in Canada", "No deals in HI or AK", "cannot consider Japan", "does not like South America" all count.
- A place is a US state, a US region, or a country. Do not invent a place the note does not name.
- Being headquartered somewhere is a preference, not an exclusion. It never goes in "avoids".
- "assets": only these asset class ids: ${ASSET_CLASS_IDS.filter((id) => id !== 'other').join(', ')}, and only when the note says they finance it.
- "paused": only when the note says lending is stopped, paused, on hold, or no longer offered.
- Notes about rates, terms, LTV, amortisation, fees, usage percentages, asset age, credit quality or industries are NOT any of these. Ignore them.
- Report nothing rather than something you are unsure of. Empty lists are the correct answer for most notes.`

export interface ExtractNoteSignalsResult {
  signals: NoteSignals
  latencyMs: number
  /** Entries the model returned that failed the verbatim-quote check. */
  rejected: number
}

export async function extractNoteSignals(
  ctx: LlmCallContext,
  notes: string,
): Promise<ExtractNoteSignalsResult> {
  const res = await llm.object({
    ...ctx,
    schema: noteSignalsExtractionSchema,
    system: NOTE_SIGNALS_SYSTEM_PROMPT,
    prompt: `Lender notes:\n"""\n${notes}\n"""`,
  })

  const signals = validateNoteSignals(notes, res.object, { model: res.model })

  const offered =
    (res.object.prefers?.length ?? 0) +
    (res.object.avoids?.length ?? 0) +
    (res.object.assets?.length ?? 0) +
    (res.object.paused ? 1 : 0)
  const kept =
    signals.prefers.length +
    signals.avoids.length +
    signals.assets.length +
    (signals.paused ? 1 : 0)

  return { signals, latencyMs: res.latencyMs, rejected: Math.max(0, offered - kept) }
}
