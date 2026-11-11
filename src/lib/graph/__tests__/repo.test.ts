import { describe, it, expect, vi } from 'vitest'
import {
  upsertEntity,
  upsertEntities,
  upsertEdges,
  deleteEdgesBySource,
  findEntitiesByLabel,
  getEntityByNaturalKey,
} from '../repo'

function mkChain<T>(returns: { data?: T; error?: { message: string } | null }) {
  return Promise.resolve({ data: returns.data ?? null, error: returns.error ?? null })
}

describe('upsertEntity', () => {
  it('upserts on natural_key and returns the row', async () => {
    const single = vi.fn(() =>
      mkChain({ data: { id: 'e-1', kind: 'funder', natural_key: 'funder.x', label: 'X', metadata: {} } }),
    )
    const select = vi.fn(() => ({ single }))
    const upsert = vi.fn(() => ({ select }))
    const from = vi.fn(() => ({ upsert }))
    const sb = { from } as never
    const out = await upsertEntity(sb, {
      kind: 'funder',
      natural_key: 'funder.x',
      label: 'X',
    })
    expect(out.id).toBe('e-1')
    expect(upsert).toHaveBeenCalled()
    // vi.fn() with no declared signature types its calls as an empty tuple.
    const call = upsert.mock.calls[0] as unknown[]
    expect(call[1]).toEqual({ onConflict: 'natural_key' })
  })

  it('rejects schema-invalid input before hitting DB', async () => {
    const from = vi.fn()
    const sb = { from } as never
    await expect(
      upsertEntity(sb, { kind: 'NOPE' as never, natural_key: 'x', label: 'y' }),
    ).rejects.toThrow()
    expect(from).not.toHaveBeenCalled()
  })
})

describe('upsertEntities', () => {
  it('returns [] without a DB call for empty input', async () => {
    const from = vi.fn()
    const sb = { from } as never
    expect(await upsertEntities(sb, [])).toEqual([])
    expect(from).not.toHaveBeenCalled()
  })
})

describe('upsertEdges', () => {
  it('resolves natural-keys to ids and inserts edges', async () => {
    let calls = 0
    const from = vi.fn(() => {
      calls += 1
      if (calls === 1) {
        // resolve step
        const inFn = vi.fn(() =>
          mkChain({
            data: [
              { id: 'f-1', natural_key: 'funder.x' },
              { id: 'a-1', natural_key: 'asset_model.caterpillar_320' },
            ],
          }),
        )
        const select = vi.fn(() => ({ in: inFn }))
        return { select }
      }
      // edge insert
      const insert = vi.fn(() => mkChain({ data: null }))
      return { insert }
    })
    const sb = { from } as never
    const n = await upsertEdges(sb, [
      {
        src_natural_key: 'funder.x',
        dst_natural_key: 'asset_model.caterpillar_320',
        rel: 'funded',
        source_table: 'closed_deal',
        confidence: 1,
        weight: 1,
        metadata: {},
      },
    ])
    expect(n).toBe(1)
    expect(from).toHaveBeenCalledTimes(2)
  })

  it('skips edges whose endpoints did not resolve, warns', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const from = vi.fn(() => {
      // resolve returns nothing
      const inFn = vi.fn(() => mkChain({ data: [] }))
      const select = vi.fn(() => ({ in: inFn }))
      return { select }
    })
    const sb = { from } as never
    const n = await upsertEdges(sb, [
      {
        src_natural_key: 'funder.x',
        dst_natural_key: 'geo.US',
        rel: 'operates_in',
        source_table: 'funding_sources',
        confidence: 1,
        weight: 1,
        metadata: {},
      },
    ])
    expect(n).toBe(0)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('returns 0 for empty input without DB call', async () => {
    const from = vi.fn()
    const sb = { from } as never
    expect(await upsertEdges(sb, [])).toBe(0)
    expect(from).not.toHaveBeenCalled()
  })
})

describe('deleteEdgesBySource', () => {
  it('chains delete().eq().eq() correctly', async () => {
    const eq2 = vi.fn(() => mkChain({}))
    const eq1 = vi.fn(() => ({ eq: eq2 }))
    const del = vi.fn(() => ({ eq: eq1 }))
    const from = vi.fn(() => ({ delete: del }))
    const sb = { from } as never
    await deleteEdgesBySource(sb, 'funding_sources', 'fs-1')
    expect(eq1).toHaveBeenCalledWith('source_table', 'funding_sources')
    expect(eq2).toHaveBeenCalledWith('source_id', 'fs-1')
  })
})

describe('findEntitiesByLabel', () => {
  it('escapes ilike wildcards and applies kinds filter', async () => {
    const limit = vi.fn(() => mkChain({ data: [] }))
    const inFn = vi.fn(() => ({ limit }))
    const ilike = vi.fn(() => ({ in: inFn, limit }))
    const select = vi.fn(() => ({ ilike }))
    const from = vi.fn(() => ({ select }))
    const sb = { from } as never
    await findEntitiesByLabel(sb, '100%bank', { kinds: ['funder'] })
    expect(ilike).toHaveBeenCalledWith('label', '%100\\%bank%')
    expect(inFn).toHaveBeenCalledWith('kind', ['funder'])
  })
})

describe('getEntityByNaturalKey', () => {
  it('returns null when not found', async () => {
    const maybeSingle = vi.fn(() => mkChain({ data: null }))
    const eq = vi.fn(() => ({ maybeSingle }))
    const select = vi.fn(() => ({ eq }))
    const from = vi.fn(() => ({ select }))
    const sb = { from } as never
    expect(await getEntityByNaturalKey(sb, 'funder.missing')).toBeNull()
  })
})
