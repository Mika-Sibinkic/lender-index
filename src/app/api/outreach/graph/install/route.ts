/**
 * GET /api/outreach/graph/install
 *
 * Step 1 of the Graph OAuth setup. Admin signs in to the app, hits
 * this URL, gets redirected to Microsoft's consent screen with the
 * configured scopes (offline_access Mail.Send). On consent, Microsoft
 * sends the admin back to /api/outreach/graph/callback with an auth code.
 *
 * State is a random nonce stored in a single-use cookie; the callback
 * verifies it.
 */
import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@clerk/nextjs/server'
import crypto from 'crypto'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { buildConsentUrl } from '@/lib/email/graph-auth'

export async function GET(req: NextRequest) {
  const { userId } = await auth()
  if (!userId) {
    return NextResponse.redirect(new URL('/sign-in', req.url))
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

  const base = process.env.PUBLIC_BASE_URL ?? req.nextUrl.origin
  const redirectUri = `${base}/api/outreach/graph/callback`
  const state = crypto.randomBytes(16).toString('base64url')
  const url = buildConsentUrl(redirectUri, state)

  const res = NextResponse.redirect(url)
  res.cookies.set('graph_oauth_state', state, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: 600,
    path: '/',
  })
  return res
}
