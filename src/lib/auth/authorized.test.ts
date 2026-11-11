import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { isAuthorizedEmail } from './authorized'

const saved = {
  domains: process.env.AUTH_ALLOWED_EMAIL_DOMAINS,
  emails: process.env.AUTH_ALLOWED_EMAILS,
}

function restore(key: string, v: string | undefined) {
  if (v === undefined) delete process.env[key]
  else process.env[key] = v
}

describe('isAuthorizedEmail', () => {
  beforeEach(() => {
    process.env.AUTH_ALLOWED_EMAIL_DOMAINS = ' YourCompany.example '
    process.env.AUTH_ALLOWED_EMAILS = 'owner@yourcompany.example, Outside.Advisor@partner.example'
  })
  afterEach(() => {
    restore('AUTH_ALLOWED_EMAIL_DOMAINS', saved.domains)
    restore('AUTH_ALLOWED_EMAILS', saved.emails)
  })

  it('allows any address on an allowed domain (case-insensitive)', () => {
    expect(isAuthorizedEmail('pat@yourcompany.example')).toBe(true)
    expect(isAuthorizedEmail('Deals@yourcompany.example')).toBe(true)
    expect(isAuthorizedEmail('  analyst@yourcompany.example  ')).toBe(true)
  })

  it('allows the explicitly listed addresses', () => {
    expect(isAuthorizedEmail('owner@yourcompany.example')).toBe(true)
    expect(isAuthorizedEmail('outside.advisor@partner.example')).toBe(true)
    expect(isAuthorizedEmail('OUTSIDE.ADVISOR@partner.example')).toBe(true)
    expect(isAuthorizedEmail('someone.else@partner.example')).toBe(false)
  })

  it('rejects everything else', () => {
    expect(isAuthorizedEmail('attacker@gmail.com')).toBe(false)
    expect(isAuthorizedEmail('owner@yourcompany.exampl')).toBe(false) // lookalike domain
    expect(isAuthorizedEmail('pat@yourcompany.example.evil.com')).toBe(false)
    expect(isAuthorizedEmail('yourcompany.example')).toBe(false) // no @
    expect(isAuthorizedEmail('')).toBe(false)
    expect(isAuthorizedEmail(null)).toBe(false)
    expect(isAuthorizedEmail(undefined)).toBe(false)
  })

  it('does not allow a subdomain spoof of the domain', () => {
    expect(isAuthorizedEmail('x@evil.yourcompany.example')).toBe(false)
    expect(isAuthorizedEmail('x@yourcompany.example.attacker.io')).toBe(false)
  })

  it('fails closed when both allowlists are empty', () => {
    delete process.env.AUTH_ALLOWED_EMAIL_DOMAINS
    process.env.AUTH_ALLOWED_EMAILS = ''
    expect(isAuthorizedEmail('pat@yourcompany.example')).toBe(false)
    expect(isAuthorizedEmail('owner@yourcompany.example')).toBe(false)
  })
})
