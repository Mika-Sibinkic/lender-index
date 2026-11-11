/**
 * LLM-as-reranker — listwise.
 *
 * The reranker is a small local instruct model (qwen2.5:3b-instruct) via
 * llm.object. Listwise
 * (single call ranks the whole candidate set) beats pairwise on a
 * 2c/4t CPU by 25-625× depending on N.
 *
 * Input: query + array of candidate { id, label, summary } objects.
 * Output: a re-ordered id array. Missing/extra ids in the model
 * response are reconciled to match the input set so the caller always
 * gets exactly N ids back.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { llm } from '@/lib/llm/client'
import { DOMAIN_DESCRIPTION } from '@/lib/config/domain'

export interface RerankCandidate {
  id: string
  label: string
  summary: string
}

const RerankOutputSchema = z.object({
  ranked_ids: z.array(z.string()).default([]),
})

const SYSTEM = `You are ranking ${DOMAIN_DESCRIPTION} candidates against a user query.

Return ONLY JSON matching the schema. List the candidate ids in order of relevance — most relevant first. Use the EXACT id strings provided; do not invent ids.

Ranking signals (in order of weight):
1. Does the candidate's stated deal range, asset class, and geography match what the query asks for? Hard match > soft fit.
2. Does the candidate's notes mention the borrower profile or asset make/model in the query?
3. If the query mentions a specific asset model + year, candidates known to have funded similar deals rank higher.
4. Generic / catch-all candidates rank lower than specialists when the query is specific.

Tie-break: keep the input order.`

export async function rerankCandidates(
  supabase: SupabaseClient,
  query: string,
  candidates: RerankCandidate[],
  opts: { limit?: number } = {},
): Promise<string[]> {
  if (candidates.length <= 1) return candidates.map((c) => c.id)
  const limit = opts.limit ?? candidates.length

  const promptBody = candidates
    .map(
      (c, i) =>
        `${i + 1}. id=${c.id}\n   label: ${c.label}\n   summary: ${c.summary.replace(/\s+/g, ' ').slice(0, 240)}`,
    )
    .join('\n\n')

  const prompt = `Query: ${query.slice(0, 400)}\n\nCandidates:\n\n${promptBody}\n\nReturn the ${limit} most relevant ids in order, most relevant first.`

  try {
    const { object } = await llm.object({
      supabase,
      module: 'search.rerank',
      schema: RerankOutputSchema,
      system: SYSTEM,
      prompt,
    })
    return reconcileIds(
      object.ranked_ids,
      candidates.map((c) => c.id),
      limit,
    )
  } catch (e) {
    console.warn(`rerank failed, falling back to input order: ${(e as Error).message}`)
    return candidates.slice(0, limit).map((c) => c.id)
  }
}

/**
 * Reconcile the model's id list against the input set so the caller
 * always sees exactly the requested ids in some order:
 *   - drop any model-emitted id that isn't in the input set
 *   - append any input id the model dropped, preserving input order
 *   - cap at `limit`
 */
export function reconcileIds(
  modelOrder: string[],
  inputIds: string[],
  limit: number,
): string[] {
  const inputSet = new Set(inputIds)
  const seen = new Set<string>()
  const out: string[] = []
  for (const id of modelOrder) {
    if (inputSet.has(id) && !seen.has(id)) {
      out.push(id)
      seen.add(id)
    }
  }
  for (const id of inputIds) {
    if (!seen.has(id)) {
      out.push(id)
      seen.add(id)
    }
  }
  return out.slice(0, limit)
}
