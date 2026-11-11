/**
 * The `samplefleet` incident, locked into the suite.
 *
 * A sibling product runs this app's exact image-extraction design — tesseract
 * OCR, then an LLM that structures whatever the OCR produced. On a tilted
 * business-card photo it read `examplefleet` as `samplefleet`, the model
 * structured the garble without hesitation, and eleven differently-misspelled
 * copies of one person landed in a CRM. Cleanup deleted 24 junk
 * records. Their own post-mortem: a deterministic MX/DNS check on the extracted
 * domain "would have blocked 15 of the 22+ garbage records alone."
 *
 * Every case below is one of the two ways that check can fail us: missing the
 * garble, or — far worse — flagging a real lender because DNS was having a bad
 * minute on OUR side. The second one inverts the accuracy mandate, so most of
 * this file is about it.
 *
 * No test here touches the network. dns/promises is mocked throughout.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// vi.hoisted, because vi.mock is lifted above the imports and the factory would
// otherwise reference these before they exist.
const { resolveMx, resolve4 } = vi.hoisted(() => ({ resolveMx: vi.fn(), resolve4: vi.fn() }))

// `default` as well as the named exports: node builtins are interop-wrapped, so
// a factory without it fails to load the module under test at all.
vi.mock('node:dns/promises', () => ({ resolveMx, resolve4, default: { resolveMx, resolve4 } }))

import { verifyContactDomain, DEFAULT_DNS_TIMEOUT_MS } from './verify-contact'

/** Build the error shape node's resolver actually rejects with. */
function dnsError(code: string): NodeJS.ErrnoException {
  const e = new Error(`query failed: ${code}`) as NodeJS.ErrnoException
  e.code = code
  return e
}

beforeEach(() => {
  resolveMx.mockReset()
  resolve4.mockReset()
})

describe('a domain that exists', () => {
  it('confirms the real spelling — the one the OCR should have produced', async () => {
    // A domain with MX records. The check has to come back clean on it, or the
    // flag is noise and users learn to ignore it.
    resolveMx.mockResolvedValue([{ exchange: 'mx.examplefleet.example', priority: 10 }])
    const r = await verifyContactDomain('pat@examplefleet.example')
    expect(r.status).toBe('resolved')
    expect(r.domain).toBe('examplefleet.example')
    expect(r.source).toBe('email')
    expect(r).toMatchObject({ via: 'mx' })
    expect(resolve4).not.toHaveBeenCalled()
  })

  it('accepts a domain with a website but no mail exchanger', async () => {
    // Small brokers routinely run a web host with mail outsourced somewhere the
    // MX query does not see. MX-only would have called this lender fake.
    resolveMx.mockRejectedValue(dnsError('ENODATA'))
    resolve4.mockResolvedValue(['203.0.113.7'])
    const r = await verifyContactDomain('pat@examplefleet.example')
    expect(r.status).toBe('resolved')
    expect(r).toMatchObject({ via: 'address' })
  })

  it('falls back to the website only when no email was extracted', async () => {
    // A card whose email the OCR dropped entirely still has a domain worth
    // checking, and the reviewer needs to know WHICH field was checked.
    resolveMx.mockResolvedValue([{ exchange: 'mx.examplefleet.example', priority: 10 }])
    const r = await verifyContactDomain(null, 'https://www.examplefleet.example/fleet')
    expect(r.status).toBe('resolved')
    expect(r.source).toBe('website')
    expect(r.domain).toBe('www.examplefleet.example')
    expect(resolveMx).toHaveBeenCalledWith('www.examplefleet.example')
  })

  it('prefers the email domain and ignores the website when both are present', async () => {
    resolveMx.mockResolvedValue([{ exchange: 'mx1', priority: 5 }])
    const r = await verifyContactDomain('pat@examplefleet.example', 'https://example.org')
    expect(r.domain).toBe('examplefleet.example')
    expect(resolveMx).toHaveBeenCalledTimes(1)
  })
})

