import { describe, it, expect } from 'vitest'
import {
  classifyAiError,
  aiFailureMessage,
  aiFailureStatus,
  classifyExtractFailure,
} from './failure'

describe('classifyAiError', () => {
  it('names the missing model from a real Ollama 404 body', () => {
    // Verbatim from prod parse_logs, 2026-07-21 — the failure users reported.
    const e = new Error(
      `local-llm 404: {"error":{"message":"model 'qwen2.5:7b-instruct' not found","type":"api_error","param":null,"code":null}}`,
    )
    expect(classifyAiError(e)).toEqual({ kind: 'model_missing', model: 'qwen2.5:7b-instruct' })
  })

  it('handles the AI SDK error shape (statusCode + responseBody)', () => {
    const e = Object.assign(new Error('Not Found'), {
      statusCode: 404,
      responseBody: '{"error":{"message":"model \\"qwen2.5:7b-instruct\\" not found"}}',
    })
    expect(classifyAiError(e).kind).toBe('model_missing')
  })

  it('treats a missing model as model_missing, never as offline', () => {
    // A 404 is a REACHABLE backend answering. Calling it "offline" would send
    // the operator to check the wrong thing.
    const e = new Error('local-llm 404: model "nomic-embed-text" not found')
    expect(classifyAiError(e).kind).not.toBe('offline')
  })

  it('recognises the unreachable marker from local-extract', () => {
    const e = new Error('AI_BACKEND_UNREACHABLE: local-llm unreachable (fetch failed)')
    expect(classifyAiError(e).kind).toBe('offline')
  })

  it('recognises a Cloudflare 530 origin-unreachable page', () => {
    const e = new Error('local-llm 530: <!doctype html><html class="no-js"...')
    expect(classifyAiError(e).kind).toBe('offline')
  })

  it('reads 502 as an unreachable origin and 504 as an overloaded one', () => {
    // Different next actions: 502/530 = the box is not answering at all;
    // 504 = it answered too slowly. Sending the operator to the wrong one
    // wastes the trip to the office.
    expect(classifyAiError(Object.assign(new Error('bad gateway'), { statusCode: 502 })).kind).toBe('offline')
    expect(classifyAiError(Object.assign(new Error('gw timeout'), { status: 504 })).kind).toBe('timeout')
  })

  it('lets a structured status beat prose in the body', () => {
    // Body says "timeout", status says 502 — the status is the reliable signal.
    expect(
      classifyAiError(Object.assign(new Error('upstream timeout'), { statusCode: 502 })).kind,
    ).toBe('offline')
  })

  it('recognises network-level failures', () => {
    expect(classifyAiError(new Error('connect ECONNREFUSED 127.0.0.1:11434')).kind).toBe('offline')
    expect(classifyAiError(new Error('fetch failed')).kind).toBe('offline')
  })

  it('recognises a timeout/abort', () => {
    expect(classifyAiError(new Error('timed out after 45000ms')).kind).toBe('timeout')
    expect(classifyAiError(Object.assign(new Error('aborted'), { name: 'AbortError' })).kind).toBe('timeout')
  })

  it('does NOT misread a reachable 500 as offline', () => {
    // 500 = the backend itself errored; it is up. Only 502/504/520-530 mean the
    // edge could not reach the origin.
    expect(classifyAiError(Object.assign(new Error('local-llm 500: oops'), { statusCode: 500 })).kind).toBe('unknown')
  })

  it('tolerates non-Error throwables', () => {
    expect(classifyAiError('model "gemma3:4b" not found').kind).toBe('model_missing')
    expect(classifyAiError(null).kind).toBe('unknown')
    expect(classifyAiError(undefined).kind).toBe('unknown')
    expect(classifyAiError({}).kind).toBe('unknown')
  })
})

