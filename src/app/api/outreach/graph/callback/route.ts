/**
 * GET /api/outreach/graph/callback?code=...&state=...
 *
 * Step 2 of the OAuth flow. Microsoft redirects here after the admin grants
 * consent. Verify state cookie, exchange code → refresh token, store
 * in public.graph_token (singleton row, id=1).
 *
 * After this lands once, the outreach dispatch path uses
 * graph-auth.getDelegatedToken() — no further user interaction needed
 * until the refresh token is revoked.
 */
import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@clerk/nextjs/server'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { exchangeAuthCodeForToken } from '@/lib/email/graph-auth'

export async function GET(req: NextRequest) {
  const { userId } = await auth()
  if (!userId) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const admin = getSupabaseAdmin()
  const { data: user } = await admin
    .from('users')
    .select('role')
    .eq('clerk_user_id', userId)
    .single()
  if (user?.role !== 'admin') {
    return NextResponse.json({ error: 'admin required' }, { status: 403 })
  }

  const url = req.nextUrl
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  const cookieState = req.cookies.get('graph_oauth_state')?.value

  if (!code || !state) {
    return NextResponse.json({ error: 'missing code or state' }, { status: 400 })
  }
  if (!cookieState || cookieState !== state) {
    return NextResponse.json({ error: 'state mismatch' }, { status: 400 })
  }

  const base = process.env.PUBLIC_BASE_URL ?? req.nextUrl.origin
  const redirectUri = `${base}/api/outreach/graph/callback`

  try {
    await exchangeAuthCodeForToken(code, redirectUri)
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'exchange failed' },
      { status: 500 },
    )
  }

  // Clear the state cookie
  const res = NextResponse.redirect(new URL('/?graph_install=ok', req.url))
  res.cookies.set('graph_oauth_state', '', { maxAge: 0, path: '/' })
  return res
}