describe('a domain that does not exist — the samplefleet case', () => {
  it('says not-found when the resolver answers NXDOMAIN for mail and address', async () => {
    // This is the record that reached their CRM eleven times. A human reviewer
    // cannot see the difference between this and examplefleet.example; DNS can.
    resolveMx.mockRejectedValue(dnsError('ENOTFOUND'))
    resolve4.mockRejectedValue(dnsError('ENOTFOUND'))
    const r = await verifyContactDomain('pat@samplefleet.example')
    expect(r.status).toBe('not-found')
    expect(r).toMatchObject({ reason: 'nxdomain' })
    expect(r.domain).toBe('samplefleet.example')
  })

  it('never suggests a correction or rewrites the value it was given', async () => {
    // "Did you mean examplefleet.example?" is a guess, and a confident guess is the
    // entire failure mode being defended against. Flag only.
    resolveMx.mockRejectedValue(dnsError('ENOTFOUND'))
    resolve4.mockRejectedValue(dnsError('ENOTFOUND'))
    const r = await verifyContactDomain('pat@samplefleet.example')
    expect(r.domain).toBe('samplefleet.example')
    expect(Object.keys(r).sort()).toEqual(['domain', 'reason', 'source', 'status'])
  })

  it('requires BOTH lookups to deny the name before it says not-found', async () => {
    // MX said the name does not exist, A said it exists with no address record.
    // Contradictory answers are not proof of anything, so no verdict.
    resolveMx.mockRejectedValue(dnsError('ENOTFOUND'))
    resolve4.mockRejectedValue(dnsError('ENODATA'))
    const r = await verifyContactDomain('pat@parked-holding.example')
    expect(r.status).toBe('unchecked')
    expect(r).toMatchObject({ reason: 'no-records' })
  })
})

describe('fail open — a DNS problem on our side must never accuse a lender', () => {
  it('reports unchecked when the resolver throws something unexpected', async () => {
    // SERVFAIL from an upstream resolver is OUR outage. Calling it "not-found"
    // would tell users a live lender's contact is fake — which is the
    // accuracy rule inverted, and worse than not checking at all.
    resolveMx.mockRejectedValue(dnsError('ESERVFAIL'))
    const r = await verifyContactDomain('pat@examplefleet.example')
    expect(r.status).toBe('unchecked')
    expect(r).toMatchObject({ reason: 'dns-error' })
    // It also stops rather than burning the rest of the budget on a second hop.
    expect(resolve4).not.toHaveBeenCalled()
  })

  it('reports unchecked on an error with no code at all', async () => {
    // A thrown plain Error (a mocked module, a patched resolver, anything odd)
    // must land in the same safe bucket, not fall through to a verdict.
    resolveMx.mockRejectedValue(new Error('resolver exploded'))
    const r = await verifyContactDomain('pat@examplefleet.example')
    expect(r.status).toBe('unchecked')
    expect(r).toMatchObject({ reason: 'dns-error' })
  })

  it('reports unchecked when the lookup outruns its timeout', async () => {
    // A stalled resolver used to be the way a "safety" check turns into an
    // outage: the parse response is held open until the function times out and
    // the user loses the upload. Hard ceiling, then no signal.
    resolveMx.mockImplementation(() => new Promise(() => {}))
    const r = await verifyContactDomain('pat@examplefleet.example', null, { timeoutMs: 10 })
    expect(r.status).toBe('unchecked')
    expect(r).toMatchObject({ reason: 'timeout' })
    expect(r.domain).toBe('examplefleet.example')
  })

  it('shares one timeout budget across both lookups instead of one each', async () => {
    // Two hops at the full budget would double the worst case the route was
    // promised. The A lookup gets what is left, not a fresh clock.
    resolveMx.mockRejectedValue(dnsError('ENODATA'))
    resolve4.mockImplementation(() => new Promise(() => {}))
    const t0 = Date.now()
    const r = await verifyContactDomain('pat@examplefleet.example', null, { timeoutMs: 40 })
    expect(r.status).toBe('unchecked')
    expect(r).toMatchObject({ reason: 'timeout' })
    expect(Date.now() - t0).toBeLessThan(200)
  })

  it('treats a name with no mail and no address as no signal, not as fake', async () => {
    // A parked or web-only domain is undeliverable but real. Reporting it as
    // not-found would flag a lender whose card is perfectly correct.
    resolveMx.mockRejectedValue(dnsError('ENODATA'))
    resolve4.mockRejectedValue(dnsError('ENODATA'))
    const r = await verifyContactDomain('pat@holdco.example')
    expect(r.status).toBe('unchecked')
    expect(r).toMatchObject({ reason: 'no-records' })
  })

  it('declines to judge an internationalised domain rather than flagging it', async () => {
    // Cross-border deal flow is genuinely multilingual — French and Brazilian
    // documents are routine. Node's resolver wants punycode, and
    // converting here would be rewriting an extracted value.
    const r = await verifyContactDomain('contact@crédit-rapide.fr')
    expect(r.status).toBe('unchecked')
    expect(r).toMatchObject({ reason: 'non-ascii-domain' })
    expect(resolveMx).not.toHaveBeenCalled()
  })

  it('never throws, whatever the resolver does', async () => {
    // The route awaits this inline. A throw here would 500 the parse and lose
    // the user's upload — a far worse bug than the one being prevented.
    resolveMx.mockImplementation(() => {
      throw dnsError('EAI_AGAIN')
    })
    await expect(verifyContactDomain('pat@examplefleet.example')).resolves.toMatchObject({
      status: 'unchecked',
    })
  })
})