describe('aiFailureMessage', () => {
  it('names the model and the one-line fix', () => {
    const msg = aiFailureMessage({ kind: 'model_missing', model: 'qwen2.5:7b-instruct' })
    expect(msg).toContain('qwen2.5:7b-instruct') // the exact tag to pull
    expect(msg).toMatch(/install/i) // what to do about it
    expect(msg).toContain('not saved') // and that nothing was written
  })

  it('stays inside humanError’s 200-char sentence gate even with a long tag', () => {
    const msg = aiFailureMessage(
      { kind: 'model_missing', model: 'qwen2.5:14b-instruct-q4_K_M' },
      { action: 'The deal was not imported.' },
    )
    expect(msg.length).toBeLessThanOrEqual(200)
  })

  it('never leaks status codes, stack traces or provider jargon', () => {
    for (const kind of ['offline', 'model_missing', 'timeout', 'unknown'] as const) {
      const msg = aiFailureMessage({ kind })
      expect(msg).not.toMatch(/\b\d{3}\b/) // no bare HTTP status
      expect(msg).not.toMatch(/ollama|cloudflare|http|stack|json/i)
    }
  })

  it('accepts a caller-specific action clause', () => {
    const msg = aiFailureMessage({ kind: 'offline' }, { action: 'The deal was not imported.' })
    expect(msg).toContain('The deal was not imported.')
  })

  it('passes the humanError sniff test so it survives to the toast', async () => {
    const { humanError } = await import('@/lib/ui/error-message')
    const msg = aiFailureMessage({ kind: 'model_missing', model: 'qwen2.5:7b-instruct' })
    expect(humanError(503, msg)).toBe(msg)
  })
})

describe('classifyExtractFailure', () => {
  it('flags a missing model so Add mode cannot present regex output as an AI parse', () => {
    // The 2026-07-21 prod state: model absent → aiExtract caught the throw and
    // returned regex fields with fallbackUsed. The route used to hand that back
    // as a normal 200, so the operator could not tell the AI never read the doc.
    const f = classifyExtractFailure({
      provider: 'regex-fallback',
      fallbackUsed: true,
      rawResponse: `local-llm 404: {"error":{"message":"model 'qwen2.5:7b-instruct' not found"}}`,
    })
    expect(f).toEqual({ kind: 'model_missing', model: 'qwen2.5:7b-instruct' })
  })

  it('flags an offline backend', () => {
    expect(
      classifyExtractFailure({
        provider: 'regex-fallback',
        fallbackUsed: true,
        rawResponse: 'AI_BACKEND_UNREACHABLE: local-llm unreachable (fetch failed)',
      })?.kind,
    ).toBe('offline')
  })

  it('does NOT flag a successful parse', () => {
    expect(classifyExtractFailure({ provider: 'local-openai-compat', fallbackUsed: false })).toBeNull()
  })

  it('does NOT flag unparseable model output — the document WAS read', () => {
    expect(
      classifyExtractFailure({
        provider: 'local-openai-compat',
        fallbackUsed: true,
        rawResponse: 'Sure! Here is the JSON you asked for: ```{ oops',
      }),
    ).toBeNull()
  })

  it('does NOT misread model prose that happens to say "model not found"', () => {
    // Same words, but the provider says the model answered — so it is content,
    // not an ops failure. Guards against a false "install a model" instruction.
    expect(
      classifyExtractFailure({
        provider: 'local-openai-compat',
        fallbackUsed: true,
        rawResponse: `the model "gemma3:4b" not found in the document text`,
      }),
    ).toBeNull()
  })
})

describe('aiFailureStatus', () => {
  it('maps timeout to 504 and everything else to 503', () => {
    expect(aiFailureStatus({ kind: 'timeout' })).toBe(504)
    expect(aiFailureStatus({ kind: 'offline' })).toBe(503)
    expect(aiFailureStatus({ kind: 'model_missing' })).toBe(503)
    expect(aiFailureStatus({ kind: 'unknown' })).toBe(503)
  })
})

// Cloudflare 524 = "a timeout occurred": the tunnel reached the host and the
// host did not answer within the edge's ~100s ceiling. A long extraction can
// return `error code: 524` while the host is up. Reporting that as "offline"
// sends someone to switch on a machine that is already running.
describe('Cloudflare 524 is slow, not down', () => {
  it('classifies a 524 status as a timeout', () => {
    expect(classifyAiError({ status: 524, message: 'error code: 524' }).kind).toBe('timeout')
  })

  it('classifies a 524 embedded in a message as a timeout', () => {
    expect(classifyAiError(new Error('local-llm 524: error code: 524')).kind).toBe('timeout')
  })

  it('still treats the genuinely-unreachable codes as offline', () => {
    for (const status of [502, 521, 523, 530]) {
      expect(classifyAiError({ status }).kind).toBe('offline')
    }
  })

  it('tells the operator the box is overloaded, not off', () => {
    const msg = aiFailureMessage(classifyAiError({ status: 524 }), { action: 'The deal was not imported.' })
    expect(msg).toContain('took too long')
    expect(msg).not.toContain('offline')
  })
})
