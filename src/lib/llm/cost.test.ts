import { describe, it, expect, vi } from 'vitest'
import { logCost, estimateCostUsd } from './cost'

function mockSupabase() {
  const insert = vi.fn().mockResolvedValue({ error: null })
  const from = vi.fn(() => ({ insert }))
  return { client: { from } as never, insert, from }
}

describe('logCost', () => {
  it('inserts into cost_log with both legacy and v2 columns', async () => {
    const { client, insert, from } = mockSupabase()
    await logCost(client, {
      module: 'parse',
      model: 'anthropic/claude-sonnet-4-6',
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 0.0012,
      latencyMs: 320,
    })
    expect(from).toHaveBeenCalledWith('cost_log')
    expect(insert).toHaveBeenCalledWith({
      operation_type: 'parse',
      module: 'parse',
      model: 'anthropic/claude-sonnet-4-6',
      input_tokens: 100,
      output_tokens: 50,
      cost_usd_equivalent: 0.0012,
      latency_ms: 320,
    })
  })

  it('does not throw when supabase returns an error', async () => {
    const insert = vi.fn().mockResolvedValue({ error: { message: 'oops' } })
    const client = { from: vi.fn(() => ({ insert })) } as never
    await expect(
      logCost(client, {
        module: 'parse',
        model: 'm',
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        latencyMs: 0,
      }),
    ).resolves.toBeUndefined()
  })
})

describe('estimateCostUsd', () => {
  it('multiplies token counts by per-1k rates', () => {
    const c = estimateCostUsd('anthropic/claude-sonnet-4-6', 1000, 1000)
    expect(c).toBeCloseTo(0.003 + 0.015, 6)
  })

  it('returns 0 for unknown models', () => {
    expect(estimateCostUsd('unknown/model', 1000, 1000)).toBe(0)
  })

  it('treats embed models as input-only', () => {
    const c = estimateCostUsd('openai/text-embedding-3-small', 1000, 1000)
    expect(c).toBeCloseTo(0.00002, 6)
  })
})
