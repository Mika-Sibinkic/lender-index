import { describe, it, expect, afterEach } from 'vitest'
import { probeEmbedDetailed, probeModels } from './ai-health'

const BASE = 'https://ai.example.test/v1'

function fetchReturning(res: Partial<Response> & { json?: () => Promise<unknown> }) {
  return (async () => res) as unknown as typeof fetch
}

const okJson = (body: unknown, status = 200) =>
  fetchReturning({ ok: status < 400, status, json: async () => body })

describe('probeEmbedDetailed', () => {
  it('reports up with the vector width on success', async () => {
    const r = await probeEmbedDetailed({
      base: BASE,
      fetchImpl: okJson({ data: [{ embedding: new Array(768).fill(0) }] }),
    })
    expect(r).toMatchObject({ status: 'up', reason: null, dims: 768 })
  })

  it('distinguishes a 5xx from a timeout from an unreachable host', async () => {
    // A host can be back, the proxy answering, the model list reading fine,
    // and the embed still failing fast. "down" alone could not tell us
    // whether that was a 500, a refused socket, or a slow cold load — three
    // completely different fixes.
    const five = await probeEmbedDetailed({ base: BASE, fetchImpl: okJson({}, 500) })
    expect(five).toMatchObject({ status: 'down', reason: 'http_5xx', httpStatus: 500 })

    const dead = await probeEmbedDetailed({
      base: BASE,
      fetchImpl: (async () => {
        throw new TypeError('fetch failed')
      }) as unknown as typeof fetch,
    })
    expect(dead).toMatchObject({ status: 'down', reason: 'unreachable' })
  })

  it('calls a 4xx degraded, not down — the backend is answering', async () => {
    const r = await probeEmbedDetailed({ base: BASE, fetchImpl: okJson({}, 404) })
    expect(r).toMatchObject({ status: 'degraded', reason: 'http_4xx', httpStatus: 404 })
  })

  it('flags a 200 that carries no vector', async () => {
    const r = await probeEmbedDetailed({ base: BASE, fetchImpl: okJson({ data: [] }) })
    expect(r).toMatchObject({ status: 'degraded', reason: 'empty_vector' })
  })

  it('reports unconfigured rather than down when no backend is set', async () => {
    const r = await probeEmbedDetailed({ base: '' })
    expect(r).toMatchObject({ status: 'unconfigured', reason: null })
  })
})

describe('probeModels', () => {
  const saved = { ...process.env }
  afterEach(() => {
    process.env.LLM_MODEL = saved.LLM_MODEL
    process.env.LLM_VISION_MODEL = saved.LLM_VISION_MODEL
    process.env.EMBED_MODEL = saved.EMBED_MODEL
    process.env.PARSE_OCR_FIRST = saved.PARSE_OCR_FIRST
  })

  const installed = (...ids: string[]) => okJson({ data: ids.map((id) => ({ id })) })

  it('does not cry wolf about a vision model the image path never calls', async () => {
    // A small host may deliberately have no vision model, with image parse
    // going through OCR. Reporting it missing would be a permanent false alarm.
    process.env.LLM_VISION_MODEL = 'llama3.2-vision:11b'
    process.env.PARSE_OCR_FIRST = 'true'
    process.env.LLM_MODEL = 'qwen2.5:3b'
    process.env.EMBED_MODEL = 'nomic-embed-text'

    const r = await probeModels({ base: BASE, fetchImpl: installed('qwen2.5:3b', 'nomic-embed-text') })
    expect(r.missing).toEqual([])
  })

  it('does report a missing vision model when the vision path IS in use', async () => {
    process.env.LLM_VISION_MODEL = 'llama3.2-vision:11b'
    process.env.PARSE_OCR_FIRST = 'false'
    process.env.LLM_MODEL = 'qwen2.5:3b'
    process.env.EMBED_MODEL = 'nomic-embed-text'

    const r = await probeModels({ base: BASE, fetchImpl: installed('qwen2.5:3b', 'nomic-embed-text') })
    expect(r.missing).toEqual(['vision'])
  })

  it('catches the text model that broke document import for weeks', async () => {
    process.env.LLM_MODEL = 'qwen2.5:7b-instruct'
    process.env.EMBED_MODEL = 'nomic-embed-text'
    process.env.PARSE_OCR_FIRST = 'true'

    const r = await probeModels({ base: BASE, fetchImpl: installed('qwen2.5:3b', 'nomic-embed-text') })
    expect(r.missing).toContain('text')
  })

  it('matches an untagged config against the :latest entry', async () => {
    process.env.LLM_MODEL = ''
    process.env.PARSE_OCR_FIRST = 'true'
    process.env.EMBED_MODEL = 'nomic-embed-text'

    const r = await probeModels({ base: BASE, fetchImpl: installed('nomic-embed-text:latest') })
    expect(r.missing).toEqual([])
  })

  it('stays silent when it cannot read the list, rather than guessing', async () => {
    expect(await probeModels({ base: BASE, fetchImpl: okJson({}, 500) })).toEqual({
      reachable: false,
      missing: [],
    })
    expect(await probeModels({ base: BASE, fetchImpl: okJson({ data: [] }) })).toEqual({
      reachable: true,
      missing: [],
    })
  })
})
