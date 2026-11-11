import { describe, it, expect, vi } from 'vitest'
import {
  extractFromFundingSource,
  extractFromClosedDeal,
  extractFromContact,
  augmentFromText,
} from '../extract'

vi.mock('@/lib/llm/client', () => ({
  llm: {
    object: vi.fn(),
  },
}))
import { llm } from '@/lib/llm/client'

describe('extractFromFundingSource', () => {
  it('emits funder + contact + geo + industry + family + borrower_profile edges', () => {
    const out = extractFromFundingSource({
      id: 'fs-1',
      company_name: 'Altair Bank',
      primary_contact_name: 'Jane Doe',
      primary_contact_title: 'SVP',
      primary_contact_email: 'jane@altair.example.com',
      asset_classes: ['equipment', 'agricultural_equipment'],
      geographic_scope: ['US-FL', 'US-TX'],
      industry_filters: ['logistics', 'construction'],
      borrower_revenue_min_usd: 10_000_000,
    })
    const kinds = out.entities!.map((e) => e.kind).sort()
    expect(kinds).toContain('funder')
    expect(kinds).toContain('contact')
    expect(kinds).toContain('geo')
    expect(kinds).toContain('industry')
    expect(kinds).toContain('asset_family')
    expect(kinds).toContain('borrower_profile')

    const rels = out.edges!.map((e) => e.rel)
    expect(rels).toContain('employs')
    expect(rels).toContain('works_at')
    expect(rels).toContain('operates_in')
    expect(rels).toContain('serves')
    expect(rels).toContain('capped_at')
  })

  it('skips contact when no name/email present', () => {
    const out = extractFromFundingSource({
      id: 'fs-1',
      company_name: 'X',
      primary_contact_name: null,
      primary_contact_title: null,
      primary_contact_email: null,
      asset_classes: null,
      geographic_scope: null,
      industry_filters: null,
      borrower_revenue_min_usd: null,
    })
    expect(out.entities!.find((e) => e.kind === 'contact')).toBeUndefined()
    expect(out.edges!.find((e) => e.rel === 'employs')).toBeUndefined()
  })

  it('dedupes entities with identical natural keys', () => {
    const out = extractFromFundingSource({
      id: 'fs-1',
      company_name: 'X',
      primary_contact_name: null,
      primary_contact_title: null,
      primary_contact_email: null,
      asset_classes: ['equipment', 'equipment'],
      geographic_scope: null,
      industry_filters: null,
      borrower_revenue_min_usd: null,
    })
    const families = out.entities!.filter((e) => e.kind === 'asset_family')
    expect(families.length).toBe(1)
  })

  it('buckets revenue into the correct profile', () => {
    const out = extractFromFundingSource({
      id: 'fs-1',
      company_name: 'X',
      primary_contact_name: null,
      primary_contact_title: null,
      primary_contact_email: null,
      asset_classes: null,
      geographic_scope: null,
      industry_filters: null,
      borrower_revenue_min_usd: 50_000_000,
    })
    const bp = out.entities!.find((e) => e.kind === 'borrower_profile')
    expect(bp?.natural_key).toBe('borrower_profile.25m_100m')
  })
})

describe('extractFromClosedDeal', () => {
  it('builds family + model + is_a + funded edges', () => {
    const out = extractFromClosedDeal({
      id: 'cd-1',
      funding_source_id: 'fs-1',
      asset_year: 1987,
      asset_make: 'Caterpillar',
      asset_model: '320',
      source_kind: 'term_sheet',
    })
    expect(out.entities!.find((e) => e.kind === 'asset_family')?.label).toBe('Caterpillar')
    expect(out.entities!.find((e) => e.kind === 'asset_model')?.label).toBe('Caterpillar 320')
    expect(out.edges!.find((e) => e.rel === 'is_a')).toBeDefined()
    expect(out.edges!.find((e) => e.rel === 'funded')).toBeDefined()
    expect(out.edges!.find((e) => e.rel === 'emitted')).toBeDefined()
  })

  it('emits a family-only funded edge with lower confidence when model is null', () => {
    const out = extractFromClosedDeal({
      id: 'cd-1',
      funding_source_id: 'fs-1',
      asset_year: null,
      asset_make: 'Komatsu',
      asset_model: null,
      source_kind: 'manual',
    })
    const funded = out.edges!.find((e) => e.rel === 'funded')
    expect(funded?.confidence).toBe(0.8)
    expect(out.entities!.find((e) => e.kind === 'asset_model')).toBeUndefined()
  })

  it('returns empty when funding_source_id is null', () => {
    const out = extractFromClosedDeal({
      id: 'cd-1',
      funding_source_id: null,
      asset_year: null,
      asset_make: 'Komatsu',
      asset_model: 'PC210',
      source_kind: 'manual',
    })
    expect(out.entities!).toEqual([])
    expect(out.edges!).toEqual([])
  })

  it('rejects an unknown source_kind without emitting doc edge', () => {
    const out = extractFromClosedDeal({
      id: 'cd-1',
      funding_source_id: 'fs-1',
      asset_year: null,
      asset_make: 'Komatsu',
      asset_model: null,
      source_kind: 'gibberish',
    })
    expect(out.edges!.find((e) => e.rel === 'emitted')).toBeUndefined()
  })
})

describe('extractFromContact', () => {
  it('emits bidirectional contact↔funder', () => {
    const out = extractFromContact({
      id: 'c-1',
      funding_source_id: 'fs-1',
      name: 'Bob',
      title: 'VP',
      email: 'bob@altair.example.com',
    })
    const rels = out.edges!.map((e) => e.rel)
    expect(rels).toContain('employs')
    expect(rels).toContain('works_at')
  })

  it('returns empty when no slug source', () => {
    const out = extractFromContact({
      id: 'c-1',
      funding_source_id: 'fs-1',
      name: null,
      title: null,
      email: null,
    })
    expect(out.entities!).toEqual([])
  })
})

describe('augmentFromText', () => {
  it('returns empty for blank text without LLM call', async () => {
    const out = await augmentFromText({} as never, '', { funding_source_id: 'fs-1' })
    expect(out.entities!).toEqual([])
    expect(llm.object).not.toHaveBeenCalled()
  })

  it('builds edges from LLM output', async () => {
    vi.mocked(llm.object).mockResolvedValue({
      object: {
        geos: ['Texas'],
        asset_families: ['Caterpillar'],
        asset_models: [],
        industries: ['logistics'],
      },
      model: 'qwen2.5:7b-instruct',
      latencyMs: 100,
    })
    const out = await augmentFromText({} as never, 'they love texas logistics caterpillar ops', {
      funding_source_id: 'fs-1',
    })
    expect(out.entities!.find((e) => e.kind === 'geo')?.label).toBe('Texas')
    const augmentEdges = out.edges!.filter((e) => e.metadata?.from === 'llm.augment')
    expect(augmentEdges.length).toBe(3)
    // augmented edges are lower confidence than deterministic ones
    expect(augmentEdges.every((e) => e.confidence! < 1)).toBe(true)
  })
})
