// @vitest-environment node
/**
 * The outreach approval link must not send a lender email on a GET.
 *
 * The link in the operator's approval email goes to a real lender's real
 * address, from the operator's own mailbox. Until this change the GET handler called
 * dispatchRun() directly, so Outlook Safe Links, a corporate mail scanner or
 * browser link prefetch fetching that URL sent the email and burned the token
 * — no human ever clicked. Nobody noticed because OUTREACH_DRY_RUN=true swallows
 * the send today; it stops swallowing it the moment live sending is enabled, which is
 * exactly when nobody will be re-auditing this route.
 *
 * WHAT THESE TESTS PIN, in order of how much they matter:
 *   1. A GET dispatches nothing AND consumes nothing. Consuming would be its own
 *      outage: the scanner burns the single-use token and the human who clicks a
 *      second later gets "already used" on an email that was never sent.
 *   2. A POST — only reachable by submitting the form the GET renders — does
 *      dispatch.
 *   3. Expired, already-consumed and unknown tokens return the same three
 *      terminal pages they returned before the split, on BOTH verbs. The
 *      messages are copied verbatim out of the route: a word changing in either
 *      place should have to be changed in two.
 *
 * The token module is REAL here, not mocked. The single-use consume is the
 * security property under test, so stubbing it out would test the stub. Only
 * two boundaries are mocked: the database, and runs.ts (which is what actually
 * reaches Microsoft Graph).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const RUN_ID = '00000000-0000-4000-8000-000000000001'
const SOURCE_ID = '00000000-0000-4000-8000-0000000000f5'
const LENDER = 'Canopus Equipment Capital'
const LENDER_EMAIL = 'jane.reid@canopuscapital.example'

type Row = Record<string, unknown>

const H = vi.hoisted(() => {
  const db: Record<string, Row[]> = {
    outreach_action_token: [],
    outreach_draft: [],
    outreach_run: [],
    funding_sources: [],
  }
  const dispatchRun = vi.fn()
  const declineRun = vi.fn()

  /**
   * Enough of supabase-js for the four tables this route reads. Resolves with
   * { data, error } rather than throwing, the way the real client does.
   */
  function fakeSupabase() {
    return {
      from(table: string) {
        const rows = db[table] ?? []
        let op: 'select' | 'update' = 'select'
        let payload: Row = {}
        const filters: Array<(r: Row) => boolean> = []
        const api: Record<string, unknown> = {
          select: () => api,
          order: () => api,
          limit: () => api,
          update: (p: Row) => {
            op = 'update'
            payload = p
            return api
          },
          eq: (col: string, val: unknown) => {
            filters.push((r) => r[col] === val)
            return api
          },
          is: (col: string, val: unknown) => {
            filters.push((r) => (r[col] ?? null) === val)
            return api
          },
          maybeSingle: async () => {
            const matched = rows.filter((r) => filters.every((f) => f(r)))
            if (op === 'update') {
              if (matched.length === 0) return { data: null, error: null }
              Object.assign(matched[0], payload)
              return { data: matched[0], error: null }
            }
            return { data: matched[0] ?? null, error: null }
          },
        }
        return api
      },
    }
  }

  return { db, dispatchRun, declineRun, fakeSupabase }
})

vi.mock('@/lib/supabase/admin', () => ({ getSupabaseAdmin: () => H.fakeSupabase() }))
vi.mock('@/lib/outreach/runs', () => ({
  dispatchRun: H.dispatchRun,
  declineRun: H.declineRun,
}))

import { GET, POST } from '../route'

/** Verbatim from the route's messageByStatus. */
const MSG = {
  sent: 'The email is on its way (or recorded in dry-run mode).',
  discarded: 'Draft discarded. No email was sent.',
  used: 'This action link has already been used.',
  expired: 'This action link has expired. Re-queue the lender if needed.',
  missing: 'No such action link.',
} as const

function seedToken(
  token: string,
  opts: { action?: 'approve' | 'decline'; expiresInMs?: number; usedAt?: string | null } = {},
) {
  H.db.outreach_action_token.push({
    token,
    run_id: RUN_ID,
    action: opts.action ?? 'approve',
    expires_at: new Date(Date.now() + (opts.expiresInMs ?? 24 * 60 * 60 * 1000)).toISOString(),
    used_at: opts.usedAt ?? null,
    used_from_ip: null,
  })
}

