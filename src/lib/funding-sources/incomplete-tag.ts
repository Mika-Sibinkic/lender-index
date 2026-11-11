/**
 * The `incomplete` tag, kept in step with the record's actual gaps.
 *
 * "Save incomplete" already stored `required_field_gaps`, which drives a badge
 * on the card — but nothing tagged the record, so the one place the team
 * filters and scans from, the tag row, could not answer "what still needs
 * finishing". The button said it flagged the lender for later and then did not
 * flag it anywhere the team looks.
 *
 * Applied AND removed from the same helper on both the create and the update
 * path, because a tag that is only ever added becomes a lie the moment someone
 * fills the missing fields in — the same class of "screen disagrees with the
 * system" defect as a stale fit chip.
 *
 * Never throws: a tagging failure must not fail the operator's save. The record
 * and its `required_field_gaps` are the source of truth; the tag is the index.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { ensureTag, applyTag, removeTag } from '@/lib/tags/repo'

export const INCOMPLETE_TAG = 'incomplete'

export async function syncIncompleteTag(
  supabase: SupabaseClient,
  input: { fundingSourceId: string; gaps: string[] | null | undefined; userId: string | null },
): Promise<void> {
  try {
    const tag = await ensureTag(supabase, {
      name: INCOMPLETE_TAG,
      color: 'amber',
      semantic: 'required fields still empty',
    })
    if ((input.gaps ?? []).length > 0) {
      await applyTag(supabase, {
        fundingSourceId: input.fundingSourceId,
        tagId: tag.id,
        userId: input.userId,
      })
    } else {
      await removeTag(supabase, { fundingSourceId: input.fundingSourceId, tagId: tag.id })
    }
  } catch (e) {
    console.warn('syncIncompleteTag failed:', e instanceof Error ? e.message : e)
  }
}