describe('syntax is checked before the network is', () => {
  it('calls an address the OCR broke not-found without any lookup', async () => {
    // Tesseract on an angled card emits exactly these: a space swallowed into
    // the domain, a comma where the dot was. No resolver can help, and asking
    // one wastes the budget.
    for (const bad of [
      'pat@ examplefleet .example',
      'pat@examplefleet,example',
      'pat@@examplefleet.example',
      'pat examplefleet.example',
      'pat@examplefleet',
      '@examplefleet.example',
      'pat@.example',
      'pat@examplefleet..example',
      'pat@-examplefleet.example',
    ]) {
      const r = await verifyContactDomain(bad)
      expect(r.status, bad).toBe('not-found')
      expect(r, bad).toMatchObject({ reason: 'malformed' })
    }
    expect(resolveMx).not.toHaveBeenCalled()
    expect(resolve4).not.toHaveBeenCalled()
  })

  it('accepts the shapes real lender addresses take', async () => {
    // A false "malformed" is the same accusation as a false NXDOMAIN. These all
    // have to reach the resolver: a co.uk, a com.br, a hyphen, a plus tag, a
    // trailing FQDN dot.
    resolveMx.mockResolvedValue([{ exchange: 'mx', priority: 1 }])
    for (const good of [
      'pat.doe@example-fleet.co.uk',
      'pat+deals@examplefleet.com.br',
      'P.Doe@ExampleFleet.EXAMPLE',
      'pat@examplefleet.example.',
    ]) {
      expect((await verifyContactDomain(good)).status, good).toBe('resolved')
    }
    // Case is normalised for the lookup only; the caller's value is untouched.
    expect(resolveMx).toHaveBeenCalledWith('examplefleet.example')
  })

  it('flags a website that is not a domain, and says so about the website', async () => {
    const r = await verifyContactDomain(null, 'see card')
    expect(r.status).toBe('not-found')
    expect(r).toMatchObject({ reason: 'malformed', source: 'website' })
    expect(resolveMx).not.toHaveBeenCalled()
  })
})

describe('nothing to check', () => {
  it('returns unchecked, not a verdict, when there is no contact at all', async () => {
    // Blank means unknown, never guessed — and a blank field must not read as a
    // failed check in the UI. This is the most common case: most term sheets
    // and most cards yield no email at all.
    for (const empty of [null, undefined, '', '   ']) {
      const r = await verifyContactDomain(empty)
      expect(r.status).toBe('unchecked')
      expect(r).toMatchObject({ reason: 'no-input', domain: null, source: null })
    }
    expect(resolveMx).not.toHaveBeenCalled()
    expect(resolve4).not.toHaveBeenCalled()
  })

  it('ignores a blank website the same way', async () => {
    const r = await verifyContactDomain('', '   ')
    expect(r).toMatchObject({ status: 'unchecked', reason: 'no-input' })
  })
})

describe('the default budget', () => {
  it('stays inside a few seconds so the parse response is not held open', async () => {
    expect(DEFAULT_DNS_TIMEOUT_MS).toBeGreaterThan(0)
    expect(DEFAULT_DNS_TIMEOUT_MS).toBeLessThanOrEqual(3000)
  })
})
