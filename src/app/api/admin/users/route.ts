import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireAuthorizedApiUser } from '@/lib/auth/require-authorized'
import { getSupabaseAdmin } from '@/lib/supabase/admin'

export const dynamic = 'force-dynamic'

const ROLES = ['admin', 'editor', 'viewer'] as const

const patchSchema = z.object({
  user_id: z.string().uuid(),
  role: z.enum(ROLES),
})

/**
 * Resolve the caller's own users-row (id + role) via the admin client — the same
 * role gate funding-sources/route.ts applies. Returns null if not synced yet.
 */
async function callerRow(clerkUserId: string) {
  const admin = getSupabaseAdmin()
  const { data } = await admin
    .from('users')
    .select('id,role')
    .eq('clerk_user_id', clerkUserId)
    .single()
  return data
}

// GET — list users for the admin console.
export async function GET() {
  const authz = await requireAuthorizedApiUser()
  if (!authz.ok) return authz.response

  const caller = await callerRow(authz.userId)
  if (!caller || caller.role !== 'admin') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const admin = getSupabaseAdmin()
  const { data, error } = await admin
    .from('users')
    .select('id,email,role,last_seen_at')
    .order('email', { ascending: true })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ users: data ?? [] })
}

// PATCH — change a user's role. Admin-only; cannot self-demote (lockout guard).
export async function PATCH(req: NextRequest) {
  const authz = await requireAuthorizedApiUser()
  if (!authz.ok) return authz.response

  const caller = await callerRow(authz.userId)
  if (!caller || caller.role !== 'admin') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const body = await req.json().catch(() => null)
  const parsed = patchSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  }
  const { user_id, role } = parsed.data

  // Lockout guard: an admin may not strip their own admin role.
  if (user_id === caller.id && role !== 'admin') {
    return NextResponse.json(
      { error: 'You cannot remove your own admin role.' },
      { status: 400 }
    )
  }

  const admin = getSupabaseAdmin()
  const { data, error } = await admin
    .from('users')
    .update({ role })
    .eq('id', user_id)
    .select('id,email,role,last_seen_at')
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data) return NextResponse.json({ error: 'not found' }, { status: 404 })

  return NextResponse.json(data)
}
