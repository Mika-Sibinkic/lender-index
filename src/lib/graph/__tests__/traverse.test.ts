import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/llm/client', () => ({
  llm: {
    object: vi.fn(),
  },
}))
import { llm } from '@/lib/llm/client'
import { extractQuerySeeds, graphRankFunders } from '../traverse'
import { naturalKeys } from '../types'

describe('extractQuerySeeds', () => {
  it('returns empty for blank query', async () => {
    const out = await extractQuerySeeds({} as never, '')
    expect(out).toEqual([])
    expect(llm.object).not.toHaveBeenCalled()
  })

  it('maps LLM output to natural-keys', async () => {
    vi.mocked(llm.object).mockResolvedValue({
      object: {
        geos: ['Texas'],
        asset_families: ['Caterpillar'],
        asset_models: ['Caterpillar 320'],
        industries: ['logistics'],
        funder_names: [],
      },
      model: 'qwen2.5:3b',
      latencyMs: 100,
    })
    const seeds = await extractQuerySeeds({} as never, '1987 caterpillar for logistics in texas')
    expect(seeds).toContain(naturalKeys.geo('Texas'))
    expect(seeds).toContain(naturalKeys.asset_family('Caterpillar'))
    expect(seeds).toContain(naturalKeys.asset_model('Caterpillar 320'))
    expect(seeds).toContain(naturalKeys.industry('logistics'))
  })

  it('dedupes the seed list', async () => {
    vi.mocked(llm.object).mockResolvedValue({
      object: {
        geos: ['Texas', 'Texas'],
        asset_families: [],
        asset_models: [],
        industries: [],
        funder_names: [],
      },
      model: 'q',
      latencyMs: 0,
    })
    const seeds = await extractQuerySeeds({} as never, 'tx')
    expect(seeds.length).toBe(1)
  })
})

describe('graphRankFunders', () => {
  it('returns empty result without DB call when no seeds parsed', async () => {
    vi.mocked(llm.object).mockResolvedValue({
      object: {
        geos: [],
        asset_families: [],
        asset_models: [],
        industries: [],
        funder_names: [],
      },
      model: 'q',
      latencyMs: 0,
    })
    const sb = { from: vi.fn(), rpc: vi.fn() } as never
    const out = await graphRankFunders(sb, 'gibberish query')
    expect(out.funderIds).toEqual([])
    expect(out.hits).toEqual([])
  })

  it('walks the graph when seeds resolve', async () => {
    vi.mocked(llm.object).mockResolvedValue({
      object: {
        geos: ['Texas'],
        asset_families: [],
        asset_models: [],
        industries: [],
        funder_names: [],
      },
      model: 'q',
      latencyMs: 0,
    })
    const inFn = vi.fn(() =>
      Promise.resolve({ data: [{ id: 'ent-1' }], error: null }),
    )
    const select = vi.fn(() => ({ in: inFn }))
    const from = vi.fn(() => ({ select }))
    const rpc = vi.fn(() =>
      Promise.resolve({
        data: [
          {
            funder_uuid: 'fs-1',
            score: 42.5,
            hops: ['operates_in'],
            seeds: ['geo.TEXAS'],
          },
        ],
        error: null,
      }),
    )
    const sb = { from, rpc } as never
    const out = await graphRankFunders(sb, 'tx')
    expect(out.funderIds).toEqual(['fs-1'])
    expect(out.hits[0].score).toBe(42.5)
    expect(rpc).toHaveBeenCalledWith('graph_traverse_funders', expect.objectContaining({
      seed_ids: ['ent-1'],
      max_hops: 3,
    }))
  })
})
