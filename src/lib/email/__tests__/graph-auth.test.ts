import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/admin', () => {
  const update = vi.fn(() => ({
    eq: vi.fn().mockResolvedValue({ data: null, error: null }),
  }))
  const single = vi
    .fn()
    .mockResolvedValue({ data: { refresh_token: 'r-stored' }, error: null })
  const eq = vi.fn(() => ({ single }))
  const select = vi.fn(() => ({ eq }))
  const upsert = vi.fn().mockResolvedValue({ data: null, error: null })
  const from = vi.fn(() => ({ select, update, upsert }))
  return {
    getSupabaseAdmin: () => ({ from }),
  }
})

import {
  buildConsentUrl,
  exchangeAuthCodeForToken,
  getDelegatedToken,
  _resetTokenCache,
} from '../graph-auth'

beforeEach(() => {
  _resetTokenCache()
  process.env.AZURE_TENANT_ID = 'tenant-1'
  process.env.AZURE_CLIENT_ID = 'client-1'
  process.env.AZURE_CLIENT_SECRET = 'secret-1'
  process.env.GRAPH_SCOPES = 'offline_access Mail.Send'
})

describe('buildConsentUrl', () => {
  it('builds the authorize url with required params', () => {
    const url = buildConsentUrl('https://app.example/cb', 'nonce-xyz')
    expect(url).toContain('login.microsoftonline.com/tenant-1/oauth2/v2.0/authorize')
    expect(url).toContain('client_id=client-1')
    expect(url).toContain('response_type=code')
    expect(url).toContain('redirect_uri=https%3A%2F%2Fapp.example%2Fcb')
    expect(url).toContain('state=nonce-xyz')
    expect(url).toContain('scope=offline_access+Mail.Send')
  })
})

describe('getDelegatedToken', () => {
  it('refreshes when no cache exists and returns the access token', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: 'a-new',
        refresh_token: 'r-new',
        expires_in: 3600,
        token_type: 'Bearer',
      }),
    })
    vi.stubGlobal('fetch', fetchMock)
    const t = await getDelegatedToken()
    expect(t).toBe('a-new')
    expect(fetchMock).toHaveBeenCalledWith(
      'https://login.microsoftonline.com/tenant-1/oauth2/v2.0/token',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('throws clearly when Microsoft returns an error', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve({
        ok: false,
        status: 400,
        json: async () => ({
          error: 'invalid_grant',
          error_description: 'AADSTS70008: expired',
        }),
      } as never),
    )
    _resetTokenCache()
    await expect(getDelegatedToken()).rejects.toThrow(/invalid_grant/)
  })
})

describe('exchangeAuthCodeForToken', () => {
  it('POSTs grant_type=authorization_code with code+redirect_uri', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: 'a',
        refresh_token: 'r-initial',
        expires_in: 3600,
      }),
    })
    vi.stubGlobal('fetch', fetchMock)
    await exchangeAuthCodeForToken('the-code', 'https://app.example/cb')
    const body = fetchMock.mock.calls[0][1].body as URLSearchParams
    expect(body.get('grant_type')).toBe('authorization_code')
    expect(body.get('code')).toBe('the-code')
    expect(body.get('redirect_uri')).toBe('https://app.example/cb')
  })
})
