import { describe, it, expect } from 'vitest'
import {
  ENTITY_KINDS,
  EDGE_RELS,
  EntityInputSchema,
  EdgeInputSchema,
  ExtractionResultSchema,
  naturalKeys,
  slugify,
  bucketRevenue,
} from '../types'

describe('taxonomies', () => {
  it('exposes 8 entity kinds', () => {
    expect(ENTITY_KINDS.length).toBe(8)
    expect(new Set(ENTITY_KINDS).size).toBe(8)
  })
  it('exposes 8 edge relations', () => {
    expect(EDGE_RELS.length).toBe(8)
    expect(new Set(EDGE_RELS).size).toBe(8)
  })
})

describe('EntityInputSchema', () => {
  it('accepts a well-formed entity', () => {
    const out = EntityInputSchema.parse({
      kind: 'funder',
      natural_key: 'funder.abc-123',
      label: 'Altair Bank',
    })
    expect(out.metadata).toEqual({})
  })
  it('rejects an unknown kind', () => {
    expect(() =>
      EntityInputSchema.parse({
        kind: 'planet',
        natural_key: 'x',
        label: 'y',
      }),
    ).toThrow()
  })
  it('rejects a natural_key with disallowed chars', () => {
    expect(() =>
      EntityInputSchema.parse({
        kind: 'geo',
        natural_key: 'geo. US!',                  // space + !
        label: 'US',
      }),
    ).toThrow()
  })

  it('allows @ and + in natural_key (email-derived contacts)', () => {
    expect(() =>
      EntityInputSchema.parse({
        kind: 'contact',
        natural_key: 'contact.jane+ops@bank.example',
        label: 'Jane',
      }),
    ).not.toThrow()
  })
})

describe('EdgeInputSchema', () => {
  it('defaults confidence + weight to 1', () => {
    const out = EdgeInputSchema.parse({
      src_natural_key: 'funder.x',
      dst_natural_key: 'asset_model.caterpillar_320',
      rel: 'funded',
      source_table: 'closed_deal',
    })
    expect(out.confidence).toBe(1)
    expect(out.weight).toBe(1)
  })
  it('rejects confidence out of range', () => {
    expect(() =>
      EdgeInputSchema.parse({
        src_natural_key: 'a',
        dst_natural_key: 'b',
        rel: 'funded',
        source_table: 't',
        confidence: 1.5,
      }),
    ).toThrow()
  })
})

describe('ExtractionResultSchema', () => {
  it('treats empty arrays as the default', () => {
    const out = ExtractionResultSchema.parse({})
    expect(out.entities).toEqual([])
    expect(out.edges).toEqual([])
  })
})

describe('naturalKeys', () => {
  it('uppercases geo regions', () => {
    expect(naturalKeys.geo('US-fl')).toBe('geo.US-FL')
    expect(naturalKeys.geo('north east')).toBe('geo.NORTH_EAST')
  })
  it('lowercases contact slugs', () => {
    expect(naturalKeys.contact('Jane.Doe@Bank.example')).toBe('contact.jane.doe@bank.example')
  })
  it('slugifies asset models', () => {
    expect(naturalKeys.asset_model('Caterpillar 320')).toBe('asset_model.caterpillar_320')
  })
})

describe('slugify', () => {
  it('lowercases + underscores spaces', () => {
    expect(slugify('John  Deere 8R')).toBe('john_deere_8r')
  })
  it('caps length to 80', () => {
    expect(slugify('a'.repeat(200)).length).toBe(80)
  })
})

describe('bucketRevenue', () => {
  it('buckets correctly', () => {
    expect(bucketRevenue(0)).toBe('lt_5m')
    expect(bucketRevenue(4_999_999)).toBe('lt_5m')
    expect(bucketRevenue(5_000_000)).toBe('5m_25m')
    expect(bucketRevenue(50_000_000)).toBe('25m_100m')
    expect(bucketRevenue(500_000_000)).toBe('gt_100m')
    expect(bucketRevenue(null)).toBeNull()
    expect(bucketRevenue(undefined)).toBeNull()
  })
})
