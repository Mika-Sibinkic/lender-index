import { auth, currentUser } from '@clerk/nextjs/server'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { isAuthorizedEmail } from '@/lib/auth/authorized'

export async function syncCurrentUser() {
  const { userId } = await auth()
  if (!userId) return null
  const user = await currentUser()
  if (!user) return null

  const email = user.emailAddresses[0]?.emailAddress
  if (!email) return null

  const admin = getSupabaseAdmin()

  // Assign a role ONLY on first insert — never rewrite it on repeat sign-ins.
  // First-time authorized (whitelisted) users become 'editor' so they can
  // actually write (the email whitelist is the real security gate, not the role
  // tier); non-authorized accounts stay 'viewer'. Omitting role from the upsert
  // payload for existing rows means an admin's deliberate role change (e.g.
  // demoting one user to 'viewer') sticks across logins.
  const { data: existing } = await admin
    .from('users')
    .select('role')
    .eq('clerk_user_id', userId)
    .maybeSingle()

  const base = { clerk_user_id: userId, email, last_seen_at: new Date().toISOString() }
  const payload = existing
    ? base
    : { ...base, role: isAuthorizedEmail(email) ? 'editor' : 'viewer' }

  const { data, error } = await admin
    .from('users')
    .upsert(payload, { onConflict: 'clerk_user_id' })
    .select()
    .single()
  if (error) {
    console.error('syncCurrentUser failed', error)
    return null
  }
  return data
}
