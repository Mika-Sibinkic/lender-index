import { describe, it, expect, vi, beforeEach } from 'vitest'
import { z } from 'zod'

const generateText = vi.fn()
const generateObject = vi.fn()
const embed = vi.fn()
const embedMany = vi.fn()

vi.mock('ai', () => ({ generateText, generateObject, embed, embedMany }))

function mockSupabase() {
  const insert = vi.fn().mockResolvedValue({ error: null })
  const from = vi.fn(() => ({ insert }))
  return { client: { from } as never, insert, from }
}

beforeEach(() => {
  generateText.mockReset()
  generateObject.mockReset()
  embed.mockReset()
  embedMany.mockReset()
})

describe('llm.text', () => {
  it('returns text, model, latencyMs and writes cost_log', async () => {
    generateText.mockResolvedValue({ text: 'hello world', usage: { inputTokens: 12, outputTokens: 3 } })
    const { llm } = await import('./client')
    const { client, from } = mockSupabase()
    const res = await llm.text({ supabase: client, module: 'parse', prompt: 'hi' })
    expect(res.text).toBe('hello world')
    expect(res.model).toMatch(/\//)
    expect(res.latencyMs).toBeGreaterThanOrEqual(0)
    expect(from).toHaveBeenCalledWith('cost_log')
  })
})

describe('llm.object', () => {
  it('passes the schema through and returns the parsed object', async () => {
    generateObject.mockResolvedValue({
      object: { ok: true, n: 3 },
      usage: { inputTokens: 5, outputTokens: 5 },
    })
    const { llm } = await import('./client')
    const { client } = mockSupabase()
    const schema = z.object({ ok: z.boolean(), n: z.number() })
    const res = await llm.object({ supabase: client, module: 'parse', schema, prompt: 'x' })
    expect(res.object).toEqual({ ok: true, n: 3 })
    expect(generateObject).toHaveBeenCalledWith(expect.objectContaining({ schema }))
  })
})

describe('llm.vision', () => {
  it('builds a messages payload with a text + image part for a base64 image', async () => {
    generateObject.mockResolvedValue({
      object: { caption: 'a card' },
      usage: { inputTokens: 100, outputTokens: 10 },
    })
    const { llm } = await import('./client')
    const { client } = mockSupabase()
    const schema = z.object({ caption: z.string() })
    await llm.vision({
      supabase: client,
      module: 'parse_file',
      schema,
      prompt: 'describe',
      image: { base64: 'AAAA', mediaType: 'image/png' },
    })
    expect(generateObject).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          expect.objectContaining({
            role: 'user',
            content: expect.arrayContaining([
              { type: 'text', text: 'describe' },
              expect.objectContaining({ type: 'image', mediaType: 'image/png' }),
            ]),
          }),
        ],
      }),
    )
  })
})

describe('llm.embed', () => {
  it('uses embed() for single value', async () => {
    embed.mockResolvedValue({ embedding: [0.1, 0.2], usage: { tokens: 4 } })
    const { llm } = await import('./client')
    const { client } = mockSupabase()
    const res = await llm.embed({ supabase: client, module: 'search', values: ['hi'] })
    expect(embed).toHaveBeenCalled()
    expect(embedMany).not.toHaveBeenCalled()
    expect(res.embeddings).toEqual([[0.1, 0.2]])
  })

  it('uses embedMany() for batch', async () => {
    embedMany.mockResolvedValue({
      embeddings: [[1, 2], [3, 4]],
      usage: { tokens: 8 },
    })
    const { llm } = await import('./client')
    const { client } = mockSupabase()
    const res = await llm.embed({ supabase: client, module: 'search', values: ['a', 'b'] })
    expect(embedMany).toHaveBeenCalled()
    expect(res.embeddings).toEqual([[1, 2], [3, 4]])
  })
})

// Regression: the on-prem provider must declare structured-output support.
// With it off, generateObject stops constraining decoding to the schema and
// merely asks a 3B model for JSON — which failed every time, so Past Deals
// import silently never worked while /api/health still read "up" (health only
// exercises the embed hop). Invisible in code review; pinned here instead.
describe('on-prem provider capabilities', () => {
  async function buildProvider(env: Record<string, string | undefined>) {
    vi.resetModules()
    const createOpenAICompatible = vi.fn((_cfg: { supportsStructuredOutputs?: boolean }) => ({
      chatModel: vi.fn(() => 'model'),
      textEmbeddingModel: vi.fn(() => 'embed-model'),
    }))
    vi.doMock('@ai-sdk/openai-compatible', () => ({ createOpenAICompatible }))
    vi.doMock('ai', () => ({ generateText, generateObject, embed, embedMany }))
    const prev = { ...process.env }
    Object.assign(process.env, {
      LLM_BACKEND: 'openai-compat',
      OPENAI_COMPAT_BASE_URL: 'http://localhost:11434/v1',
      ...env,
    })
    try {
      generateObject.mockResolvedValue({ object: { ok: true }, usage: {} })
      const { llm } = await import('./client')
      await llm.object({
        supabase: mockSupabase().client,
        module: 'closed_deal_extract',
        schema: z.object({ ok: z.boolean() }),
        prompt: 'x',
      })
      return createOpenAICompatible.mock.calls[0]?.[0] ?? {}
    } finally {
      process.env = prev
      vi.doUnmock('@ai-sdk/openai-compatible')
    }
  }

  it('enables structured outputs by default', async () => {
    expect((await buildProvider({})).supportsStructuredOutputs).toBe(true)
  })

  it('can be turned off for a backend that cannot do it', async () => {
    const cfg = await buildProvider({ LLM_STRUCTURED_OUTPUTS: 'false' })
    expect(cfg.supportsStructuredOutputs).toBe(false)
  })
})
