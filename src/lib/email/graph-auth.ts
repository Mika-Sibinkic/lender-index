/**
 * Microsoft Graph delegated OAuth — refresh-token flow.
 *
 * Replaces the GRAPH_DELEGATED_TOKEN env-var stub once the principal inbox owner
 * has granted consent to the Azure AD app once via /api/outreach/graph/install.
 *
 * Stores the refresh token in `public.graph_token` (one row, singleton).
 * Each call to `getDelegatedToken()` exchanges the refresh token for a
 * fresh access token, persisting any rotated refresh token back to the
 * row. Access token cached in-process for `expires_in - 60s`.
 *
 * Required env:
 *   AZURE_TENANT_ID   — the principal's tenant guid (or "common" if multi-tenant)
 *   AZURE_CLIENT_ID   — the app registration's Application (client) ID
 *   AZURE_CLIENT_SECRET — client secret (confidential client)
 *   GRAPH_SCOPES      — default: "offline_access Mail.Send"
 *
 * No env needed for the refresh token itself; it's loaded from Postgres.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { getSupabaseAdmin } from '@/lib/supabase/admin'

interface CachedToken {
  accessToken: string
  expiresAt: number // ms epoch
}

let cached: CachedToken | null = null

function tokenEndpoint(): string {
  const tenant = process.env.AZURE_TENANT_ID ?? 'common'
  return `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`
}

interface TokenResponse {
  access_token: string
  refresh_token?: string
  expires_in: number
  token_type: string
  scope?: string
  error?: string
  error_description?: string
}

/**
 * Exchange a refresh token for a fresh access token.
 * Rotates the refresh token if Microsoft returns a new one.
 */
async function refreshAccessToken(
  supabase: SupabaseClient,
  refreshToken: string,
): Promise<CachedToken> {
  const clientId = process.env.AZURE_CLIENT_ID
  const clientSecret = process.env.AZURE_CLIENT_SECRET
  const scopes = process.env.GRAPH_SCOPES ?? 'offline_access Mail.Send'
  if (!clientId || !clientSecret) {
    throw new Error('AZURE_CLIENT_ID / AZURE_CLIENT_SECRET not set')
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
    scope: scopes,
  })

  const res = await fetch(tokenEndpoint(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  const json = (await res.json()) as TokenResponse
  if (!res.ok || !json.access_token) {
    throw new Error(
      `Graph token refresh failed: ${json.error ?? res.status} ${json.error_description ?? ''}`,
    )
  }

  // Persist rotated refresh token if Microsoft returned a new one.
  if (json.refresh_token && json.refresh_token !== refreshToken) {
    await supabase
      .from('graph_token')
      .update({
        refresh_token: json.refresh_token,
        last_refreshed_at: new Date().toISOString(),
      })
      .eq('id', 1)
  } else {
    await supabase
      .from('graph_token')
      .update({ last_refreshed_at: new Date().toISOString() })
      .eq('id', 1)
  }

  return {
    accessToken: json.access_token,
    // refresh 60s before actual expiry to avoid clock skew
    expiresAt: Date.now() + (json.expires_in - 60) * 1000,
  }
}

/**
 * Get a valid Graph access token. Cached in-process; refreshed when
 * within 60s of expiry. Reads the refresh token from
 * public.graph_token (singleton row, id=1).
 */
export async function getDelegatedToken(): Promise<string> {
  if (cached && cached.expiresAt > Date.now()) {
    return cached.accessToken
  }

  const supabase = getSupabaseAdmin()
  const { data, error } = await supabase
    .from('graph_token')
    .select('refresh_token')
    .eq('id', 1)
    .single()
  if (error || !data?.refresh_token) {
    throw new Error(
      'No refresh token in public.graph_token. The principal inbox owner needs to consent via /api/outreach/graph/install first.',
    )
  }

  cached = await refreshAccessToken(supabase, data.refresh_token)
  return cached.accessToken
}

/**
 * Exchange an authorization code (from the /install OAuth callback) for
 * an initial token pair, and store the refresh token. Called by
 * /api/outreach/graph/callback after the principal inbox owner consents in the browser.
 */
export async function exchangeAuthCodeForToken(
  code: string,
  redirectUri: string,
): Promise<void> {
  const clientId = process.env.AZURE_CLIENT_ID
  const clientSecret = process.env.AZURE_CLIENT_SECRET
  const scopes = process.env.GRAPH_SCOPES ?? 'offline_access Mail.Send'
  if (!clientId || !clientSecret) {
    throw new Error('AZURE_CLIENT_ID / AZURE_CLIENT_SECRET not set')
  }

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    client_secret: clientSecret,
    scope: scopes,
  })
  const res = await fetch(tokenEndpoint(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  const json = (await res.json()) as TokenResponse
  if (!res.ok || !json.refresh_token) {
    throw new Error(
      `Graph code-exchange failed: ${json.error ?? res.status} ${json.error_description ?? ''}`,
    )
  }
  const supabase = getSupabaseAdmin()
  await supabase.from('graph_token').upsert(
    {
      id: 1,
      refresh_token: json.refresh_token,
      last_refreshed_at: new Date().toISOString(),
    },
    { onConflict: 'id' },
  )
  cached = {
    accessToken: json.access_token,
    expiresAt: Date.now() + (json.expires_in - 60) * 1000,
  }
}

/**
 * Build the consent URL the principal inbox owner clicks in a browser the first time.
 */
export function buildConsentUrl(redirectUri: string, state: string): string {
  const tenant = process.env.AZURE_TENANT_ID ?? 'common'
  const clientId = process.env.AZURE_CLIENT_ID
  const scopes = process.env.GRAPH_SCOPES ?? 'offline_access Mail.Send'
  if (!clientId) throw new Error('AZURE_CLIENT_ID not set')
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    response_mode: 'query',
    scope: scopes,
    state,
  })
  return `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize?${params}`
}

/** Drop in-process token cache (testing / forced refresh). */
export function _resetTokenCache(): void {
  cached = null
}
