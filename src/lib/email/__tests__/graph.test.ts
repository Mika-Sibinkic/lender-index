import { describe, it, expect, vi, afterEach } from 'vitest'
import { GraphEmailClient } from '../graph'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('GraphEmailClient.sendOnBehalf', () => {
  it('POSTs to /v1.0/me/sendMail with Bearer auth and the right body shape', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 202,
      headers: { get: (k: string) => (k === 'x-ms-request-id' ? 'msg-123' : null) },
      text: async () => '',
    })
    vi.stubGlobal('fetch', fetchMock)

    const client = new GraphEmailClient(async () => 'token-xyz')
    const out = await client.sendOnBehalf({
      from: 'pat@yourcompany.example',
      to: 'jane@altairbank.example.com',
      subject: 'quick question',
      text: 'hey',
      html: '<p>hey</p>',
    })

    expect(out.messageId).toBe('msg-123')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://graph.microsoft.com/v1.0/me/sendMail')
    expect(init.method).toBe('POST')
    expect(init.headers.Authorization).toBe('Bearer token-xyz')
    expect(init.headers['Content-Type']).toBe('application/json')
    const body = JSON.parse(init.body as string)
    expect(body.saveToSentItems).toBe(true)
    expect(body.message.subject).toBe('quick question')
    expect(body.message.body).toEqual({ contentType: 'HTML', content: '<p>hey</p>' })
    expect(body.message.toRecipients).toEqual([
      { emailAddress: { address: 'jane@altairbank.example.com' } },
    ])
  })

  it('throws on non-OK responses with status code in message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        headers: { get: () => null },
        text: async () => 'Forbidden',
      }),
    )
    const client = new GraphEmailClient(async () => 't')
    await expect(
      client.sendOnBehalf({
        from: 'a@x', to: 'b@y', subject: 's', text: '', html: '',
      }),
    ).rejects.toThrow(/403/)
  })
})