function tokenRow(token: string) {
  return H.db.outreach_action_token.find((r) => r.token === token)
}

function url(token: string) {
  return `https://your-app.vercel.app/api/outreach/act/${token}`
}

async function get(token: string) {
  const res = await GET(new NextRequest(url(token), { method: 'GET' }), {
    params: Promise.resolve({ token }),
  })
  return { status: res.status, html: await res.text(), headers: res.headers }
}

async function post(token: string, headers: Record<string, string> = {}) {
  const res = await POST(new NextRequest(url(token), { method: 'POST', headers }), {
    params: Promise.resolve({ token }),
  })
  return { status: res.status, html: await res.text(), headers: res.headers }
}

beforeEach(() => {
  for (const key of Object.keys(H.db)) H.db[key].length = 0
  vi.clearAllMocks()
  H.dispatchRun.mockResolvedValue({ dispatched: true })
  H.declineRun.mockResolvedValue({ declined: true })
  H.db.outreach_run.push({ id: RUN_ID, funding_source_id: SOURCE_ID, status: 'awaiting_approval' })
  H.db.funding_sources.push({ id: SOURCE_ID, company_name: LENDER })
  H.db.outreach_draft.push({ run_id: RUN_ID, to_email: LENDER_EMAIL, created_at: '2026-09-14T10:00:00Z' })
})

describe('GET is safe — a mail scanner following the link sends nothing', () => {
  it('renders a confirmation page instead of dispatching', async () => {
    seedToken('approve-tok')
    const { status, html } = await get('approve-tok')

    expect(status).toBe(200)
    // The load-bearing assertions. Everything else on the page is cosmetic.
    expect(H.dispatchRun).not.toHaveBeenCalled()
    expect(H.declineRun).not.toHaveBeenCalled()
    expect(html).not.toContain(MSG.sent)
  })

  it('does not burn the single-use token', async () => {
    // A scanner that CONSUMED the token would be its own outage: the human
    // clicking a second later would get "already used" on an unsent email.
    seedToken('approve-tok')
    await get('approve-tok')
    expect(tokenRow('approve-tok')?.used_at).toBeNull()
  })

  it('is idempotent — fetched three times it is still the same live page', async () => {
    // Safe Links can re-scan; so can a retry, a preview pane and a prefetch.
    seedToken('approve-tok')
    for (let i = 0; i < 3; i++) {
      const { status } = await get('approve-tok')
      expect(status).toBe(200)
    }
    expect(H.dispatchRun).not.toHaveBeenCalled()
    expect(tokenRow('approve-tok')?.used_at).toBeNull()
  })

  it('names the lender and the recipient, and offers a POST form', async () => {
    seedToken('approve-tok')
    const { html } = await get('approve-tok')

    expect(html).toContain(LENDER)
    expect(html).toContain(LENDER_EMAIL)
    expect(html).toContain('method="post"')
    expect(html).toContain('action="/api/outreach/act/approve-tok"')
    expect(html).toContain('>Send email<')
    expect(html).toContain('<button')
  })

  it('offers discard, not send, on a decline token', async () => {
    seedToken('decline-tok', { action: 'decline' })
    const { status, html } = await get('decline-tok')

    expect(status).toBe(200)
    expect(html).toContain('>Discard draft<')
    expect(html).not.toContain('>Send email<')
    expect(H.declineRun).not.toHaveBeenCalled()
  })

  it('sets Cache-Control: no-store', async () => {
    seedToken('approve-tok')
    const { headers } = await get('approve-tok')
    expect(headers.get('cache-control')).toBe('no-store')
  })

  it('omits a field it could not load rather than guessing one', async () => {
    // Accuracy mandate: blank means unknown. A placeholder like "unknown lender"
    // on a page whose whole job is "is this the right recipient?" reads as fact.
    H.db.outreach_draft.length = 0
    seedToken('approve-tok')
    const { status, html } = await get('approve-tok')

    expect(status).toBe(200)
    expect(html).toContain(LENDER)
    expect(html).not.toContain(LENDER_EMAIL)
    expect(html.toLowerCase()).not.toContain('unknown')
  })

  it('escapes a lender name carrying markup', async () => {
    H.db.funding_sources[0].company_name = '<script>alert(1)</script>Ajax Holdings'
    seedToken('approve-tok')
    const { html } = await get('approve-tok')

    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;')
  })
})

