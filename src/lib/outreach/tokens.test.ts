import { describe, it, expect, vi } from 'vitest'
import { mintActionToken, validateAndConsumeActionToken } from './tokens'

type Row = {
  token: string
  run_id: string
  action: 'approve' | 'decline'
  expires_at: string
  used_at: string | null
  used_from_ip: string | null
}

function fakeSupabase(initial: Row[] = []) {
  const rows = [...initial]
  return {
    rows,
    from(_table: string) {
      let chain: {
        op: 'select' | 'insert' | 'update'
        payload?: Partial<Row>
        filters: Array<(r: Row) => boolean>
      } = { op: 'select', filters: [] }
      const api: any = {
        insert: (record: Row) => {
          chain = { op: 'insert', payload: record, filters: [] }
          rows.push(record)
          return Promise.resolve({ error: null })
        },
        select: (_cols?: string) => {
          chain = {
            op: chain.op === 'update' ? 'update' : 'select',
            payload: chain.payload,
            filters: chain.filters,
          }
          return api
        },
        update: (payload: Partial<Row>) => {
          chain = { op: 'update', payload, filters: [] }
          return api
        },
        eq: (col: keyof Row, val: unknown) => {
          chain.filters.push((r) => r[col] === val)
          return api
        },
        is: (col: keyof Row, val: null) => {
          chain.filters.push((r) => r[col] === val)
          return api
        },
        maybeSingle: () => {
          const matched = rows.filter((r) => chain.filters.every((f) => f(r)))
          if (chain.op === 'update' && matched.length > 0) {
            Object.assign(matched[0], chain.payload ?? {})
            return Promise.resolve({ data: matched[0], error: null })
          }
          if (chain.op === 'update') return Promise.resolve({ data: null, error: null })
          return Promise.resolve({ data: matched[0] ?? null, error: null })
        },
      }
      return api
    },
  }
}

describe('mintActionToken', () => {
  it('mints a 32-byte base64url token and persists the row', async () => {
    const sb = fakeSupabase()
    const token = await mintActionToken(sb as any, { runId: 'r1', action: 'approve' })
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(sb.rows).toHaveLength(1)
    expect(sb.rows[0].run_id).toBe('r1')
    expect(sb.rows[0].action).toBe('approve')
    expect(sb.rows[0].used_at).toBeUndefined()
  })
})

describe('validateAndConsumeActionToken', () => {
  it('returns ok and marks used_at on first call', async () => {
    const sb = fakeSupabase([
      {
        token: 't1', run_id: 'r1', action: 'approve',
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        used_at: null, used_from_ip: null,
      },
    ])
    const out = await validateAndConsumeActionToken(sb as any, { token: 't1', ip: '1.2.3.4' })
    expect(out).toEqual({ ok: true, runId: 'r1', action: 'approve' })
    expect(sb.rows[0].used_at).not.toBeNull()
    expect(sb.rows[0].used_from_ip).toBe('1.2.3.4')
  })

  it('rejects used tokens', async () => {
    const sb = fakeSupabase([
      {
        token: 't1', run_id: 'r1', action: 'approve',
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        used_at: new Date().toISOString(), used_from_ip: null,
      },
    ])
    const out = await validateAndConsumeActionToken(sb as any, { token: 't1' })
    expect(out).toEqual({ ok: false, reason: 'used' })
  })

  it('rejects expired tokens', async () => {
    const sb = fakeSupabase([
      {
        token: 't1', run_id: 'r1', action: 'approve',
        expires_at: new Date(Date.now() - 60_000).toISOString(),
        used_at: null, used_from_ip: null,
      },
    ])
    const out = await validateAndConsumeActionToken(sb as any, { token: 't1' })
    expect(out).toEqual({ ok: false, reason: 'expired' })
  })

  it('rejects unknown tokens', async () => {
    const sb = fakeSupabase()
    const out = await validateAndConsumeActionToken(sb as any, { token: 'nope' })
    expect(out).toEqual({ ok: false, reason: 'missing' })
  })
})
