import { describe, it, expect } from 'vitest'
import {
  isBackendUnreachable,
  isOriginUnreachableStatus,
  BACKEND_UNREACHABLE_MARKER,
} from './local-extract'

describe('isBackendUnreachable — backend-down signal threading', () => {
  it('flags a rawResponse carrying the unreachable marker', () => {
    const raw = `${BACKEND_UNREACHABLE_MARKER}: local-llm unreachable (fetch failed)`
    expect(isBackendUnreachable(raw)).toBe(true)
  })

  it('flags the timeout-abort variant (also marker-tagged)', () => {
    const raw = `${BACKEND_UNREACHABLE_MARKER}: local-llm unreachable (timed out after 45000ms)`
    expect(isBackendUnreachable(raw)).toBe(true)
  })

  it('does NOT flag a reachable-but-erroring backend (HTTP 500 etc.)', () => {
    // local-llm 5xx/4xx errors are reachable — they must fall through to the
    // existing best-effort path, NOT trigger a 503.
    expect(isBackendUnreachable('local-llm 500: internal error')).toBe(false)
    expect(isBackendUnreachable('local-llm 401: unauthorized')).toBe(false)
  })

  it('does NOT flag a clean / unrelated rawResponse', () => {
    expect(isBackendUnreachable('{"company_name":"Acme"}')).toBe(false)
    expect(isBackendUnreachable('')).toBe(false)
  })

  it('is null/undefined safe', () => {
    expect(isBackendUnreachable(null)).toBe(false)
    expect(isBackendUnreachable(undefined)).toBe(false)
  })

  it('flags a 530-tagged rawResponse (Cloudflare tunnel origin down)', () => {
    // Model host off → tunnel returns 530 → local-extract
    // now tags it so the parse route returns "AI offline" not silent regex.
    const raw = `${BACKEND_UNREACHABLE_MARKER}: local-llm 530: <!doctype html> Cloudflare Tunnel error`
    expect(isBackendUnreachable(raw)).toBe(true)
  })
})

describe('isOriginUnreachableStatus — tunnel-origin vs reachable-erroring', () => {
  it('flags 530 and the Cloudflare 520–527 origin-error family', () => {
    for (const s of [520, 521, 522, 523, 524, 530]) {
      expect(isOriginUnreachableStatus(s)).toBe(true)
    }
  })

  it('flags 502 / 504 gateway errors', () => {
    expect(isOriginUnreachableStatus(502)).toBe(true)
    expect(isOriginUnreachableStatus(504)).toBe(true)
  })

  it('does NOT flag reachable-but-erroring 500 / 503 / 4xx / 2xx', () => {
    for (const s of [200, 400, 401, 403, 404, 429, 500, 503]) {
      expect(isOriginUnreachableStatus(s)).toBe(false)
    }
  })
})
