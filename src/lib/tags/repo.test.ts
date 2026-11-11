import { describe, it, expect, vi } from 'vitest'
import {
  applyTag,
  removeTag,
  listTags,
  ensureTag,
  tagsForSource,
  sourceIdsWithTags,
} from './repo'

interface ChainStub {
  select?: () => ChainStub
  upsert?: (...args: unknown[]) => ChainStub
  insert?: (...args: unknown[]) => ChainStub
  delete?: () => ChainStub
  eq?: (...args: unknown[]) => ChainStub
  in?: (...args: unknown[]) => ChainStub
  order?: () => ChainStub
  single?: () => Promise<unknown>
  then?: (cb: (v: unknown) => unknown) => Promise<unknown>
}

function ok<T>(value: T) {
  return Promise.resolve({ data: value, error: null })
}

describe('listTags', () => {
  it('selects from tag ordered by name', async () => {
    const order = vi.fn(() => ok([{ id: '1', name: 'a' }]))
    const select = vi.fn(() => ({ order }))
    const from = vi.fn(() => ({ select }))
    const sb = { from } as never
    const result = await listTags(sb)
    expect(from).toHaveBeenCalledWith('tag')
    expect(order).toHaveBeenCalledWith('name')
    expect(result).toEqual([{ id: '1', name: 'a' }])
  })
})

describe('ensureTag', () => {
  it('upserts on the name conflict key and returns the row', async () => {
    const single = vi.fn(() => ok({ id: 'tag-1', name: 'preferred', color: 'green' }))
    const select = vi.fn(() => ({ single }))
    const upsert = vi.fn(() => ({ select }))
    const from = vi.fn(() => ({ upsert }))
    const sb = { from } as never
    const out = await ensureTag(sb, { name: 'preferred', color: 'green' })
    expect(upsert).toHaveBeenCalledWith(
      { name: 'preferred', color: 'green', semantic: null },
      { onConflict: 'name', ignoreDuplicates: false },
    )
    expect(out.id).toBe('tag-1')
  })
})

describe('applyTag', () => {
  it('upserts on the (funding_source_id, tag_id) pair', async () => {
    const upsert = vi.fn(() => Promise.resolve({ error: null }))
    const from = vi.fn(() => ({ upsert }))
    const sb = { from } as never
    await applyTag(sb, { fundingSourceId: 'fs-1', tagId: 't-1', userId: 'u-1' })
    expect(from).toHaveBeenCalledWith('funding_source_tag')
    expect(upsert).toHaveBeenCalledWith(
      { funding_source_id: 'fs-1', tag_id: 't-1', applied_by: 'u-1' },
      { onConflict: 'funding_source_id,tag_id', ignoreDuplicates: true },
    )
  })

  it('throws when supabase returns an error', async () => {
    const upsert = vi.fn(() => Promise.resolve({ error: { message: 'rls denied' } }))
    const from = vi.fn(() => ({ upsert }))
    const sb = { from } as never
    await expect(
      applyTag(sb, { fundingSourceId: 'fs-1', tagId: 't-1', userId: 'u-1' }),
    ).rejects.toThrow(/rls denied/)
  })
})

describe('removeTag', () => {
  it('deletes by both ids', async () => {
    const eq2 = vi.fn(() => Promise.resolve({ error: null }))
    const eq1 = vi.fn(() => ({ eq: eq2 }))
    const del = vi.fn(() => ({ eq: eq1 }))
    const from = vi.fn(() => ({ delete: del }))
    const sb = { from } as never
    await removeTag(sb, { fundingSourceId: 'fs-1', tagId: 't-1' })
    expect(eq1).toHaveBeenCalledWith('funding_source_id', 'fs-1')
    expect(eq2).toHaveBeenCalledWith('tag_id', 't-1')
  })
})

describe('sourceIdsWithTags', () => {
  it('returns empty for empty input', async () => {
    const sb = { from: vi.fn() } as never
    const ids = await sourceIdsWithTags(sb, [])
    expect(ids).toEqual([])
  })

  it('dedupes the funding_source_ids', async () => {
    const inSel = vi.fn(() =>
      ok([
        { funding_source_id: 'fs-1' },
        { funding_source_id: 'fs-2' },
        { funding_source_id: 'fs-1' },
      ]),
    )
    const select = vi.fn(() => ({ in: inSel }))
    const from = vi.fn(() => ({ select }))
    const sb = { from } as never
    const ids = await sourceIdsWithTags(sb, ['t-1', 't-2'])
    expect(ids.sort()).toEqual(['fs-1', 'fs-2'])
  })
})

describe('tagsForSource', () => {
  it('flattens the join to AppliedTag rows', async () => {
    const eq = vi.fn(() =>
      ok([
        {
          applied_at: '2026-05-14',
          applied_by: 'u',
          tag: { id: 't-1', name: 'preferred', color: 'green', semantic: null, created_at: '' },
        },
      ]),
    )
    const select = vi.fn(() => ({ eq }))
    const from = vi.fn(() => ({ select }))
    const sb = { from } as never
    const out = await tagsForSource(sb, 'fs-1')
    expect(out).toHaveLength(1)
    expect(out[0].name).toBe('preferred')
    expect(out[0].applied_at).toBe('2026-05-14')
  })
})
