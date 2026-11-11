/**
 * Tag CRUD against Supabase.
 *
 * Tags preserve the color semantics of the roster spreadsheet
 * (red = bad contact, etc.) as first-class data — see migration 0002.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export type TagColor = 'red' | 'amber' | 'green' | 'blue' | 'violet' | 'slate'

export interface Tag {
  id: string
  name: string
  color: TagColor
  semantic: string | null
  created_at: string
}

export interface AppliedTag extends Tag {
  applied_at: string
  applied_by: string | null
}

export async function listTags(supabase: SupabaseClient): Promise<Tag[]> {
  const { data, error } = await supabase.from('tag').select('*').order('name')
  if (error) throw new Error(`listTags: ${error.message}`)
  return (data ?? []) as Tag[]
}

export async function ensureTag(
  supabase: SupabaseClient,
  input: { name: string; color: TagColor; semantic?: string | null },
): Promise<Tag> {
  const { data, error } = await supabase
    .from('tag')
    .upsert(
      { name: input.name, color: input.color, semantic: input.semantic ?? null },
      { onConflict: 'name', ignoreDuplicates: false },
    )
    .select('*')
    .single()
  if (error) throw new Error(`ensureTag(${input.name}): ${error.message}`)
  return data as Tag
}

export async function applyTag(
  supabase: SupabaseClient,
  input: { fundingSourceId: string; tagId: string; userId: string | null },
): Promise<void> {
  const { error } = await supabase.from('funding_source_tag').upsert(
    {
      funding_source_id: input.fundingSourceId,
      tag_id: input.tagId,
      applied_by: input.userId,
    },
    { onConflict: 'funding_source_id,tag_id', ignoreDuplicates: true },
  )
  if (error) throw new Error(`applyTag: ${error.message}`)
}

export async function removeTag(
  supabase: SupabaseClient,
  input: { fundingSourceId: string; tagId: string },
): Promise<void> {
  const { error } = await supabase
    .from('funding_source_tag')
    .delete()
    .eq('funding_source_id', input.fundingSourceId)
    .eq('tag_id', input.tagId)
  if (error) throw new Error(`removeTag: ${error.message}`)
}

export async function tagsForSource(
  supabase: SupabaseClient,
  fundingSourceId: string,
): Promise<AppliedTag[]> {
  type RawJoin = {
    applied_at: string
    applied_by: string | null
    tag: Tag | Tag[] | null
  }
  const { data, error } = await supabase
    .from('funding_source_tag')
    .select('applied_at, applied_by, tag:tag_id ( id, name, color, semantic, created_at )')
    .eq('funding_source_id', fundingSourceId)
  if (error) throw new Error(`tagsForSource: ${error.message}`)
  const out: AppliedTag[] = []
  for (const row of (data ?? []) as unknown as RawJoin[]) {
    const t = row.tag
    if (!t) continue
    const flat = Array.isArray(t) ? t[0] : t
    if (!flat) continue
    out.push({ ...flat, applied_at: row.applied_at, applied_by: row.applied_by })
  }
  return out
}

export async function sourceIdsWithTags(
  supabase: SupabaseClient,
  tagIds: string[],
): Promise<string[]> {
  if (tagIds.length === 0) return []
  const { data, error } = await supabase
    .from('funding_source_tag')
    .select('funding_source_id')
    .in('tag_id', tagIds)
  if (error) throw new Error(`sourceIdsWithTags: ${error.message}`)
  return [...new Set((data ?? []).map((r: { funding_source_id: string }) => r.funding_source_id))]
}
