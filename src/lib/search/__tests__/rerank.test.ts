import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/llm/client', () => ({
  llm: { object: vi.fn() },
}))
import { llm } from '@/lib/llm/client'
import { rerankCandidates, reconcileIds } from '../rerank'

describe('reconcileIds', () => {
  it('keeps model order for ids present in input', () => {
    expect(reconcileIds(['c', 'a'], ['a', 'b', 'c'], 5)).toEqual(['c', 'a', 'b'])
  })
  it('drops hallucinated ids', () => {
    expect(reconcileIds(['x', 'a'], ['a', 'b'], 5)).toEqual(['a', 'b'])
  })
  it('respects limit', () => {
    expect(reconcileIds(['c', 'b', 'a'], ['a', 'b', 'c'], 2)).toEqual(['c', 'b'])
  })
  it('appends missing-from-model ids in input order', () => {
    expect(reconcileIds([], ['a', 'b'], 5)).toEqual(['a', 'b'])
  })
})

describe('rerankCandidates', () => {
  it('short-circuits for <=1 candidate', async () => {
    const out = await rerankCandidates({} as never, 'q', [
      { id: 'only', label: 'X', summary: 'y' },
    ])
    expect(out).toEqual(['only'])
    expect(llm.object).not.toHaveBeenCalled()
  })

  it('calls LLM and reconciles', async () => {
    vi.mocked(llm.object).mockResolvedValue({
      object: { ranked_ids: ['b', 'a', 'c'] },
      model: 'q',
      latencyMs: 100,
    })
    const out = await rerankCandidates({} as never, 'q', [
      { id: 'a', label: 'A', summary: 's' },
      { id: 'b', label: 'B', summary: 's' },
      { id: 'c', label: 'C', summary: 's' },
    ])
    expect(out).toEqual(['b', 'a', 'c'])
  })

  it('falls back to input order on LLM failure', async () => {
    vi.mocked(llm.object).mockRejectedValue(new Error('boom'))
    const out = await rerankCandidates({} as never, 'q', [
      { id: 'a', label: 'A', summary: 's' },
      { id: 'b', label: 'B', summary: 's' },
    ])
    expect(out).toEqual(['a', 'b'])
  })
})
