import { z } from 'zod'
import { llm } from '@/lib/llm/client'
import type { SupabaseClient } from '@supabase/supabase-js'

export interface RawContact {
  first_name?: string | null
  last_name?: string | null
  full_name?: string | null
  company?: string | null
  email?: string | null
  title?: string | null
  source_text?: string | null
}

export const normalizedContactSchema = z.object({
  first_name: z.string().min(1).nullable(),
  last_name: z.string().min(1).nullable(),
  full_name: z.string().min(1).nullable(),
  company: z.string().min(1).nullable(),
  email: z.string().email().nullable(),
  title: z.string().nullable(),
  corrections: z.array(
    z.object({
      field: z.string(),
      from: z.string().nullable(),
      to: z.string().nullable(),
      reason: z.string(),
    }),
  ),
  confidence: z.number().min(0).max(1),
})

export type NormalizedContact = z.infer<typeof normalizedContactSchema>

const SYSTEM = `You clean up imported B2B contact records that have data-entry mistakes from upstream systems (CRM exports, email signatures, business cards). Common defects:
- Digits or random characters mixed into the first name (e.g. "Patdoe56" → "Pat").
- Company name jumbled / partial / has email-domain remnants ("BradleySampleton-Leasing" → "Bradley Sampleton Leasing"; "gmail.com" is not a company).
- First/last swapped.
- Title pasted into the name field.
- "Sent from my iPhone" or signature debris in any field.

For each defect found, return a corrections entry with field, from, to, and a one-line reason.
Trust the email address when guessing company (skip generic providers gmail/yahoo/outlook/icloud/hotmail/aol/proton). Preserve correct values verbatim. Set fields to null only when there is genuinely no signal.

Return JSON matching the schema exactly. Set confidence ∈ [0,1] based on signal strength.`

function isObviouslyMalformed(c: RawContact): boolean {
  const tests = [
    /\d/.test(c.first_name ?? ''),
    /\d/.test(c.last_name ?? ''),
    (c.first_name?.length ?? 0) > 30,
    (c.last_name?.length ?? 0) > 30,
    (c.company ?? '').includes('@'),
    /sent from my/i.test(c.full_name ?? c.first_name ?? ''),
    /sent from my/i.test(c.company ?? ''),
    !c.full_name && !c.first_name && !c.last_name,
  ]
  return tests.some(Boolean)
}

/** Cheap heuristic — most clean contacts don't need an LLM call. */
export function needsNormalization(c: RawContact): boolean {
  return isObviouslyMalformed(c)
}

export async function normalizeContact(
  supabase: SupabaseClient,
  raw: RawContact,
): Promise<NormalizedContact> {
  const prompt = `Input contact (JSON):
${JSON.stringify(raw, null, 2)}

Output a single JSON object matching the schema.`

  const { object } = await llm.object<NormalizedContact>({
    schema: normalizedContactSchema,
    system: SYSTEM,
    prompt,
    supabase,
    module: 'contacts.normalize',
  })
  return object
}
