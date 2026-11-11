import { describe, it, expect, vi } from 'vitest'
import {
  inferType,
  proposeUnmappedFields,
  KNOWN_FUNDING_SOURCE_FIELDS,
} from './schema-extension'

describe('inferType', () => {
  it('detects numerics, booleans, dates, jsonb, text', () => {
    expect(inferType(42)).toBe('numeric')
    expect(inferType(true)).toBe('boolean')
    expect(inferType('2026-05-14')).toBe('date')
    expect(inferType('2026-05-14T10:00')).toBe('date')
    expect(inferType({ a: 1 })).toBe('jsonb')
    expect(inferType('hello')).toBe('text')
    expect(inferType(new Date())).toBe('date')
  })
})

function mockSupabase() {
  const update = vi.fn().mockReturnValue({
    eq: vi.fn().mockResolvedValue({ error: null }),
  })
  // insert(...).select('id').single() chain — used when creating a new
  // proposed_field row; returns a synthetic uuid so the caller can
  // attach it to the response.
  let insertId = 0
  const insertSingle = vi.fn(() =>
    Promise.resolve({ data: { id: `pf-mock-${++insertId}` }, error: null }),
  )
  const insertSelect = vi.fn(() => ({ single: insertSingle }))
  const insert = vi.fn(() => ({ select: insertSelect }))
  const maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null })
  const eq2 = vi.fn(() => ({ maybeSingle }))
  const eq1 = vi.fn(() => ({ eq: eq2 }))
  const select = vi.fn(() => ({ eq: eq1 }))
  const from = vi.fn(() => ({ select, insert, update }))
  return { client: { from } as never, insert, update, maybeSingle }
}

describe('proposeUnmappedFields', () => {
  it('returns [] when nothing is unmapped', async () => {
    const { client } = mockSupabase()
    const out = await proposeUnmappedFields(
      client,
      { company_name: 'X', primary_contact_email: 'a@b.com' },
      KNOWN_FUNDING_SOURCE_FIELDS,
    )
    expect(out).toEqual([])
  })

  it('inserts a pending row for a brand-new field', async () => {
    const { client, insert } = mockSupabase()
    const out = await proposeUnmappedFields(
      client,
      { prepayment_penalty: '3% Y1, 2% Y2' },
      new Set(['company_name']),
    )
    expect(out).toEqual([
      expect.objectContaining({
        name: 'prepayment_penalty',
        data_type: 'text',
        example_value: '3% Y1, 2% Y2',
        id: expect.stringMatching(/^pf-mock-/),
      }),
    ])
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'prepayment_penalty', data_type: 'text' }),
    )
  })

  it('skips null / empty values', async () => {
    const { client, insert } = mockSupabase()
    const out = await proposeUnmappedFields(
      client,
      { foo: null, bar: '', baz: undefined, qux: 0 },
      new Set([]),
    )
    expect(out.map((p) => p.name)).toEqual(['qux'])
    expect(insert).toHaveBeenCalledTimes(1)
  })

  it('infers numeric, jsonb, date types', async () => {
    const { client, insert } = mockSupabase()
    await proposeUnmappedFields(
      client,
      { months_to_close: 4, fees: { origination: 0.005 }, accepted_at: '2026-05-14' },
      new Set(),
    )
    const types = (insert.mock.calls as unknown[][]).map(
      (c) => (c[0] as { data_type: string }).data_type,
    )
    expect(types).toEqual(['numeric', 'jsonb', 'date'])
  })

  it('bumps occurrences when a pending proposal exists', async () => {
    const update = vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) })
    const insertSingle = vi.fn(() => Promise.resolve({ data: null, error: null }))
    const insertSelect = vi.fn(() => ({ single: insertSingle }))
    const insert = vi.fn(() => ({ select: insertSelect }))
    const maybeSingle = vi
      .fn()
      .mockResolvedValue({ data: { id: 'pf-existing', occurrences: 2, status: 'pending' }, error: null })
    const eq2 = vi.fn(() => ({ maybeSingle }))
    const eq1 = vi.fn(() => ({ eq: eq2 }))
    const select = vi.fn(() => ({ eq: eq1 }))
    const from = vi.fn(() => ({ select, insert, update }))
    const client = { from } as never

    const out = await proposeUnmappedFields(
      client,
      { prepayment_penalty: '2%' },
      new Set(),
    )
    expect(update).toHaveBeenCalledWith({ occurrences: 3 })
    expect(insert).not.toHaveBeenCalled()
    expect(out[0].id).toBe('pf-existing')
  })
})