describe('POST dispatches — the human click', () => {
  it('sends on an approve token and consumes it', async () => {
    seedToken('approve-tok')
    const { status, html } = await post('approve-tok')

    expect(status).toBe(200)
    expect(H.dispatchRun).toHaveBeenCalledTimes(1)
    expect(H.dispatchRun.mock.calls[0][1]).toBe(RUN_ID)
    expect(html).toContain(MSG.sent)
    expect(tokenRow('approve-tok')?.used_at).not.toBeNull()
  })

  it('discards on a decline token and sends nothing', async () => {
    seedToken('decline-tok', { action: 'decline' })
    const { status, html } = await post('decline-tok')

    expect(status).toBe(200)
    expect(H.declineRun).toHaveBeenCalledTimes(1)
    expect(H.dispatchRun).not.toHaveBeenCalled()
    expect(html).toContain(MSG.discarded)
  })

  it('records the clicking IP on the consumed token', async () => {
    seedToken('approve-tok')
    await post('approve-tok', { 'x-forwarded-for': '203.0.113.7, 70.41.3.18' })
    expect(tokenRow('approve-tok')?.used_from_ip).toBe('203.0.113.7')
  })

  it('still sends exactly once when the form is submitted twice', async () => {
    seedToken('approve-tok')
    const first = await post('approve-tok')
    const second = await post('approve-tok')

    expect(first.status).toBe(200)
    expect(second.status).toBe(410)
    expect(second.html).toContain(MSG.used)
    expect(H.dispatchRun).toHaveBeenCalledTimes(1)
  })

  it('surfaces a dispatch failure as the error page, not a crash', async () => {
    seedToken('approve-tok')
    H.dispatchRun.mockRejectedValue(new Error('Graph 503'))
    const { status, html } = await post('approve-tok')

    expect(status).toBe(500)
    expect(html).toContain('Graph 503')
  })
})

describe('The whole flow a human takes: scan, then click', () => {
  it('survives the scanner and still sends on the click', async () => {
    // Regression for the exact production sequence: Safe Links fetches the URL
    // the instant the mail lands, then the operator opens it and clicks.
    seedToken('approve-tok')

    const scanned = await get('approve-tok')
    expect(scanned.status).toBe(200)
    expect(H.dispatchRun).not.toHaveBeenCalled()

    const clicked = await post('approve-tok')
    expect(clicked.status).toBe(200)
    expect(clicked.html).toContain(MSG.sent)
    expect(H.dispatchRun).toHaveBeenCalledTimes(1)
  })
})

describe('Terminal states are identical on both verbs', () => {
  it('expired token → 410 on GET, and nothing dispatched', async () => {
    seedToken('old-tok', { expiresInMs: -60_000 })
    const { status, html } = await get('old-tok')

    expect(status).toBe(410)
    expect(html).toContain(MSG.expired)
    expect(H.dispatchRun).not.toHaveBeenCalled()
  })

  it('expired token → 410 on POST, and nothing dispatched', async () => {
    seedToken('old-tok', { expiresInMs: -60_000 })
    const { status, html } = await post('old-tok')

    expect(status).toBe(410)
    expect(html).toContain(MSG.expired)
    expect(H.dispatchRun).not.toHaveBeenCalled()
  })

  it('already-consumed token → the same "already used" page it showed before', async () => {
    seedToken('spent-tok', { usedAt: '2026-09-13T09:00:00Z' })

    const onGet = await get('spent-tok')
    expect(onGet.status).toBe(410)
    expect(onGet.html).toContain(MSG.used)

    const onPost = await post('spent-tok')
    expect(onPost.status).toBe(410)
    expect(onPost.html).toContain(MSG.used)

    expect(H.dispatchRun).not.toHaveBeenCalled()
    // Unchanged: a second reader must not re-stamp the consume record.
    expect(tokenRow('spent-tok')?.used_at).toBe('2026-09-13T09:00:00Z')
  })

  it('unknown token → 404 on both verbs', async () => {
    const onGet = await get('never-minted')
    expect(onGet.status).toBe(404)
    expect(onGet.html).toContain(MSG.missing)

    const onPost = await post('never-minted')
    expect(onPost.status).toBe(404)
    expect(onPost.html).toContain(MSG.missing)

    expect(H.dispatchRun).not.toHaveBeenCalled()
  })
})
