import { randomBytes } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'

export type TokenAction = 'approve' | 'decline'

export const TOKEN_TTL_HOURS = 24

export async function mintActionToken(
  supabase: SupabaseClient,
  args: { runId: string; action: TokenAction; ttlHours?: number },
): Promise<string> {
  const token = randomBytes(32).toString('base64url')
  const ttl = (args.ttlHours ?? TOKEN_TTL_HOURS) * 60 * 60 * 1000
  const expiresAt = new Date(Date.now() + ttl).toISOString()
  const { error } = await supabase.from('outreach_action_token').insert({
    token,
    run_id: args.runId,
    action: args.action,
    expires_at: expiresAt,
  })
  if (error) throw new Error(`mintActionToken failed: ${error.message}`)
  return token
}

export type TokenValidation =
  | { ok: true; runId: string; action: TokenAction }
  | { ok: false; reason: 'missing' | 'used' | 'expired' }

export async function validateAndConsumeActionToken(
  supabase: SupabaseClient,
  args: { token: string; ip?: string | null },
): Promise<TokenValidation> {
  const { data, error } = await supabase
    .from('outreach_action_token')
    .select('token, run_id, action, expires_at, used_at')
    .eq('token', args.token)
    .maybeSingle()
  if (error || !data) return { ok: false, reason: 'missing' }
  if (data.used_at) return { ok: false, reason: 'used' }
  if (new Date(data.expires_at).getTime() < Date.now())
    return { ok: false, reason: 'expired' }

  // Atomic-ish consume: only flip used_at if it's still null. If someone
  // races us, the conditional update returns zero rows and we report 'used'.
  const { data: claimed, error: claimErr } = await supabase
    .from('outreach_action_token')
    .update({ used_at: new Date().toISOString(), used_from_ip: args.ip ?? null })
    .eq('token', args.token)
    .is('used_at', null)
    .select('run_id, action')
    .maybeSingle()
  if (claimErr || !claimed) return { ok: false, reason: 'used' }
  return { ok: true, runId: claimed.run_id, action: claimed.action as TokenAction }
}
