import { describe, it, expect } from 'vitest'
import { probeAi, probeEmbed } from '../ai-health'

// Minimal fetch fakes — probeAi only reads res.ok and res.status.
const respond = (status: number): typeof fetch =>
  (async () => ({ ok: status >= 200 && status < 300, status })) as unknown as typeof fetch
const throws = (): typeof fetch =>
  (async () => {
    throw new Error('network')
  }) as unknown as typeof fetch

const BASE = 'http://onprem.local:11435/v1'

describe('probeAi', () => {
  it('reports up on 200 (backend answered)', async () => {
    expect(await probeAi({ base: BASE, fetchImpl: respond(200) })).toBe('up')
  })

  it('reports up on 401/403 (reachable but bearer-gated)', async () => {
    expect(await probeAi({ base: BASE, fetchImpl: respond(401) })).toBe('up')
    expect(await probeAi({ base: BASE, fetchImpl: respond(403) })).toBe('up')
  })

  it('reports DOWN on Cloudflare 530 (tunnel origin unreachable) — the regression', async () => {
    // This is the exact prod condition: on-prem box off → CF edge returns 530 →
    // fetch resolves (does not throw) → old probe wrongly said "up".
    expect(await probeAi({ base: BASE, fetchImpl: respond(530) })).toBe('down')
  })

  it('reports down on gateway 5xx (502/503/504)', async () => {
    for (const s of [500, 502, 503, 504]) {
      expect(await probeAi({ base: BASE, fetchImpl: respond(s) })).toBe('down')
    }
  })

  it('reports down on a network-level throw (DNS/refused/timeout)', async () => {
    expect(await probeAi({ base: BASE, fetchImpl: throws() })).toBe('down')
  })

  it('reports unconfigured when no base URL is set', async () => {
    expect(await probeAi({ base: '' })).toBe('unconfigured')
  })
})

// probeEmbed reads res.ok/status AND the JSON body (embedding vector).
const embed = (status: number, body: unknown): typeof fetch =>
  (async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })) as unknown as typeof fetch

describe('probeEmbed — the status search actually depends on', () => {
  it('valid vector back → up', async () => {
    expect(await probeEmbed({ base: BASE, fetchImpl: embed(200, { data: [{ embedding: [0.1, 0.2, 0.3] }] }) })).toBe('up')
  })
  it('reachable but empty/no vector (model evicted) → degraded — the real outage state', async () => {
    expect(await probeEmbed({ base: BASE, fetchImpl: embed(200, { data: [{ embedding: [] }] }) })).toBe('degraded')
    expect(await probeEmbed({ base: BASE, fetchImpl: embed(200, {}) })).toBe('degraded')
  })
  it('4xx (model not found / bad request) → degraded, not down', async () => {
    expect(await probeEmbed({ base: BASE, fetchImpl: embed(404, {}) })).toBe('degraded')
  })
  it('5xx / Cloudflare 530 → down', async () => {
    for (const s of [500, 502, 530]) {
      expect(await probeEmbed({ base: BASE, fetchImpl: embed(s, {}) })).toBe('down')
    }
  })
  it('network throw → down', async () => {
    expect(await probeEmbed({ base: BASE, fetchImpl: throws() })).toBe('down')
  })
  it('no base → unconfigured', async () => {
    expect(await probeEmbed({ base: '' })).toBe('unconfigured')
  })
})
